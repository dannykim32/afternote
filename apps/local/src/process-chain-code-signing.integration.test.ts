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
  it("accepts the exact parent and grandparent and rejects the wrong grandparent", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-process-chain-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "launcher.c");
    const unsignedLauncher = join(directory, "launcher");
    const parent = join(directory, "parent-launcher");
    const grandparent = join(directory, "grandparent-launcher");
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
    chmodSync(parent, 0o755);
    chmodSync(grandparent, 0o755);
    signFixture(parent, "dev.afternote.test.parent-launcher");
    signFixture(grandparent, "dev.afternote.test.grandparent-launcher");
    const parentRequirement = designatedRequirement(parent);
    const grandparentRequirement = designatedRequirement(grandparent);

    const accepted = runProbe(
      grandparent,
      parent,
      parentRequirement,
      grandparentRequirement,
    );
    expect(accepted.exitCode, accepted.stderr?.toString() ?? "").toBe(0);
    expect(accepted.stdout?.toString()).toBe("verified\n");

    const rejected = runProbe(
      grandparent,
      parent,
      parentRequirement,
      parentRequirement,
    );
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr?.toString()).toContain(
      "Grandparent process does not satisfy the required code signature",
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
  grandparent: string,
  parent: string,
  parentRequirement: string,
  grandparentRequirement: string,
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([
    grandparent,
    parent,
    process.execPath,
    "run",
    join(import.meta.dir, "process-chain-code-signing-probe-main.ts"),
  ], {
    env: {
      ...process.env,
      AFTERNOTE_TEST_PARENT_CODE_REQUIREMENT: parentRequirement,
      AFTERNOTE_TEST_GRANDPARENT_CODE_REQUIREMENT: grandparentRequirement,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}
