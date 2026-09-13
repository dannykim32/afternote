import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

const temporaryDirectories: string[] = [];
const describeOnMac = process.platform === "darwin" ? describe : describe.skip;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describeOnMac("native process-chain code-signing authorization", () => {
  it("accepts exact two- and three-level signed chains and rejects a wrong ancestor", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-process-chain-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "launcher.c");
    const unsignedLauncher = join(directory, "launcher");
    const parent = join(directory, "parent-launcher");
    const grandparent = join(directory, "grandparent-launcher");
    const greatGrandparent = join(directory, "great-grandparent-launcher");
    writeFileSync(source, `
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
int main(int argc, char **argv) {
  if (argc < 2) return 64;
  pid_t child = 0;
  int status = 0;
  if (posix_spawn(&child, argv[1], 0, 0, &argv[1], environ) != 0) return 70;
  if (waitpid(child, &status, 0) < 0) return 71;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 72;
}
`);
    expect(Bun.spawnSync([
      "/usr/bin/clang",
      source,
      "-o",
      unsignedLauncher,
    ]).exitCode).toBe(0);
    copyFileSync(unsignedLauncher, parent);
    copyFileSync(unsignedLauncher, grandparent);
    copyFileSync(unsignedLauncher, greatGrandparent);
    chmodSync(parent, 0o755);
    chmodSync(grandparent, 0o755);
    chmodSync(greatGrandparent, 0o755);
    signFixture(parent, "dev.afternote.test.parent-launcher");
    signFixture(grandparent, "dev.afternote.test.grandparent-launcher");
    signFixture(
      greatGrandparent,
      "dev.afternote.test.great-grandparent-launcher",
    );
    const parentRequirement = designatedRequirement(parent);
    const grandparentRequirement = designatedRequirement(grandparent);
    const greatGrandparentRequirement = designatedRequirement(greatGrandparent);

    const twoLevelAccepted = runProbe(
      [grandparent, parent],
      [parentRequirement, grandparentRequirement],
    );
    expect(
      twoLevelAccepted.exitCode,
      twoLevelAccepted.stderr?.toString() ?? "",
    ).toBe(0);
    expect(twoLevelAccepted.stdout?.toString()).toBe("verified\n");

    const threeLevelAccepted = runProbe(
      [greatGrandparent, grandparent, parent],
      [
        parentRequirement,
        grandparentRequirement,
        greatGrandparentRequirement,
      ],
    );
    expect(
      threeLevelAccepted.exitCode,
      threeLevelAccepted.stderr?.toString() ?? "",
    ).toBe(0);
    expect(threeLevelAccepted.stdout?.toString()).toBe("verified\n");

    const rejected = runProbe(
      [greatGrandparent, grandparent, parent],
      [parentRequirement, grandparentRequirement, parentRequirement],
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr?.toString()).toContain(
      "Ancestor process does not satisfy the required code signature",
    );
  });
});

function signFixture(path: string, identifier: string): void {
  const result = Bun.spawnSync([
    "/usr/bin/codesign",
    "--force",
    "--sign",
    "-",
    "--identifier",
    identifier,
    path,
  ], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function designatedRequirement(path: string): string {
  const result = Bun.spawnSync([
    "/usr/bin/codesign",
    "-d",
    "-r-",
    path,
  ], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const requirement = `${result.stdout.toString()}\n${result.stderr.toString()}`
    .match(/(?:# )?designated => (.+)/)?.[1];
  if (!requirement) throw new Error(`Could not read code requirement for ${path}`);
  return requirement.trim();
}

function runProbe(
  launchersFromOutermostToParent: string[],
  requirementsFromParentToOutermost: string[],
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([
    ...launchersFromOutermostToParent,
    process.execPath,
    "run",
    join(import.meta.dir, "process-chain-code-signing-probe-main.ts"),
  ], {
    env: {
      ...process.env,
      AFTERNOTE_TEST_ANCESTOR_CODE_REQUIREMENTS: JSON.stringify(
        requirementsFromParentToOutermost,
      ),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}
