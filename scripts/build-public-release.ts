import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  assertSafeReleaseEnvironment,
  releaseCommandEnvironment,
} from "./release-environment";
import { sha256DirectoryTree } from "./release-inputs";

const BUN_VERSION = "1.3.14";

export const PUBLIC_RELEASE_COMMANDS = [
  { args: ["run", "prepare:native-release"], phase: "release-preparation" },
  { args: ["run", "prepare:semantic-release"], phase: "release-preparation" },
  { args: ["run", "typecheck"], phase: "quality" },
  { args: ["run", "test"], phase: "quality" },
  { args: ["run", "test:quality"], phase: "quality" },
  { args: ["run", "audit"], phase: "quality" },
  { args: ["run", "test:package"], phase: "quality" },
  { args: ["run", "test:semantic-release"], phase: "quality" },
] as const;

if (import.meta.main) buildPublicRelease();

function buildPublicRelease(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Public releases require Apple Silicon macOS");
  }
  if (process.versions.bun !== BUN_VERSION) {
    throw new Error(`Public releases require Bun ${BUN_VERSION}`);
  }
  assertSafeReleaseEnvironment(process.env);

  const repositoryRoot = resolve(process.cwd());
  const sourceCommit = git(["rev-parse", "HEAD"], repositoryRoot).trim();
  const sourceTree = git(["rev-parse", "HEAD^{tree}"], repositoryRoot).trim();
  requireCleanSource(repositoryRoot);

  const temporaryRoot = mkdtempSync(join(tmpdir(), "afternote-public-release-"));
  const stagedRepository = join(temporaryRoot, "source");
  let worktreeCreated = false;
  try {
    git(["worktree", "add", "--detach", stagedRepository, sourceCommit], repositoryRoot);
    worktreeCreated = true;
    requireCleanSource(stagedRepository);
    const qualityEnvironment = releaseCommandEnvironment({}, {
      AFTERNOTE_RELEASE_BUILD: undefined,
      AFTERNOTE_RELEASE_DEPENDENCY_TREE_SHA256: undefined,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    });
    runBun(
      ["install", "--frozen-lockfile", "--ignore-scripts", "--no-cache"],
      stagedRepository,
      qualityEnvironment,
    );
    const dependencyTreeSha256 = sha256DirectoryTree(join(stagedRepository, "node_modules"));
    const preparationEnvironment = releaseCommandEnvironment({}, {
      AFTERNOTE_RELEASE_BUILD: "1",
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
    });

    for (const command of PUBLIC_RELEASE_COMMANDS) {
      runBun(
        [...command.args],
        stagedRepository,
        command.phase === "release-preparation"
          ? preparationEnvironment
          : qualityEnvironment,
      );
    }

    const releaseEnvironment = releaseCommandEnvironment(process.env, {
      AFTERNOTE_RELEASE_BUILD: "1",
      AFTERNOTE_RELEASE_DEPENDENCY_TREE_SHA256: dependencyTreeSha256,
    });
    runBun(["run", "package:local"], stagedRepository, releaseEnvironment);
    requireCleanSource(stagedRepository);
    requireSourceIdentity(stagedRepository, sourceCommit, sourceTree);
    if (sha256DirectoryTree(join(stagedRepository, "node_modules")) !== dependencyTreeSha256) {
      throw new Error("Installed dependencies changed during public release construction");
    }
    runBun(["run", "finalize:release"], stagedRepository, releaseEnvironment);
    requireCleanSource(stagedRepository);
    requireSourceIdentity(stagedRepository, sourceCommit, sourceTree);

    publishLocally(stagedRepository, repositoryRoot);
  } finally {
    if (worktreeCreated) {
      git(["worktree", "remove", "--force", stagedRepository], repositoryRoot, false);
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function publishLocally(stagedRepository: string, repositoryRoot: string): void {
  const source = join(stagedRepository, "build/local-alpha");
  const report = JSON.parse(readFileSync(
    join(source, "release-finalization-report.json"),
    "utf8",
  )) as { finalDmg?: unknown; checksums?: unknown; appcast?: unknown };
  if (typeof report.finalDmg !== "string" || typeof report.checksums !== "string" ||
    typeof report.appcast !== "string") {
    throw new Error("Final public release report is incomplete");
  }
  const inputs = [
    report.finalDmg,
    report.appcast,
    report.checksums,
    join(source, "release-finalization-report.json"),
  ];
  for (const input of inputs) {
    const info = lstatSync(input);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Public release output is not a regular file: ${input}`);
    }
  }
  const output = join(repositoryRoot, "build/public-release");
  const stagedOutput = `${output}.staging-${process.pid}`;
  rmSync(stagedOutput, { recursive: true, force: true });
  mkdirSync(stagedOutput, { recursive: true, mode: 0o700 });
  try {
    for (const input of inputs) copyFileSync(input, join(stagedOutput, basename(input)));
    rmSync(output, { recursive: true, force: true });
    renameSync(stagedOutput, output);
  } finally {
    rmSync(stagedOutput, { recursive: true, force: true });
  }
  console.log(`Public release candidate written to ${output}`);
}

function requireCleanSource(repositoryRoot: string): void {
  if (git(["status", "--porcelain", "--untracked-files=all"], repositoryRoot).trim()) {
    throw new Error("Public release construction requires a clean source tree");
  }
}

function requireSourceIdentity(repositoryRoot: string, commit: string, tree: string): void {
  if (git(["rev-parse", "HEAD"], repositoryRoot).trim() !== commit ||
    git(["rev-parse", "HEAD^{tree}"], repositoryRoot).trim() !== tree) {
    throw new Error("Public release source identity changed during construction");
  }
}

function runBun(
  args: string[],
  cwd: string,
  environment = releaseCommandEnvironment(process.env),
): void {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`Public release command failed: bun ${args.join(" ")}`);
}

function git(args: string[], cwd: string, required = true): string {
  if (!existsSync(cwd)) {
    if (required) throw new Error(`Release Git directory does not exist: ${cwd}`);
    return "";
  }
  const result = Bun.spawnSync(["/usr/bin/git", ...args], {
    cwd,
    env: releaseCommandEnvironment(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 && required) {
    throw new Error(`Release Git command failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}
