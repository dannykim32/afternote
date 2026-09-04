import { createHash, randomBytes, randomUUID, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  atomicExchangeFiles,
  createDataProtectionKeychainVaultKey,
  deleteKeychainVaultKeyForTest,
  deleteDevelopmentClientKeyForTest,
  enrollDataProtectionKeychainVaultKey,
  getOrCreateKeychainVaultKey,
  isDevelopmentClientIdentityUnavailable,
  openDurableClientSigner,
  readDataProtectionKeychainVaultKey,
  SqlcipherDatabase,
} from "./sqlcipher-database";

const directories: string[] = [];
const hostKeychainIt = process.env.AFTERNOTE_TEST_HOST_KEYCHAIN === "1" ? it : it.skip;

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqlcipherDatabase", () => {
  it("supports the synchronous query and transaction contract over encrypted FTS5 storage", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "vault.db");
    const key = randomBytes(32);
    const database = new SqlcipherDatabase(path, { key });
    database.exec(`
      create table notes (
        rowid integer primary key autoincrement,
        id text not null unique,
        content text not null,
        vector blob
      );
      create virtual table notes_fts using fts5(
        content, content = 'notes', content_rowid = 'rowid'
      );
      create trigger notes_fts_insert after insert on notes begin
        insert into notes_fts(rowid, content) values (new.rowid, new.content);
      end;
    `);

    const insert = database.query(
      "insert into notes (id, content, vector) values (?, ?, ?)",
    );
    expect(insert.run("first", "encrypted canary", new Uint8Array([1, 2, 3])).changes)
      .toBe(1);
    expect(insert.run("empty", "zero-byte vector", new Uint8Array()).changes).toBe(1);
    expect(() =>
      database.transaction(() => {
        insert.run("rolled-back", "must not survive", null);
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");

    expect(
      database.query<{ id: string; vector: Uint8Array }, [string]>(
        "select id, vector from notes where id = ?",
      ).get("first"),
    ).toEqual({ id: "first", vector: new Uint8Array([1, 2, 3]) });
    expect(
      database.query<{ kind: string; bytes: number }, [string]>(
        "select typeof(vector) as kind, length(vector) as bytes from notes where id = ?",
      ).get("empty"),
    ).toEqual({ kind: "blob", bytes: 0 });
    expect(
      database.query<{ id: string }, [string]>(
        "select notes.id from notes_fts join notes on notes.rowid = notes_fts.rowid where notes_fts match ?",
      ).all("canary"),
    ).toEqual([{ id: "first" }]);
    expect([...database.query<{ id: string }, []>("select id from notes order by id").iterate()])
      .toEqual([{ id: "empty" }, { id: "first" }]);
    expect(database.query<{ count: number }, []>("select count(*) as count from notes").get())
      .toEqual({ count: 2 });
    const retained = database.query<{ id: string }, []>("select id from notes");
    database.close();
    expect(() => retained.get()).toThrow("statement is closed");

    expect(() => new SqlcipherDatabase(path, { key: randomBytes(32), readonly: true }))
      .toThrow();
  });

  it("interrupts bounded query work at a progress deadline and restores normal reads", async () => {
    const directory = temporaryDirectory();
    const database = new SqlcipherDatabase(join(directory, "deadline.db"), {
      key: randomBytes(32),
    });
    await expect(database.withProgressDeadline(1, () =>
      database.query<{ total: number }, []>(`
        with recursive work(value) as (
          values(1)
          union all
          select value + 1 from work where value < 100000000
        )
        select sum(value) as total from work
      `).get()
    )).rejects.toThrow(/interrupted/i);
    expect(database.query<{ value: number }, []>("select 1 as value").get())
      .toEqual({ value: 1 });
    database.close();
  });

  it("imports plaintext and restores an encrypted online backup into a clean database", () => {
    const directory = temporaryDirectory();
    const plaintextPath = join(directory, "plaintext.db");
    const encryptedPath = join(directory, "encrypted.db");
    const backupPath = join(directory, "backup.db");
    const restoredPath = join(directory, "restored.db");
    const key = randomBytes(32);
    const plaintext = new Database(plaintextPath, { create: true });
    plaintext.exec(`
      create table notes (id text primary key, content text not null);
      insert into notes values ('one', 'migration canary');
      pragma user_version = 8;
    `);
    plaintext.close();

    const encrypted = new SqlcipherDatabase(encryptedPath, { key });
    encrypted.importPlaintext(plaintextPath, 8);
    expect(encrypted.query<{ content: string }, []>("select content from notes").get())
      .toEqual({ content: "migration canary" });
    const backup = new SqlcipherDatabase(backupPath, { key });
    encrypted.backupTo(backup);
    backup.close();
    encrypted.close();

    const backupSource = new SqlcipherDatabase(backupPath, { key, readonly: true });
    const restored = new SqlcipherDatabase(restoredPath, { key });
    backupSource.backupTo(restored);
    expect(restored.query<{ user_version: number }, []>("pragma user_version").get())
      .toEqual({ user_version: 8 });
    expect(restored.query<{ content: string }, []>("select content from notes").get())
      .toEqual({ content: "migration canary" });
    restored.close();
    backupSource.close();
  });

  it("atomically exchanges two files on the migration volume", () => {
    const directory = temporaryDirectory();
    const first = join(directory, "first");
    const second = join(directory, "second");
    writeFileSync(first, "first");
    writeFileSync(second, "second");
    atomicExchangeFiles(first, second);
    expect(readFileSync(first, "utf8")).toBe("second");
    expect(readFileSync(second, "utf8")).toBe("first");
  });

  it("keeps content, source, and FTS canaries unreadable in a live rollback journal", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "journal.db");
    const journalPath = `${path}-journal`;
    const key = randomBytes(32);
    const database = new SqlcipherDatabase(path, { key });
    database.exec(`
      create table notes (rowid integer primary key, content text, source_search text);
      create virtual table notes_fts using fts5(content, source_search);
      insert into notes values (1, 'JOURNAL_CONTENT_CANARY', 'JOURNAL_SOURCE_CANARY');
      insert into notes_fts values ('JOURNAL_FTS_CANARY', 'JOURNAL_SOURCE_CANARY');
    `);
    database.exec("begin immediate");
    database.query("update notes set content = ?, source_search = ? where rowid = 1")
      .run("replacement", "replacement");
    database.query("delete from notes_fts").run();
    expect(existsSync(journalPath)).toBe(true);
    const bytes = readFileSync(journalPath);
    for (const canary of [
      "JOURNAL_CONTENT_CANARY",
      "JOURNAL_SOURCE_CANARY",
      "JOURNAL_FTS_CANARY",
    ]) {
      expect(bytes.includes(Buffer.from(canary))).toBe(false);
    }
    const raw = Bun.spawnSync(["/usr/bin/sqlite3", "-readonly", path, ".tables"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(raw.exitCode).not.toBe(0);
    database.exec("rollback");
    database.close();
  });

  hostKeychainIt("creates and reopens one random vault key through the current signed Keychain identity", () => {
    const vaultId = createHash("sha256").update(randomUUID()).digest("hex");
    let first: Uint8Array | undefined;
    let second: Uint8Array | undefined;
    let created = false;
    try {
      expect(() => getOrCreateKeychainVaultKey(vaultId, {}))
        .toThrow("exact-build fallback");
      first = getOrCreateKeychainVaultKey(vaultId, {
        allowInsecureDevelopmentIdentity: true,
      });
      created = true;
      second = getOrCreateKeychainVaultKey(vaultId, {
        allowInsecureDevelopmentIdentity: true,
      });
      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
    } finally {
      first?.fill(0);
      second?.fill(0);
      if (created) deleteKeychainVaultKeyForTest(vaultId);
    }
  });

  hostKeychainIt("fails closed when a release access group is not present in signed entitlements", () => {
    const vaultId = createHash("sha256").update(randomUUID()).digest("hex");
    expect(() => getOrCreateKeychainVaultKey(vaultId, {
      accessGroup: "INVALIDTEAM.dev.afternote.vault-broker",
    })).toThrow("(-34018)");
  });

  hostKeychainIt("keeps release Keychain lookup, creation, and exact enrollment as separate fail-closed operations", () => {
    const vaultId = createHash("sha256").update(randomUUID()).digest("hex");
    const invalidAccessGroup = "ABCDE12345.dev.afternote.vault-broker";
    const candidate = randomBytes(32);
    try {
      expect(() => readDataProtectionKeychainVaultKey(vaultId, invalidAccessGroup))
        .toThrow(/Could not read the data-protection vault key \(-(34018|25291)\)/);
      expect(() => createDataProtectionKeychainVaultKey(vaultId, invalidAccessGroup))
        .toThrow(/data-protection vault key \(-(34018|25291)\)/);
      expect(() => enrollDataProtectionKeychainVaultKey(
        vaultId,
        invalidAccessGroup,
        candidate.subarray(0, 31),
      )).toThrow("exactly 32 bytes");
      expect(() => enrollDataProtectionKeychainVaultKey(
        vaultId,
        invalidAccessGroup,
        candidate,
      )).toThrow(/Could not read the data-protection vault key \(-(34018|25291)\)/);
    } finally {
      candidate.fill(0);
    }
  });

  hostKeychainIt("keeps one durable client key in the explicit exact-build development fallback", () => {
    const tag = `dev.afternote.test.client.${randomUUID()}`;
    let created = false;
    try {
      const first = openDurableClientSigner(tag, {
        allowInsecureDevelopmentIdentity: true,
      });
      created = true;
      const second = openDurableClientSigner(tag, {
        allowInsecureDevelopmentIdentity: true,
      });
      expect(first.signingMode).toBe("development-exact-build");
      expect(second.publicKey).toBe(first.publicKey);
      const message = "installed-client-proof";
      const signature = Buffer.from(second.sign(message), "base64url");
      expect(verify("sha256", Buffer.from(message), first.publicKey, signature)).toBe(true);
    } finally {
      if (created) deleteDevelopmentClientKeyForTest(tag);
    }
  });

  it("recognizes both macOS failures that require the development-only client fallback", () => {
    expect(isDevelopmentClientIdentityUnavailable(
      new Error("Could not create the Secure Enclave client key (-34018)"),
    )).toBe(true);
    expect(isDevelopmentClientIdentityUnavailable(
      new Error("Could not create the Secure Enclave client key (-25308)"),
    )).toBe(true);
    expect(isDevelopmentClientIdentityUnavailable(
      new Error("Could not create the Secure Enclave client key (-50)"),
    )).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "afternote-sqlcipher-database-"));
  directories.push(directory);
  return directory;
}
