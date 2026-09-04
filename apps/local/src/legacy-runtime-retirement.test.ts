import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { assertLegacyRuntimeRetired } from "./legacy-runtime-retirement";
import { ExclusiveFileLock } from "./sqlcipher-database";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("legacy runtime retirement proof", () => {
  it("rejects dangling runtime artifacts", () => {
    const fixture = retirementFixture("dangling");
    symlinkSync(join(fixture.directory, "missing"), join(fixture.runtimePath, "runtime.token"));

    expect(() => assertLegacyRuntimeRetired(fixture, () => ({ release() {} }))).toThrow(
      "Legacy Afternote runtime state remains",
    );
  });

  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "rejects an old runtime that still owns the canonical vault lock",
    () => {
      const fixture = retirementFixture("locked");
      const lockPath = join(fixture.vaultDirectory, ".vault.db.afternote.lock");
      const lock = new ExclusiveFileLock(lockPath);
      try {
        expect(() => assertLegacyRuntimeRetired(fixture)).toThrow(
          "Legacy Afternote runtime still owns the vault lifecycle lock",
        );
      } finally {
        lock.release();
      }
    },
  );
});

function retirementFixture(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `afternote-retirement-${name}-`));
  temporaryDirectories.push(directory);
  const runtimePath = join(directory, "runtime");
  const vaultDirectory = join(directory, "vault");
  mkdirSync(runtimePath, { recursive: true, mode: 0o700 });
  mkdirSync(vaultDirectory, { recursive: true, mode: 0o700 });
  return {
    directory,
    runtimePath,
    vaultDirectory,
    vaultPath: join(vaultDirectory, "vault.db"),
  };
}
