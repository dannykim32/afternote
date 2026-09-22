import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { migrateNoteSchema, openNoteDatabase } from "./note-database";
import { ConversationArchives } from "./conversation-archives";
import { SqliteMemory } from "./sqlite-memory";
import { readInterchange } from "./interchange";
import { cleanVaultRestoreApprovalSnapshot, cleanVaultRestoreCoordinationDigest, restoreCleanEncryptedVault } from "./encrypted-vault-restore";
import { restoredVaultPayloadDigests } from "./restored-vault-payload";
import { SqlcipherDatabase } from "./sqlcipher-database";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(encrypted = false) {
  const directory = mkdtempSync(join(tmpdir(), "afternote-archives-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "vault.db");
  const key = encrypted ? randomBytes(32) : undefined;
  const database = openNoteDatabase(path, key, { create: true });
  database.exec("pragma foreign_keys = on");
  migrateNoteSchema(database, path, key);
  cleanups.push(() => database.close());
  const archives = new ConversationArchives(database);
  cleanups.push(() => archives.close());
  return { archives, path, database, key };
}

function manifest(content: string, title = "Project transcript") {
  return { title, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
}

test("Archive writes join the encrypted broker transaction and roll back with its audit failure", () => {
  const { archives, database } = fixture(true);
  let id = "";
  expect(() => database.transaction(() => {
    id = archives.beginInCurrentTransaction(manifest("transaction canary")).id;
    archives.appendInCurrentTransaction(id, 0, ["transaction canary"]);
    archives.completeInCurrentTransaction(id);
    expect(archives.search("canary")).toHaveLength(1);
    throw new Error("audit commit failed");
  })()).toThrow("audit commit failed");
  expect(() => archives.status(id)).toThrow("not found");
  expect(archives.search("canary")).toEqual([]);
  database.transaction(() => {
    id = archives.beginInCurrentTransaction(manifest("transaction canary")).id;
    archives.appendInCurrentTransaction(id, 0, ["transaction canary"]);
    archives.completeInCurrentTransaction(id);
  })();
  expect(archives.read(id).passages[0]!.text).toBe("transaction canary");
});

test("closing a borrowed Archive store does not finalize another store's statements", () => {
  const { archives, database } = fixture();
  const id = archives.begin(manifest("shared connection")).id;
  const other = new ConversationArchives(database);
  expect(other.status(id).id).toBe(id);
  other.close();
  expect(archives.status(id).id).toBe(id);
  archives.append(id, 0, ["shared connection"]);
  archives.complete(id);
  expect(archives.read(id).passages[0]!.text).toBe("shared connection");
});

test("an explicitly imported transcript becomes one readable Archive without changing its text", () => {
  const { archives } = fixture();
  const transcript = "Owner: keep this exact.\r\nAssistant: understood 🧭\n";
  const started = archives.begin(manifest(transcript));
  expect(started.state).toBe("importing");
  expect(archives.list()).toEqual([]);
  archives.append(started.id, 0, [transcript]);
  const saved = archives.complete(started.id);
  expect(saved.state).toBe("ready");
  expect(archives.list().map((archive) => archive.id)).toEqual([started.id]);
  expect(archives.read(started.id, 0, 8)).toEqual({
    passages: [{ archiveId: started.id, index: 0, text: transcript }], nextIndex: null,
  });
});

test("owners page through all ready Archives separately from resumable imports", () => {
  const { archives } = fixture();
  const ids: string[] = [];
  for (let index = 0; index < 23; index++) {
    const archive = archives.begin(manifest("page canary", `Transcript ${index}`));
    archives.append(archive.id, 0, ["page canary"]);
    archives.complete(archive.id);
    ids.push(archive.id);
  }
  const pending = archives.begin(manifest("unfinished"));
  const first = archives.listPage({ limit: 20 });
  expect(first.archives).toHaveLength(20);
  expect(first.next).not.toBeNull();
  const second = archives.listPage({ after: first.next!, limit: 20 });
  expect(second.archives).toHaveLength(3);
  expect(second.next).toBeNull();
  expect([...first.archives, ...second.archives].map((archive) => archive.id).sort()).toEqual(ids.sort());
  expect(archives.listPage({ state: "importing" }).archives.map((archive) => archive.id)).toEqual([pending.id]);
  for (const limit of [0, 21, NaN, 1.5]) expect(() => archives.listPage({ limit })).toThrow();
});

test("approved deletion can join an audit transaction and removes ready text and search together", () => {
  const { archives, database } = fixture(true);
  const archive = archives.begin(manifest("removal canary"));
  archives.append(archive.id, 0, ["removal canary"]);
  archives.complete(archive.id);
  expect(() => database.transaction(() => {
    archives.deleteInCurrentTransaction(archive.id);
    expect(archives.search("removal")).toEqual([]);
    throw new Error("audit failed");
  })()).toThrow("audit failed");
  expect(archives.read(archive.id).passages[0]!.text).toBe("removal canary");
  expect(archives.search("removal")).toHaveLength(1);
  database.transaction(() => archives.deleteInCurrentTransaction(archive.id))();
  expect(() => archives.read(archive.id)).toThrow("not found");
  expect(archives.search("removal")).toEqual([]);
  expect(archives.list()).toEqual([]);
  expect(archives.delete(archive.id)).toBe(false);
  const pending = archives.begin(manifest("pending"));
  expect(() => archives.delete(pending.id)).toThrow("incomplete");
  expect(archives.status(pending.id).state).toBe("importing");
});

test("imports and reads reject oversized or malformed input before saving any of that batch", () => {
  const { archives } = fixture();
  for (const input of [manifest(""), { ...manifest("a"), bytes: 67_108_865 },
    { ...manifest("a"), title: "x".repeat(201) }, { ...manifest("a"), sha256: "not-a-hash" }]) {
    expect(() => archives.begin(input)).toThrow();
  }
  const archive = archives.begin(manifest("abc"));
  for (const passages of [[""], ["x".repeat(8193)], ["\ud800"], ["a", "bc", "d"], Array(9).fill("a")]) {
    expect(() => archives.append(archive.id, 0, passages)).toThrow();
    expect(archives.status(archive.id).savedBytes).toBe(0);
  }
  archives.append(archive.id, 0, ["abc"]);
  archives.complete(archive.id);
  for (const limit of [-1, 0, 9, NaN, Infinity, 1.5]) {
    expect(() => archives.read(archive.id, 0, limit)).toThrow();
  }
  for (const position of [-1, NaN, 0.5]) expect(() => archives.read(archive.id, position)).toThrow();
});

test("an interrupted import resumes in a new storage instance and exact retries never duplicate Passages", () => {
  const { archives, database } = fixture();
  const archive = archives.begin(manifest("first second third"));
  archives.append(archive.id, 0, ["first ", "second "]);
  const resumed = new ConversationArchives(database);
  cleanups.push(() => resumed.close());
  expect(resumed.status(archive.id).passageCount).toBe(2);
  expect(resumed.append(archive.id, 0, ["first ", "second "]).passageCount).toBe(2);
  expect(() => resumed.append(archive.id, 0, ["wrong ", "second "])).toThrow();
  expect(() => resumed.append(archive.id, 3, ["third"])).toThrow();
  expect(() => resumed.read(archive.id)).toThrow("incomplete");
  expect(() => resumed.complete(archive.id)).toThrow("manifest");
  resumed.append(archive.id, 2, ["third"]);
  resumed.complete(archive.id);
  expect(resumed.complete(archive.id).state).toBe("ready");
  expect(resumed.append(archive.id, 2, ["third"]).passageCount).toBe(3);
  expect(resumed.read(archive.id, 0, 2).nextIndex).toBe(2);
  expect(resumed.read(archive.id, 2, 2)).toEqual({
    passages: [{ archiveId: archive.id, index: 2, text: "third" }], nextIndex: null,
  });
});

test("Archive text and its search index persist only inside the encrypted Vault", () => {
  const { archives, path, key } = fixture(true);
  const text = "PRIVATE_ARCHIVE_CANARY_SEQUOIA_972";
  const started = archives.begin(manifest(text));
  archives.append(started.id, 0, [text]);
  const reopened = openNoteDatabase(path, key, { create: false });
  const resumed = new ConversationArchives(reopened);
  try {
    expect(resumed.status(started.id).savedBytes).toBe(34);
    resumed.complete(started.id);
    expect(resumed.search("SEQUOIA")[0]!.archiveId).toBe(started.id);
    expect(resumed.read(started.id).passages[0]!.text).toBe(text);
    expect(readFileSync(path).includes(Buffer.from(text))).toBe(false);
  } finally { resumed.close(); reopened.close(); }
});

test("cancelling a partial Archive frees its reservation and never removes a completed Archive", () => {
  const { archives } = fixture();
  const pending = Array.from({ length: 8 }, () => archives.begin(manifest("abc")));
  expect(() => archives.begin(manifest("abc"))).toThrow("imports");
  expect(archives.cancel(pending[0]!.id)).toBe(true);
  expect(archives.cancel(pending[0]!.id)).toBe(false);
  expect(() => archives.status(pending[0]!.id)).toThrow("not found");
  const final = archives.begin(manifest("abc"));
  archives.append(final.id, 0, ["abc"]);
  archives.complete(final.id);
  expect(() => archives.cancel(final.id)).toThrow("completed");
  expect(archives.read(final.id).passages[0]!.text).toBe("abc");
});

test("imports reserve bounded Vault space before accepting a large transcript", () => {
  const { archives } = fixture();
  const large = { ...manifest("large"), bytes: 67_108_864 };
  const pending = Array.from({ length: 4 }, () => archives.begin(large));
  expect(() => archives.begin(manifest("a"))).toThrow("capacity");
  archives.cancel(pending[0]!.id);
  expect(archives.begin(large).state).toBe("importing");
});

test("search returns cited Passages, excludes partial imports, and bounds excerpts", () => {
  const { archives } = fixture();
  const content = "Owner: telescope budget approved.\n";
  const partial = archives.begin(manifest(content));
  archives.append(partial.id, 0, [content]);
  expect(archives.search("telescope")).toEqual([]);
  const saved = archives.begin(manifest(content, "Observatory"));
  archives.append(saved.id, 0, [content]);
  archives.complete(saved.id);
  const matches = archives.search("telescope budget");
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({ archiveId: saved.id, index: 0, title: "Observatory" });
  expect(matches[0]!.excerpt).toContain("telescope");
  expect(archives.read(matches[0]!.archiveId, matches[0]!.index, 1).passages[0]!.text).toBe(content);
  expect(archives.search("nonexistent")).toEqual([]);
  for (const query of ["", " ", "*", "x".repeat(2001)]) expect(() => archives.search(query)).toThrow();
  for (const limit of [-1, 0, 21, 1.5]) expect(() => archives.search("budget", limit)).toThrow();
  expect(() => archives.search('" OR (DROP TABLE notes)')).not.toThrow();
});

test("Vault backups round-trip completed and paused Archives alongside Notes", async () => {
  const { path, key, archives } = fixture(true);
  const vault = { vaultId: "a".repeat(64), deployment: "local" as const };
  const memory = new SqliteMemory(path, vault, { encryptionKey: key });
  const destination = path + ".export.json";
  try {
    await memory.remember(vault, { content: "ordinary note" });
    const archive = archives.begin(manifest("private transcript"));
    archives.append(archive.id, 0, ["private transcript"]);
    archives.complete(archive.id);
    const paused = archives.begin(manifest("first second"));
    archives.append(paused.id, 0, ["first "]);
    memory.exportInterchange(vault, destination, "2.0.0-beta.5");
    expect(existsSync(destination)).toBe(true);
    const restoredPath = path + ".restored";
    SqliteMemory.restoreInterchange(destination, restoredPath, vault, "2.0.0-beta.5", { encryptionKey: key });
    const restoredDatabase = openNoteDatabase(restoredPath, key, { create: false });
    const restored = new ConversationArchives(restoredDatabase);
    try {
      expect(restored.status(archive.id)).toEqual(archives.status(archive.id));
      expect(restored.read(archive.id).passages[0]!.text).toBe("private transcript");
      expect(restored.search("private")[0]!.archiveId).toBe(archive.id);
      expect(restored.status(paused.id)).toEqual(archives.status(paused.id));
      restored.append(paused.id, 1, ["second"]);
      restored.complete(paused.id);
      expect(restored.read(paused.id).passages.map((p) => p.text).join("")).toBe("first second");
    } finally { restored.close(); restoredDatabase.close(); }
  } finally { memory.close(); }
});

test("approved encrypted recovery verifies archive-inclusive backups after an interrupted candidate", () => {
  const { path, key, archives } = fixture(true);
  const vault = { vaultId: "b".repeat(64), deployment: "local" as const };
  const memory = new SqliteMemory(path, vault, { encryptionKey: key });
  const exportPath = path + ".json";
  const destination = path + ".recovered";
  const archive = archives.begin(manifest("recovery observatory canary"));
  archives.append(archive.id, 0, ["recovery observatory canary"]);
  archives.complete(archive.id);
  try { memory.exportInterchange(vault, exportPath, "2.0.0-beta.5"); }
  finally { memory.close(); }
  const approvalSnapshot = cleanVaultRestoreApprovalSnapshot(exportPath, destination, "2.0.0-beta.5");
  const options = { approvalSnapshot, coordinationDigest: cleanVaultRestoreCoordinationDigest(approvalSnapshot, destination, vault),
    applicationVersion: "2.0.0-beta.5", databasePath: destination, key: key!, vault };
  expect(() => restoreCleanEncryptedVault({ ...options, injectFault: (phase) => {
    if (phase === "after_candidate_verified") throw new Error("interrupted candidate");
  } })).toThrow("interrupted candidate");
  expect(restoreCleanEncryptedVault({ ...options,
    approvalSnapshot: cleanVaultRestoreApprovalSnapshot(exportPath, destination, "2.0.0-beta.5"),
  })).toMatchObject({ auditComplete: false });
  const restoredDatabase = openNoteDatabase(destination, key, { readonly: true });
  const restored = new ConversationArchives(restoredDatabase);
  try { expect(restored.read(archive.id).passages[0]!.text).toBe("recovery observatory canary"); }
  finally { restored.close(); restoredDatabase.close(); }
});

test("a historical schema-10 encrypted recovery candidate retains its notes-only payload digest", async () => {
  const { path, key } = fixture(true);
  const vault = { vaultId: "d".repeat(64), deployment: "local" as const };
  const memory = new SqliteMemory(path, vault, { encryptionKey: key });
  const exportPath = path + ".v1.json";
  try {
    await memory.remember(vault, { content: "historical recovery canary" });
    memory.exportInterchange(vault, exportPath, "2.0.0-beta.5");
  } finally { memory.close(); }
  const expected = readInterchange(exportPath, "2.0.0-beta.5");
  expect(expected.schemaVersion).toBe(1);
  const historical = new SqlcipherDatabase(path, { key: key! });
  try {
    historical.exec(`drop trigger conversation_passages_insert;
      drop trigger conversation_passages_delete;
      drop table conversation_passages_fts;
      drop table conversation_passages;
      drop table conversation_archives;
      pragma user_version = 10;`);
  } finally { historical.close(); }
  const candidate = new SqlcipherDatabase(path, { key: key!, readonly: true });
  try {
    expect(restoredVaultPayloadDigests(candidate, "2.0.0-beta.5")).toEqual([expected.manifest.payloadSha256]);
    expect(candidate.query<{ user_version: number }, []>("pragma user_version").get()!.user_version).toBe(10);
  } finally { candidate.close(); }
});

test("tampered Archive backups fail before a destination Vault is created", () => {
  const { path, key, archives } = fixture(true);
  const vault = { vaultId: "c".repeat(64), deployment: "local" as const };
  const memory = new SqliteMemory(path, vault, { encryptionKey: key });
  const exportPath = path + ".json";
  const archive = archives.begin(manifest("tamper canary"));
  archives.append(archive.id, 0, ["tamper canary"]);
  archives.complete(archive.id);
  try { memory.exportInterchange(vault, exportPath, "2.0.0-beta.5"); }
  finally { memory.close(); }
  const original = readFileSync(exportPath, "utf8");
  const mutations = [
    (a: any) => { a.passages[0] = "different text"; },
    (a: any) => { a.passageCount = 0; },
    (a: any) => { a.state = "other"; },
    (a: any) => { a.title = "changed title"; },
    (a: any) => { a.extra = true; },
    (a: any) => { a.expectedBytes = 67_108_865; },
    (a: any) => { a.passages[0] = "\ud800"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = JSON.parse(original);
    mutate(changed.archives[0]);
    const changedPath = path + `.tampered-${index}.json`;
    writeFileSync(changedPath, JSON.stringify(changed), { mode: 0o600 });
    const destination = path + `.rejected-${index}`;
    expect(() => readInterchange(changedPath, "2.0.0-beta.5")).toThrow();
    expect(() => SqliteMemory.restoreInterchange(changedPath, destination, vault, "2.0.0-beta.5", { encryptionKey: key })).toThrow();
    expect(existsSync(destination)).toBe(false);
  }
});

test("tiny Passages cannot bypass the Vault-wide storage quota by creating unlimited rows", () => {
  const { archives } = fixture();
  const started = archives.begin(manifest("a".repeat(32768)));
  for (let index = 0; index < 32768; index += 8) archives.append(started.id, index, Array(8).fill("a"));
  archives.complete(started.id);
  const other = archives.begin(manifest("b"));
  expect(() => archives.append(other.id, 0, ["b"])).toThrow("Passage capacity");
  expect(archives.status(other.id).savedBytes).toBe(0);
}, 30_000);

test("closing Archive storage releases its resources without closing the caller's Vault", () => {
  const { archives, database } = fixture(true);
  const started = archives.begin(manifest("retained"));
  archives.append(started.id, 0, ["retained"]);
  archives.complete(started.id);
  archives.close();
  archives.close();
  expect(() => archives.read(started.id)).toThrow("closed");
  const next = new ConversationArchives(database);
  try { expect(next.read(started.id).passages[0]!.text).toBe("retained"); }
  finally { next.close(); }
});
