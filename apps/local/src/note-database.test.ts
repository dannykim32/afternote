import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { migrateNoteSchema, openNoteDatabase } from "./note-database";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "afternote-note-schema-"));
  directories.push(directory);
  return { directory, path: join(directory, "vault.db") };
}

for (const encrypted of [false, true]) {
  describe(`Note schema through ${encrypted ? "SQLCipher" : "SQLite"} adapter`, () => {
    it("initializes idempotently without backing up an empty or current schema", () => {
      const { directory, path } = fixture();
      const key = encrypted ? randomBytes(32) : undefined;
      const database = openNoteDatabase(path, key, { create: true });
      try {
        migrateNoteSchema(database, path, key);
        const before = database.query("select name, sql from sqlite_schema order by name").all();
        migrateNoteSchema(database, path, key);
        expect(database.query("pragma user_version").get()).toEqual({ user_version: 11 });
        expect(database.query("select name, sql from sqlite_schema order by name").all()).toEqual(before);
        expect(readdirSync(directory).filter((name) => name.includes("pre-migration"))).toEqual([]);
        // The caller can still use its connection: migration never takes ownership.
        expect(database.query("pragma quick_check").get()).toEqual({ quick_check: "ok" });
      } finally {
        database.close();
      }
    });

    it("verifies a private backup before upgrading and preserves encryption", () => {
      const { directory, path } = fixture();
      const key = encrypted ? randomBytes(32) : undefined;
      const database = openNoteDatabase(path, key, { create: true });
      const canary = "SCHEMA_BACKUP_PRIVATE_CANARY_732";
      try {
        migrateNoteSchema(database, path, key);
        database.query(`insert into notes
          (id, content, current_revision, source_json, created_at, updated_at)
          values (?, ?, 1, ?, ?, ?)`).run(
          "note-1", canary, JSON.stringify({ timestamp: "2026-09-13T12:00:00.000Z" }),
          "2026-09-13T12:00:00.000Z", "2026-09-13T12:00:00.000Z",
        );
        database.exec("pragma user_version = 9");
        migrateNoteSchema(database, path, key);
        expect(database.query("pragma user_version").get()).toEqual({ user_version: 11 });
        expect(database.query("select content from notes").get()).toEqual({ content: canary });
        const backups = readdirSync(directory).filter((name) => name.includes("pre-migration-v9-"));
        expect(backups).toHaveLength(1);
        const backupPath = join(directory, backups[0]!);
        expect(statSync(backupPath).mode & 0o077).toBe(0);
        const backup = openNoteDatabase(backupPath, key, { readonly: true });
        try {
          expect(backup.query("pragma user_version").get()).toEqual({ user_version: 9 });
          expect(backup.query("pragma quick_check").get()).toEqual({ quick_check: "ok" });
          expect(backup.query("select content from notes").get()).toEqual({ content: canary });
        } finally {
          backup.close();
        }
        if (encrypted) expect(readFileSync(backupPath).includes(Buffer.from(canary))).toBe(false);
        expect(readdirSync(directory).some((name) => name.startsWith(".afternote-migration-"))).toBe(false);
      } finally {
        database.close();
      }
    });

    it("rejects future schemas without modifying them or creating a backup", () => {
      const { directory, path } = fixture();
      const key = encrypted ? randomBytes(32) : undefined;
      const database = openNoteDatabase(path, key, { create: true });
      try {
        database.exec("pragma user_version = 12");
        expect(() => migrateNoteSchema(database, path, key)).toThrow("newer schema version 12");
        expect(database.query("pragma user_version").get()).toEqual({ user_version: 12 });
        expect(readdirSync(directory).filter((name) => name.includes("pre-migration"))).toEqual([]);
      } finally {
        database.close();
      }
    });

    it("rolls back a failed version and leaves a verified pre-migration backup", () => {
      const { directory, path } = fixture();
      const key = encrypted ? randomBytes(32) : undefined;
      const database = openNoteDatabase(path, key, { create: true });
      try {
        // Deliberately missing source_json: migration 2 fails after its ALTER TABLE.
        database.exec(`create table notes (
          id text primary key, content text, created_at text, updated_at text
        ); pragma user_version = 1;`);
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(() => migrateNoteSchema(database, path, key)).toThrow();
          expect(database.query("pragma user_version").get()).toEqual({ user_version: 1 });
          expect(database.query<{ name: string }, []>("pragma table_info(notes)").all()
            .some(({ name }) => name === "current_revision")).toBe(false);
        }
        const backups = readdirSync(directory).filter((name) => name.includes("pre-migration-v1-"));
        expect(backups.length).toBeGreaterThan(0);
        // Plain SQLite snapshots are byte-stable. Encrypted snapshots may use fresh salts.
        if (!encrypted) expect(backups).toHaveLength(1);
        for (const name of backups) {
          const backup = openNoteDatabase(join(directory, name), key, { readonly: true });
          try {
            expect(backup.query("pragma quick_check").get()).toEqual({ quick_check: "ok" });
            expect(backup.query("pragma user_version").get()).toEqual({ user_version: 1 });
          } finally {
            backup.close();
          }
        }
      } finally {
        database.close();
      }
    });
  });
}
