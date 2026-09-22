import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { MemoryError } from "@afternote/memory";

export type ArchiveManifest = { title: string; bytes: number; sha256: string };
export type ConversationArchive = {
  id: string;
  title: string;
  state: "importing" | "ready";
  expectedBytes: number;
  sha256: string;
  savedBytes: number;
  passageCount: number;
  createdAt: string;
};
export type ArchivePassage = { archiveId: string; index: number; text: string };
export type ArchivePage = { passages: ArchivePassage[]; nextIndex: number | null };
export type ArchiveSearchResult = { archiveId: string; index: number; title: string; excerpt: string };

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_PASSAGES = 32_768;
export const MAX_PASSAGE_CHARACTERS = 8192;
export const MAX_ARCHIVE_BATCH = 8;

const ARCHIVE_COLUMNS = `id, title, state, expected_bytes as expectedBytes,
  sha256, saved_bytes as savedBytes, passage_count as passageCount, created_at as createdAt`;

/** Borrows the authorized caller's Vault connection. Never opens a Vault or owns its key. */
export class ConversationArchives {
  constructor(private readonly database: Database) {}

  begin(manifest: ArchiveManifest): ConversationArchive {
    boundedText(manifest.title, 200);
    boundedInteger(manifest.bytes, 1, MAX_ARCHIVE_BYTES);
    if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) invalidInput();
    return this.database.transaction(() => {
      const pending = this.database.query<{ count: number }, []>(
        "select count(*) as count from conversation_archives where state = 'importing'",
      ).get()!.count;
      if (pending >= 8) throw new MemoryError("rate_limited", "Finish or cancel pending Archive imports first");
      const used = this.database.query<{ bytes: number; count: number }, []>(
        "select coalesce(sum(expected_bytes), 0) as bytes, count(*) as count from conversation_archives",
      ).get()!;
      if (used.bytes + manifest.bytes > 256 * 1024 * 1024 || used.count >= 4096) {
        throw new MemoryError("rate_limited", "Archive capacity for this Vault has been reached");
      }
      const id = randomUUID();
      this.database.query(`insert into conversation_archives
        (id, title, state, expected_bytes, sha256, created_at) values (?, ?, 'importing', ?, ?, ?)`)
        .run(id, manifest.title, manifest.bytes, manifest.sha256, new Date().toISOString());
      return this.status(id);
    })();
  }

  status(id: string): ConversationArchive {
    const archive = this.database.query<ConversationArchive, [string]>(
      `select ${ARCHIVE_COLUMNS} from conversation_archives where id = ?`,
    ).get(id);
    if (!archive) throw new MemoryError("not_found", "Archive was not found");
    return archive;
  }

  append(id: string, startIndex: number, passages: string[]): ConversationArchive {
    boundedInteger(startIndex, 0, MAX_ARCHIVE_PASSAGES - 1);
    if (!Array.isArray(passages)) invalidInput();
    boundedInteger(passages.length, 1, MAX_ARCHIVE_BATCH);
    for (const text of passages) boundedText(text, MAX_PASSAGE_CHARACTERS);
    const bytes = passages.reduce((total, text) => total + Buffer.byteLength(text), 0);
    return this.database.transaction(() => {
      const archive = this.status(id);
      if (startIndex < archive.passageCount && startIndex + passages.length <= archive.passageCount) {
        const previous = this.passages(id, startIndex, passages.length);
        if (previous.length === passages.length && previous.every((value, index) => value.text === passages[index])) {
          return archive;
        }
        throw new MemoryError("conflict", "A retried Archive batch differs from the saved content");
      }
      if (archive.state !== "importing" || archive.passageCount !== startIndex) {
        throw new MemoryError("conflict", "Archive is not at the requested import position");
      }
      if (archive.savedBytes + bytes > archive.expectedBytes || startIndex + passages.length > MAX_ARCHIVE_PASSAGES) {
        invalidInput();
      }
      const totalPassages = this.database.query<{ count: number }, []>(
        "select coalesce(sum(passage_count), 0) as count from conversation_archives",
      ).get()!.count;
      if (totalPassages + passages.length > MAX_ARCHIVE_PASSAGES) {
        throw new MemoryError("rate_limited", "Passage capacity for this Vault has been reached");
      }
      for (const [offset, text] of passages.entries()) {
        this.database.query(`insert into conversation_passages (archive_id, passage_index, text)
          values (?, ?, ?)`).run(id, startIndex + offset, text);
      }
      this.database.query(`update conversation_archives set saved_bytes = saved_bytes + ?,
        passage_count = passage_count + ? where id = ?`).run(bytes, passages.length, id);
      return this.status(id);
    })();
  }

  complete(id: string): ConversationArchive {
    return this.database.transaction(() => {
      const archive = this.status(id);
      const hash = createHash("sha256");
      for (let index = 0; index < archive.passageCount; index += 8) {
        for (const passage of this.passages(id, index, 8)) hash.update(passage.text);
      }
      if (archive.savedBytes !== archive.expectedBytes || hash.digest("hex") !== archive.sha256) {
        throw new MemoryError("conflict", "Transcript does not match its import manifest");
      }
      this.database.query("update conversation_archives set state = 'ready' where id = ?").run(id);
      return this.status(id);
    })();
  }

  list(): ConversationArchive[] {
    return this.database.query<ConversationArchive, []>(
      `select ${ARCHIVE_COLUMNS} from conversation_archives where state = 'ready' order by created_at desc, id desc limit 20`,
    ).all();
  }

  cancel(id: string): boolean {
    return this.database.transaction(() => {
      const archive = this.database.query<{ state: string }, [string]>(
        "select state from conversation_archives where id = ?",
      ).get(id);
      if (!archive) return false;
      if (archive.state !== "importing") throw new MemoryError("conflict", "Cannot cancel a completed Archive");
      this.database.query("delete from conversation_archives where id = ?").run(id);
      return true;
    })();
  }

  read(id: string, startIndex = 0, limit = 8): ArchivePage {
    boundedInteger(startIndex, 0, MAX_ARCHIVE_PASSAGES);
    boundedInteger(limit, 1, MAX_ARCHIVE_BATCH);
    const archive = this.status(id);
    if (archive.state !== "ready") throw new MemoryError("conflict", "Archive import is incomplete");
    const passages = this.passages(id, startIndex, limit);
    const nextIndex = startIndex + passages.length;
    return { passages, nextIndex: nextIndex < archive.passageCount ? nextIndex : null };
  }

  search(query: string, limit = 5): ArchiveSearchResult[] {
    boundedText(query, 2000);
    boundedInteger(limit, 1, 20);
    const terms = query.match(/[\p{L}\p{N}]+/gu);
    if (!terms?.length || terms.length > 32) invalidInput();
    const match = terms.map((term) => `"${term}"`).join(" AND ");
    return this.database.query<ArchiveSearchResult, [string, number]>(`
      select p.archive_id as archiveId, p.passage_index as 'index', a.title,
        substr(snippet(conversation_passages_fts, 0, '', '', '…', 24), 1, 1024) as excerpt
      from conversation_passages_fts
      join conversation_passages p on p.rowid = conversation_passages_fts.rowid
      join conversation_archives a on a.id = p.archive_id
      where conversation_passages_fts match ? and a.state = 'ready'
      order by rank, p.archive_id, p.passage_index limit ?`).all(match, limit);
  }

  private passages(id: string, startIndex: number, limit: number): ArchivePassage[] {
    return this.database.query<ArchivePassage, [string, number, number]>(
      `select archive_id as archiveId, passage_index as 'index', text from conversation_passages
       where archive_id = ? and passage_index >= ? order by passage_index limit ?`,
    ).all(id, startIndex, limit);
  }
}

function invalidInput(): never {
  throw new MemoryError("invalid_input", "Archive input is invalid or exceeds its size limit");
}

function boundedInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidInput();
}

function boundedText(value: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum * 2 ||
      /[\uD800-\uDFFF]/u.test(value) || Array.from(value).length > maximum) invalidInput();
}
