import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { VaultContext } from "@afternote/memory";
import { SqliteMemory } from "./sqlite-memory";

const vault: VaultContext = { vaultId: "e".repeat(64), deployment: "local" };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("encrypted SqliteMemory", () => {
  it("preserves notes, revisions, FTS, citations, and encrypted restore without readable sidecars", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "vault.db");
    const exportPath = join(directory, "vault.afternote.json");
    const restoredPath = join(directory, "restored.db");
    const key = randomBytes(32);
    const canary = "SQLCIPHER_MEMORY_CANARY_9a0db5f8";
    const sourceCanary = "SQLCIPHER_SOURCE_CANARY_4bf31f";
    const memory = new SqliteMemory(databasePath, vault, { encryptionKey: key });
    const original = await memory.remember(vault, {
      content: `${canary} original`,
      source: {
        application: "Team Chat",
        label: sourceCanary,
        url: `https://example.invalid/${sourceCanary}`,
      },
    });
    const updated = await memory.updateNote(vault, original.id, {
      expectedRevision: 1,
      content: `${canary} current`,
    });
    expect(updated.revision).toBe(2);
    expect((await memory.recall(vault, "SQLCIPHER MEMORY CANARY"))[0])
      .toMatchObject({
        note: { id: original.id, revision: 2 },
        citation: { noteId: original.id, revision: 2 },
      });
    expect((await memory.listNoteRevisions(vault, original.id)).revisions)
      .toMatchObject([{ revision: 2 }, { revision: 1 }]);
    memory.exportInterchange(vault, exportPath, "2.0.0-alpha.2");
    memory.close();

    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from(canary))).toBe(false);
    expect(readFileSync(databasePath).includes(Buffer.from(sourceCanary))).toBe(false);
    const rawSqlite = Bun.spawnSync(
      ["/usr/bin/sqlite3", "-readonly", databasePath, ".tables"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(rawSqlite.exitCode).not.toBe(0);
    expect(`${rawSqlite.stdout}${rawSqlite.stderr}`).not.toContain("notes_fts");
    expect(`${rawSqlite.stdout}${rawSqlite.stderr}`).not.toContain(sourceCanary);
    const raw = new Database(databasePath, { readonly: true });
    expect(() => raw.query("select name from sqlite_schema").all()).toThrow();
    raw.close();
    expect(() =>
      new SqliteMemory(databasePath, vault, { encryptionKey: randomBytes(32) }),
    ).toThrow();

    SqliteMemory.restoreInterchange(
      exportPath,
      restoredPath,
      vault,
      "2.0.0-alpha.2",
      { encryptionKey: key },
    );
    const restored = new SqliteMemory(restoredPath, vault, { encryptionKey: key });
    expect(await restored.getNote(vault, original.id)).toMatchObject({
      content: `${canary} current`,
      revision: 2,
    });
    restored.close();
    expect(readFileSync(restoredPath).includes(Buffer.from(canary))).toBe(false);
    expect(readFileSync(restoredPath).includes(Buffer.from(sourceCanary))).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "afternote-encrypted-memory-"));
  directories.push(directory);
  return directory;
}
