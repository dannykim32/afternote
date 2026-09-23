import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import { ConversationArchives } from "./conversation-archives";
import { importConversationFile } from "./conversation-import";
import { migrateNoteSchema, openNoteDatabase } from "./note-database";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(text: string | Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "afternote-transcript-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "conversation.md");
  writeFileSync(path, text, { mode: 0o600 });
  const vaultPath = join(directory, "vault.db");
  const key = randomBytes(32);
  const database = openNoteDatabase(vaultPath, key, { create: true });
  database.exec("pragma foreign_keys = on");
  migrateNoteSchema(database, vaultPath, key);
  cleanup.push(() => database.close());
  const archives = new ConversationArchives(database);
  cleanup.push(() => archives.close());
  return { path, archives };
}

test("imports a transcript as ordered bounded Passages with its original Unicode, BOM and line endings", async () => {
  const text = "\ufeffOwner: café 🧭\r\n" + "x".repeat(65531) + "🌲\nAssistant: résumé.\n";
  const { path, archives } = fixture(text);
  const saved = await importConversationFile(path, "Unicode conversation", archives);
  let restored = "";
  let index: number | null = 0;
  while (index !== null) {
    const page = archives.read(saved.id, index);
    for (const passage of page.passages) {
      expect(Array.from(passage.text).length).toBeLessThanOrEqual(8192);
      restored += passage.text;
    }
    index = page.nextIndex;
  }
  expect(restored).toBe(text);
  expect(archives.list()).toHaveLength(1);
});

test("interrupted imports retain a hidden checkpoint and resume without duplicate Passages", async () => {
  const text = "a".repeat(180_000) + "\nOwner: finish here 🌲";
  const { path, archives } = fixture(text);
  const abort = new AbortController();
  let checkpoint = "";
  await expect(importConversationFile(path, "Interrupted", archives, {
    signal: abort.signal,
    onProgress(progress) {
      if (progress.phase === "saving" && progress.savedBytes > 0) {
        checkpoint = progress.archiveId!;
        abort.abort();
      }
    },
  })).rejects.toThrow();
  expect(checkpoint).not.toBe("");
  expect(archives.list()).toEqual([]);
  expect(archives.status(checkpoint).passageCount).toBe(8);
  const saved = await importConversationFile(path, "Interrupted", archives, { resumeId: checkpoint });
  expect(saved.id).toBe(checkpoint);
  expect(saved.passageCount).toBe(22);
  let result = "";
  for (let position = 0; position < saved.passageCount; position += 8) {
    result += archives.read(saved.id, position).passages.map((passage) => passage.text).join("");
  }
  expect(result).toBe(text);
  expect(archives.list()).toHaveLength(1);
});

test("changed files and invalid UTF-8 never become completed Archives", async () => {
  const { path, archives } = fixture("original transcript");
  let id = "";
  await expect(importConversationFile(path, "Changed", archives, {
    onProgress(progress) {
      if (progress.phase === "saving" && !id) {
        id = progress.archiveId!;
        writeFileSync(path, "replaced transcript");
      }
    },
  })).rejects.toThrow("manifest");
  expect(archives.status(id).state).toBe("importing");
  await expect(importConversationFile(path, "Changed", archives, { resumeId: id })).rejects.toThrow("does not match");
  expect(archives.list()).toEqual([]);
  writeFileSync(path, Buffer.from([0x61, 0xc0, 0xaf]));
  await expect(importConversationFile(path, "Invalid UTF-8", archives)).rejects.toThrow();
  expect(archives.list()).toEqual([]);
  const link = path + ".link";
  symlinkSync(path, link);
  await expect(importConversationFile(link, "Symbolic link", archives)).rejects.toThrow();
});

test("a million-word transcript remains one Archive and retrieves a small cited Passage", async () => {
  // A reproducible 6 MB scale fixture, not an assertion about any provider's tokenizer.
  const text = "hello ".repeat(500_000) + "\nOwner: observatory zephyr decision.\n" + "world ".repeat(500_000);
  const { path, archives } = fixture(text);
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 1);
  try {
    const saved = await importConversationFile(path, "Million-word conversation", archives);
    expect(saved.savedBytes).toBe(6_000_037);
    expect(saved.passageCount).toBe(733);
    expect(archives.list()).toHaveLength(1);
    expect(heartbeats).toBeGreaterThan(0);
    const results = archives.search("observatory zephyr");
    expect(results).toHaveLength(1);
    expect(results[0]!.excerpt).toContain("observatory");
    const page = archives.read(saved.id, results[0]!.index, 1);
    expect(page.passages[0]!.text).toContain("observatory zephyr decision");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(50_000);
  } finally { clearInterval(timer); }
}, 30_000);

test("passage boundaries do not split ordinary words and make them impossible to find", async () => {
  const text = "a ".repeat(4094) + "observatory approved\n";
  const { path, archives } = fixture(text);
  await importConversationFile(path, "Boundary", archives);
  expect(archives.search("observatory")).toHaveLength(1);
});

test("rejecting invalid UTF-8 never consumes an import slot", async () => {
  const { path, archives } = fixture(Buffer.from([0xc0, 0xaf]));
  for (let attempt = 0; attempt < 8; attempt++) {
    await expect(importConversationFile(path, "Malformed", archives)).rejects.toThrow();
  }
  writeFileSync(path, "Owner: a valid transcript.");
  const saved = await importConversationFile(path, "Valid", archives);
  expect(saved.state).toBe("ready");
});
