import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { migrateNoteSchema, openNoteDatabase } from "./note-database";
import { ConversationArchives } from "./conversation-archives";
import { SqliteMemory } from "./sqlite-memory";

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
  return { archives: new ConversationArchives(database), path, database, key };
}

function manifest(content: string, title = "Project transcript") {
  return { title, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
}

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
  try {
    const resumed = new ConversationArchives(reopened);
    expect(resumed.status(started.id).savedBytes).toBe(34);
    resumed.complete(started.id);
    expect(resumed.search("SEQUOIA")[0]!.archiveId).toBe(started.id);
    expect(resumed.read(started.id).passages[0]!.text).toBe(text);
    expect(readFileSync(path).includes(Buffer.from(text))).toBe(false);
  } finally { reopened.close(); }
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

test("the notes-only backup format cannot silently omit an Archive", () => {
  const { path, key, archives } = fixture(true);
  const vault = { vaultId: "a".repeat(64), deployment: "local" as const };
  const memory = new SqliteMemory(path, vault, { encryptionKey: key });
  const destination = path + ".export.json";
  try {
    const archive = archives.begin(manifest("private transcript"));
    expect(() => memory.exportInterchange(vault, destination, "2.0.0-beta.5")).toThrow("Archives");
    expect(existsSync(destination)).toBe(false);
    archives.append(archive.id, 0, ["private transcript"]);
    archives.complete(archive.id);
    expect(() => memory.exportInterchange(vault, destination, "2.0.0-beta.5")).toThrow("Archives");
    expect(existsSync(destination)).toBe(false);
  } finally { memory.close(); }
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
