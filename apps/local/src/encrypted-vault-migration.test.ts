import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import type { VaultContext } from "@afternote/memory";
import {
  encryptionMigrationReadiness,
  finalizePlaintextVaultMigration,
  migratePlaintextVault,
  type EncryptionMigrationFault,
} from "./encrypted-vault-migration";
import { ExclusiveFileLock, SqlcipherDatabase } from "./sqlcipher-database";
import { SqliteMemory } from "./sqlite-memory";

const vault: VaultContext = { vaultId: "f".repeat(64), deployment: "local" };
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("plaintext-to-SQLCipher migration", () => {
  it("atomically publishes exact schema-9 data and keeps only explicitly selected plaintext", async () => {
    const { path, noteId, directory } = await plaintextVault();
    const key = randomBytes(32);
    const result = migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "keep" },
    });
    const indexed = new SqlcipherDatabase(path, { key, readonly: true });
    expect(indexed.query<{ count: number }, []>("select count(*) as count from note_embedding_chunks")
      .get()?.count).toBeGreaterThan(0);
    indexed.close();
    const encrypted = new SqliteMemory(path, vault, { encryptionKey: key });
    expect(await encrypted.getNote(vault, noteId)).toMatchObject({ revision: 2, content: "current" });
    expect((await encrypted.listNoteRevisions(vault, noteId)).revisions)
      .toMatchObject([{ revision: 2 }, { revision: 1 }]);
    encrypted.close();
    expect(result.legacyPlaintextPath).not.toBeNull();
    expect(existsSync(result.legacyPlaintextPath!)).toBe(true);
    const legacy = new Database(result.legacyPlaintextPath!, { readonly: true });
    expect(legacy.query<{ count: number }, []>("select count(*) as count from notes").get()?.count)
      .toBe(1);
    legacy.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(existsSync(result.encryptedRollbackPath)).toBe(true);
    expect(() => new Database(path, { readonly: true }).query("select * from notes").all()).toThrow();
    expect(existsSync(join(directory, "vault.db.encryption-migration.json"))).toBe(false);
  });

  it("preserves the schema-8 plaintext upgrade path and migrates after encryption", async () => {
    const { path, noteId } = await plaintextVault();
    const previous = new Database(path);
    previous.exec(`
      drop table note_temporal_annotations;
      drop table note_temporal_index;
      pragma user_version = 8;
    `);
    previous.close();
    const key = randomBytes(32);

    migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
    });

    const reopened = new SqliteMemory(path, vault, { encryptionKey: key });
    try {
      expect(await reopened.getNote(vault, noteId)).toMatchObject({
        revision: 2,
        content: "current",
      });
      expect(reopened.diagnosticSnapshot(vault).schemaVersion).toBe(9);
    } finally {
      reopened.close();
    }
  });

  it("does not import broker clients or grants from an untrusted plaintext vault", async () => {
    const { path } = await plaintextVault();
    const plaintext = new Database(path);
    plaintext.exec(`
      create table broker_clients (id text primary key, public_key text not null);
      insert into broker_clients values ('attacker', 'planted-authority');
      create table broker_grants (id text primary key, client_id text not null);
      insert into broker_grants values ('attacker-grant', 'attacker');
    `);
    plaintext.close();
    const key = randomBytes(32);
    migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
    });
    const encrypted = new SqlcipherDatabase(path, { key, readonly: true });
    try {
      expect(encrypted.query<{ count: number }>(
        "select count(*) as count from broker_clients",
      ).get()?.count).toBe(0);
      expect(encrypted.query<{ count: number }>(
        "select count(*) as count from broker_grants",
      ).get()?.count).toBe(0);
    } finally {
      encrypted.close();
    }
  });

  for (const fault of [
    "after_candidate_created",
    "after_rollback_created",
    "after_source_prepared",
    "after_candidate_verified",
    "after_swap",
  ] as const) {
    it(`recovers after ${fault}`, async () => {
      const { path, noteId } = await plaintextVault();
      const key = randomBytes(32);
      expect(() => migratePlaintextVault({
        databasePath: path,
        key,
        legacyDecision: { action: "delete" },
        injectFault(phase: EncryptionMigrationFault) {
          if (phase === fault) throw new Error(fault);
        },
      })).toThrow(fault);
      migratePlaintextVault({ databasePath: path, key, legacyDecision: { action: "delete" } });
      const encrypted = new SqliteMemory(path, vault, { encryptionKey: key });
      expect(await encrypted.getNote(vault, noteId)).toMatchObject({ content: "current", revision: 2 });
      encrypted.close();
    });
  }

  it("rebuilds a verified candidate if the stopped plaintext source changed before resume", async () => {
    const { path } = await plaintextVault();
    const key = randomBytes(32);
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      injectFault(phase) {
        if (phase === "after_candidate_verified") throw new Error("stop");
      },
    })).toThrow("stop");
    const changed = new SqliteMemory(path, vault);
    const added = await changed.remember(vault, { content: "written after candidate" });
    changed.close();
    migratePlaintextVault({ databasePath: path, key, legacyDecision: { action: "delete" } });
    const encrypted = new SqliteMemory(path, vault, { encryptionKey: key });
    expect(await encrypted.getNote(vault, added.id)).toMatchObject({
      content: "written after candidate",
    });
    encrypted.close();
  });

  it("defers completion until the broker reopens and audits the encrypted vault", async () => {
    const { path } = await plaintextVault();
    const key = randomBytes(32);
    const coordinationDigest = "a".repeat(64);
    const completed = migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      coordinationDigest,
      deferFinalization: true,
    });
    expect(completed).toMatchObject({
      legacyPlaintextRetained: false,
      legacyArtifactsFound: 0,
      legacyArtifactsRetained: 0,
    });
    expect(encryptionMigrationReadiness(path)).toBe("resumable");
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      coordinationDigest: "b".repeat(64),
      deferFinalization: true,
    })).toThrow("recovery policy changed");
    expect(migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      coordinationDigest,
      deferFinalization: true,
    })).toMatchObject({ legacyPlaintextRetained: false });
    finalizePlaintextVaultMigration(path, coordinationDigest);
    expect(encryptionMigrationReadiness(path)).toBe("ineligible");
  });

  it("rejects a completed marker while an encryption candidate still exists", async () => {
    const { path } = await plaintextVault();
    const key = randomBytes(32);
    const coordinationDigest = "e".repeat(64);
    migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      coordinationDigest,
      deferFinalization: true,
    });
    writeFileSync(`${path}.encryption-candidate`, "planted plaintext", { mode: 0o600 });
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      coordinationDigest,
      deferFinalization: true,
    })).toThrow("remaining displaced vault");
  });

  it("adopts an in-flight pre-broker phase marker under the freshly approved policy", async () => {
    const { path } = await plaintextVault();
    const key = randomBytes(32);
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      injectFault(phase) {
        if (phase === "after_candidate_verified") throw new Error("legacy stop");
      },
    })).toThrow("legacy stop");
    const markerPath = `${path}.encryption-migration.json`;
    const legacyMarker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete legacyMarker.coordinationDigest;
    delete legacyMarker.completion;
    writeFileSync(markerPath, `${JSON.stringify(legacyMarker)}\n`, { mode: 0o600 });

    const coordinationDigest = "c".repeat(64);
    expect(migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      coordinationDigest,
      deferFinalization: true,
    })).toMatchObject({ legacyPlaintextRetained: false });
    finalizePlaintextVaultMigration(path, coordinationDigest);
    expect(encryptionMigrationReadiness(path)).toBe("ineligible");
  });

  it("rejects a marker that redirects cleanup to the live vault", async () => {
    const { path, noteId } = await plaintextVault();
    const key = randomBytes(32);
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      injectFault(phase) {
        if (phase === "after_swap") throw new Error("stop");
      },
    })).toThrow("stop");
    const markerPath = `${path}.encryption-migration.json`;
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      candidateName: string;
    };
    marker.candidateName = "vault.db";
    writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600 });
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
    })).toThrow("marker names do not match");
    const encrypted = new SqliteMemory(path, vault, { encryptionKey: key });
    expect(await encrypted.getNote(vault, noteId)).toMatchObject({ content: "current" });
    encrypted.close();
  });

  it("requires and applies explicit decisions for plaintext exports and migration snapshots", async () => {
    const { path, directory } = await plaintextVault();
    const exported = join(directory, "backups", "legacy-pre-alpha.2.afternote.json");
    const snapshot = `${path}.pre-migration-v7-deadbeef.db`;
    const moved = join(directory, "acknowledged", "legacy-export.json");
    mkdirSync(dirname(exported), { recursive: true, mode: 0o700 });
    writeFileSync(exported, "plaintext export", { mode: 0o600 });
    writeFileSync(snapshot, "plaintext snapshot", { mode: 0o600 });
    const key = randomBytes(32);
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
    })).toThrow("requires an explicit decision");
    mkdirSync(dirname(moved), { recursive: true, mode: 0o700 });
    const result = migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "delete" },
      legacyArtifactDecisions: [
        { path: exported, decision: { action: "move", destinationPath: moved } },
        { path: snapshot, decision: { action: "delete" } },
      ],
    });
    expect(result.retainedPlaintextPaths).toEqual([moved]);
    expect(existsSync(exported)).toBe(false);
    expect(existsSync(snapshot)).toBe(false);
    expect(readFileSync(moved, "utf8")).toBe("plaintext export");
  });

  it("resumes a legacy move after the destination was published but the source remained", async () => {
    const { path, directory } = await plaintextVault();
    const exported = join(directory, "backups", "legacy-pre-alpha.2.afternote.json");
    const moved = join(directory, "acknowledged", "legacy-export.json");
    mkdirSync(dirname(exported), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(moved), { recursive: true, mode: 0o700 });
    writeFileSync(exported, "plaintext export", { mode: 0o600 });
    writeFileSync(moved, "plaintext export", { mode: 0o600 });

    const result = migratePlaintextVault({
      databasePath: path,
      key: randomBytes(32),
      legacyDecision: { action: "delete" },
      legacyArtifactDecisions: [
        { path: exported, decision: { action: "move", destinationPath: moved } },
      ],
    });

    expect(result.retainedPlaintextPaths).toEqual([moved]);
    expect(existsSync(exported)).toBe(false);
    expect(readFileSync(moved, "utf8")).toBe("plaintext export");
  });

  it("resumes a displaced-live move only from content matching the approved marker", async () => {
    const { path, noteId, directory } = await plaintextVault();
    const key = randomBytes(32);
    const moved = join(directory, "acknowledged", "legacy-vault.db");
    mkdirSync(dirname(moved), { recursive: true, mode: 0o700 });
    expect(() => migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "move", destinationPath: moved },
      injectFault(phase) {
        if (phase === "after_swap") throw new Error("stop after swap");
      },
    })).toThrow("stop after swap");
    renameSync(`${path}.encryption-candidate`, moved);

    expect(migratePlaintextVault({
      databasePath: path,
      key,
      legacyDecision: { action: "move", destinationPath: moved },
    })).toMatchObject({ legacyPlaintextPath: moved, legacyPlaintextRetained: true });
    const encrypted = new SqliteMemory(path, vault, { encryptionKey: key });
    expect(await encrypted.getNote(vault, noteId)).toMatchObject({ content: "current" });
    encrypted.close();
  });

  it("rejects colliding blanket move destinations before mutating any vault or artifact", async () => {
    const { path, directory } = await plaintextVault();
    const rootArtifact = join(directory, "same.afternote.json");
    const backupDirectory = join(directory, "backups");
    const backupArtifact = join(backupDirectory, "same.afternote.json");
    const destination = join(directory, "acknowledged", "same.afternote.json");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(rootArtifact, "root export", { mode: 0o600 });
    writeFileSync(backupArtifact, "backup export", { mode: 0o600 });

    expect(() => migratePlaintextVault({
      databasePath: path,
      key: randomBytes(32),
      legacyDecision: { action: "delete" },
      legacyArtifactDecisions: [
        { path: rootArtifact, decision: { action: "move", destinationPath: destination } },
        { path: backupArtifact, decision: { action: "move", destinationPath: destination } },
      ],
    })).toThrow("move destinations must be unique");
    expect(readFileSync(path).subarray(0, 16).toString()).toBe("SQLite format 3\0");
    expect(readFileSync(rootArtifact, "utf8")).toBe("root export");
    expect(readFileSync(backupArtifact, "utf8")).toBe("backup export");
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a live/artifact move collision before swapping the live vault", async () => {
    const { path, directory } = await plaintextVault();
    const artifact = join(directory, "same.afternote.json");
    const destination = join(directory, "acknowledged", "same.afternote.json");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(artifact, "artifact export", { mode: 0o600 });

    expect(() => migratePlaintextVault({
      databasePath: path,
      key: randomBytes(32),
      legacyDecision: { action: "move", destinationPath: destination },
      legacyArtifactDecisions: [
        { path: artifact, decision: { action: "move", destinationPath: destination } },
      ],
    })).toThrow("Live and artifact plaintext move destinations must be unique");
    expect(readFileSync(path).subarray(0, 16).toString()).toBe("SQLite format 3\0");
    expect(readFileSync(artifact, "utf8")).toBe("artifact export");
    expect(existsSync(`${path}.encryption-migration.json`)).toBe(false);
    expect(existsSync(`${path}.encryption-candidate`)).toBe(false);
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a legacy move whose destination is the source without deleting it", async () => {
    const { path, directory } = await plaintextVault();
    const exported = join(directory, "backups", "legacy-pre-alpha.2.afternote.json");
    mkdirSync(dirname(exported), { recursive: true, mode: 0o700 });
    writeFileSync(exported, "plaintext export", { mode: 0o600 });

    expect(() => migratePlaintextVault({
      databasePath: path,
      key: randomBytes(32),
      legacyDecision: { action: "delete" },
      legacyArtifactDecisions: [
        { path: exported, decision: { action: "move", destinationPath: exported } },
      ],
    })).toThrow("must not replace an inventoried source");
    expect(readFileSync(exported, "utf8")).toBe("plaintext export");
  });

  it("refuses the final digest and swap while the runtime lifecycle lock is held", async () => {
    const { path, directory } = await plaintextVault();
    const lock = new ExclusiveFileLock(join(directory, ".vault.db.afternote.lock"));
    try {
      expect(() => migratePlaintextVault({
        databasePath: path,
        key: randomBytes(32),
        legacyDecision: { action: "delete" },
      })).toThrow("requires exclusive ownership");
    } finally {
      lock.release();
    }
  });
});

async function plaintextVault(): Promise<{ path: string; noteId: string; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), "afternote-encryption-migration-"));
  directories.push(directory);
  const path = join(directory, "vault.db");
  const memory = new SqliteMemory(path, vault);
  const note = await memory.remember(vault, { content: "original", source: { application: "Team Chat" } });
  await memory.updateNote(vault, note.id, { expectedRevision: 1, content: "current" });
  memory.close();
  const derived = new Database(path);
  derived.query(
    `insert into note_embeddings (
       note_id, note_revision, model_id, model_revision, dimensions, chunk_count, indexed_at
     ) values (?, 2, 'migration-fixture', '1', 2, 1, ?)`
  ).run(note.id, "2026-08-27T12:00:00.000Z");
  derived.query(
    `insert into note_embedding_chunks (
       note_id, chunk_index, content_start, content_end, vector
     ) values (?, 0, 0, 7, ?)`
  ).run(note.id, new Uint8Array(Float32Array.from([0.25, 0.75]).buffer));
  derived.close();
  return { path, noteId: note.id, directory };
}
