import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  developmentVaultKeySnapshot,
  developmentVaultKeyPath,
  getOrCreateDevelopmentVaultKey,
  readDevelopmentVaultKey,
} from "./development-vault-key";

describe("development vault key", () => {
  it("persists one owner-only key across development rebuilds", () => {
    const home = mkdtempSync(join(tmpdir(), "afternote-development-key-"));
    const path = developmentVaultKeyPath(home);
    const first = getOrCreateDevelopmentVaultKey(path);
    const second = getOrCreateDevelopmentVaultKey(path);

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    expect([...readFileSync(path)]).toEqual([...first]);
    first.fill(0);
    second.fill(0);
  });

  it("reads and fingerprints only the canonical owner-only key file for reviewed release enrollment", () => {
    const home = mkdtempSync(join(tmpdir(), "afternote-development-key-"));
    const path = developmentVaultKeyPath(home);
    const created = getOrCreateDevelopmentVaultKey(path);
    const read = readDevelopmentVaultKey(path);
    const snapshot = developmentVaultKeySnapshot(path);

    expect(read).toEqual(created);
    expect(snapshot).toMatchObject({
      bytes: 32,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      inode: expect.any(Number),
    });
    expect(JSON.stringify(snapshot)).not.toContain(Buffer.from(created).toString("hex"));
    created.fill(0);
    read.fill(0);
  });

  it("rejects a development key that another local account could read", () => {
    const home = mkdtempSync(join(tmpdir(), "afternote-development-key-"));
    const path = developmentVaultKeyPath(home);
    getOrCreateDevelopmentVaultKey(path).fill(0);
    chmodSync(path, 0o644);

    expect(() => getOrCreateDevelopmentVaultKey(path)).toThrow(
      "permissions are too broad",
    );
  });

  it("refuses a symlinked development key", () => {
    const home = mkdtempSync(join(tmpdir(), "afternote-development-key-"));
    const path = developmentVaultKeyPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    symlinkSync(join(home, "elsewhere"), path);

    expect(() => getOrCreateDevelopmentVaultKey(path)).toThrow(
      "not a regular file",
    );
  });
});
