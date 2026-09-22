import { createHash, randomUUID } from "node:crypto";
import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import { MemoryError } from "@afternote/memory";
import type { InterchangeArchive, StreamingInterchangeArchive } from "./archive-interchange";
import { validateInterchangeArchives } from "./archive-interchange";
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_PASSAGES, MAX_VAULT_ARCHIVE_PASSAGES, MAX_PASSAGE_CHARACTERS, MAX_ARCHIVE_BATCH, validArchiveText } from "./conversation-archive-limits";
export { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_PASSAGES, MAX_VAULT_ARCHIVE_PASSAGES, MAX_PASSAGE_CHARACTERS, MAX_ARCHIVE_BATCH } from "./conversation-archive-limits";

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
export type ArchivePosition = { createdAt: string; id: string };
export type ArchiveListPage = { archives: ConversationArchive[]; next: ArchivePosition | null };

const ARCHIVE_COLUMNS = `id, title, state, expected_bytes as expectedBytes,
  sha256, saved_bytes as savedBytes, passage_count as passageCount, created_at as createdAt`;

/** Borrows the authorized caller's Vault connection. Never opens a Vault or owns its key. */
export class ConversationArchives {
  private readonly statements = new Map<string, Statement>();
  private closed = false;
  constructor(private readonly database: Database) {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const statement of this.statements.values()) {
      const resource = statement as { finalize?: () => void; close?: () => void };
      if (resource.finalize) resource.finalize();
      else resource.close?.();
    }
    this.statements.clear();
  }

  private query<Row = unknown, Parameters extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<Row, Parameters> {
    if (this.closed) throw new MemoryError("unavailable", "Archive storage is closed");
    // All SQL here is static: a fixed statement set, not one native handle per
    // Passage. The caller closes this store before releasing its Vault connection.
    let statement = this.statements.get(sql);
    if (!statement) {
      // Bun.query caches across borrowers; prepare gives this store ownership.
      // The SQLCipher adapter's query already creates an uncached statement.
      statement = typeof this.database.prepare === "function"
        ? this.database.prepare(sql) : this.database.query(sql);
      this.statements.set(sql, statement);
    }
    return statement as Statement<Row, Parameters>;
  }

  begin(manifest: ArchiveManifest): ConversationArchive {
    return this.database.transaction(() => this.beginInCurrentTransaction(manifest))();
  }

  /** The broker owns the surrounding transaction, including its success audit. */
  beginInCurrentTransaction(manifest: ArchiveManifest): ConversationArchive {
    boundedText(manifest.title, 200);
    boundedInteger(manifest.bytes, 1, MAX_ARCHIVE_BYTES);
    if (typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) invalidInput();
    const pending = this.query<{ count: number }, []>(
      "select count(*) as count from conversation_archives where state = 'importing'",
    ).get()!.count;
    if (pending >= 8) throw new MemoryError("rate_limited", "Finish or cancel pending Archive imports first");
    const used = this.query<{ bytes: number; count: number }, []>(
      "select coalesce(sum(expected_bytes), 0) as bytes, count(*) as count from conversation_archives",
    ).get()!;
    if (used.bytes + manifest.bytes > 256 * 1024 * 1024 || used.count >= 4096) {
      throw new MemoryError("rate_limited", "Archive capacity for this Vault has been reached");
    }
    const id = randomUUID();
    this.query(`insert into conversation_archives
      (id, title, state, expected_bytes, sha256, created_at) values (?, ?, 'importing', ?, ?, ?)`)
      .run(id, manifest.title, manifest.bytes, manifest.sha256, new Date().toISOString());
    return this.status(id);
  }

  status(id: string): ConversationArchive {
    const archive = this.query<ConversationArchive, [string]>(
      `select ${ARCHIVE_COLUMNS} from conversation_archives where id = ?`,
    ).get(id);
    if (!archive) throw new MemoryError("not_found", "Archive was not found");
    return archive;
  }

  append(id: string, startIndex: number, passages: string[]): ConversationArchive {
    return this.database.transaction(() => this.appendInCurrentTransaction(id, startIndex, passages))();
  }

  appendInCurrentTransaction(id: string, startIndex: number, passages: string[]): ConversationArchive {
    boundedInteger(startIndex, 0, MAX_ARCHIVE_PASSAGES - 1);
    if (!Array.isArray(passages)) invalidInput();
    boundedInteger(passages.length, 1, MAX_ARCHIVE_BATCH);
    for (const text of passages) boundedText(text, MAX_PASSAGE_CHARACTERS);
    const bytes = passages.reduce((total, text) => total + Buffer.byteLength(text), 0);
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
    if (archive.savedBytes + bytes > archive.expectedBytes || startIndex + passages.length > MAX_ARCHIVE_PASSAGES) invalidInput();
    const totalPassages = this.query<{ count: number }, []>(
      "select coalesce(sum(passage_count), 0) as count from conversation_archives",
    ).get()!.count;
    if (totalPassages + passages.length > MAX_VAULT_ARCHIVE_PASSAGES) {
      throw new MemoryError("rate_limited", "Passage capacity for this Vault has been reached");
    }
    for (const [offset, text] of passages.entries()) {
      this.query(`insert into conversation_passages (archive_id, passage_index, text)
        values (?, ?, ?)`).run(id, startIndex + offset, text);
    }
    this.query(`update conversation_archives set saved_bytes = saved_bytes + ?,
      passage_count = passage_count + ? where id = ?`).run(bytes, passages.length, id);
    return this.status(id);
  }

  complete(id: string): ConversationArchive {
    return this.database.transaction(() => this.completeInCurrentTransaction(id))();
  }

  completeInCurrentTransaction(id: string): ConversationArchive {
    const archive = this.status(id);
    const hash = createHash("sha256");
    for (let index = 0; index < archive.passageCount; index += MAX_ARCHIVE_BATCH) {
      for (const passage of this.passages(id, index, MAX_ARCHIVE_BATCH)) hash.update(passage.text);
    }
    if (archive.savedBytes !== archive.expectedBytes || hash.digest("hex") !== archive.sha256) {
      throw new MemoryError("conflict", "Transcript does not match its import manifest");
    }
    this.query("update conversation_archives set state = 'ready' where id = ?").run(id);
    return this.status(id);
  }

  list(): ConversationArchive[] {
    return this.listPage().archives;
  }

  listPage(options: {
    state?: ConversationArchive["state"];
    after?: ArchivePosition;
    limit?: number;
  } = {}): ArchiveListPage {
    const state = options.state ?? "ready";
    const limit = options.limit ?? 20;
    boundedInteger(limit, 1, 20);
    if (state !== "ready" && state !== "importing") invalidInput();
    if (options.after) {
      boundedText(options.after.id, 36);
      boundedText(options.after.createdAt, 24);
      if (!/^[a-f0-9-]{36}$/.test(options.after.id) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(options.after.createdAt) ||
          !Number.isFinite(Date.parse(options.after.createdAt))) invalidInput();
    }
    const rows = this.query<ConversationArchive, [string, number, string, string, string, number]>(
      `select ${ARCHIVE_COLUMNS} from conversation_archives
       where state = ? and (? = 0 or created_at < ? or (created_at = ? and id < ?))
       order by created_at desc, id desc limit ?`,
    ).all(state, options.after ? 1 : 0, options.after?.createdAt ?? "",
      options.after?.createdAt ?? "", options.after?.id ?? "", limit + 1);
    const archives = rows.slice(0, limit);
    const last = archives.at(-1);
    return { archives, next: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null };
  }

  cancel(id: string): boolean {
    return this.database.transaction(() => this.cancelInCurrentTransaction(id))();
  }

  cancelInCurrentTransaction(id: string): boolean {
    return this.removeInCurrentTransaction(id, "importing");
  }

  /** Storage only: the caller must obtain fresh Owner approval before deletion. */
  delete(id: string): boolean {
    return this.database.transaction(() => this.deleteInCurrentTransaction(id))();
  }

  deleteInCurrentTransaction(id: string): boolean {
    return this.removeInCurrentTransaction(id, "ready");
  }

  private removeInCurrentTransaction(id: string, expectedState: ConversationArchive["state"]): boolean {
    const archive = this.query<{ state: string }, [string]>(
      "select state from conversation_archives where id = ?",
    ).get(id);
    if (!archive) return false;
    if (archive.state !== expectedState) throw new MemoryError("conflict", expectedState === "ready"
      ? "Discard an incomplete Archive instead" : "Cannot cancel a completed Archive");
    // Borrowed connections may not enable cascades; the explicit Passage delete
    // also removes the FTS projection through its trigger.
    this.query("delete from conversation_passages where archive_id = ?").run(id);
    this.query("delete from conversation_archives where id = ?").run(id);
    return true;
  }

  /** Includes incomplete imports. Call under the owner's backup snapshot transaction. */
  *exportSnapshot(): Iterable<StreamingInterchangeArchive> {
    const store = this;
    for (const archive of this.query<ConversationArchive, []>(
      `select ${ARCHIVE_COLUMNS} from conversation_archives order by id`,
    ).iterate()) {
      yield { ...archive, passages: function* () {
        for (let index = 0; index < archive.passageCount; index += MAX_ARCHIVE_BATCH) {
          for (const passage of store.passages(archive.id, index, MAX_ARCHIVE_BATCH)) yield passage.text;
        }
      } };
    }
  }

  /** Restores canonical IDs and progress into an empty, unpublished Vault only. */
  restoreInCurrentTransaction(archives: InterchangeArchive[]): void {
    validateInterchangeArchives(archives);
    if (this.query("select 1 from conversation_archives limit 1").get()) {
      throw new MemoryError("conflict", "Archive restore requires an empty Vault");
    }
    for (const archive of archives) {
      this.query(`insert into conversation_archives
        (id, title, state, expected_bytes, sha256, saved_bytes, passage_count, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`).run(archive.id, archive.title, archive.state,
          archive.expectedBytes, archive.sha256, archive.savedBytes, archive.passageCount, archive.createdAt);
      for (const [index, passage] of archive.passages.entries()) {
        this.query(`insert into conversation_passages (archive_id, passage_index, text)
          values (?, ?, ?)`).run(archive.id, index, passage);
      }
    }
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
    return this.query<ArchiveSearchResult, [string, number]>(`
      select p.archive_id as archiveId, p.passage_index as 'index', a.title,
        substr(snippet(conversation_passages_fts, 0, '', '', '…', 24), 1, 1024) as excerpt
      from conversation_passages_fts
      join conversation_passages p on p.rowid = conversation_passages_fts.rowid
      join conversation_archives a on a.id = p.archive_id
      where conversation_passages_fts match ? and a.state = 'ready'
      order by rank, p.archive_id, p.passage_index limit ?`).all(match, limit);
  }

  private passages(id: string, startIndex: number, limit: number): ArchivePassage[] {
    return this.query<ArchivePassage, [string, number, number]>(
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
  if (!validArchiveText(value, maximum)) invalidInput();
}
