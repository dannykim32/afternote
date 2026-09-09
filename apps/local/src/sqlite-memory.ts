import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_RECALL_RESULTS,
  MEMORY_CAPABILITIES,
  MAX_NOTE_CHARACTERS,
  MAX_RECALL_QUERY_CHARACTERS,
  MAX_RECALL_RESULTS,
  MAX_SOURCE_APPLICATION_CHARACTERS,
  MAX_SOURCE_AUTHOR_CHARACTERS,
  MAX_SOURCE_LABEL_CHARACTERS,
  MAX_SOURCE_TIMESTAMP_CHARACTERS,
  MAX_SOURCE_URL_CHARACTERS,
  countCharacters,
  MemoryError,
  normalizeSourceTimestamp,
  vaultContextsEqual,
  type Memory,
  type MemoryCapability,
  type BrowseNotesInput,
  type BrowseNotesPage,
  type ListNoteRevisionsInput,
  type Note,
  type NoteRevision,
  type NoteRevisionsPage,
  type RecallResult,
  type RememberInput,
  type SearchNotesInput,
  type SearchNotesPage,
  type SourceContext,
  type UpdateNoteInput,
  type VaultContext,
} from "@afternote/memory";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  cosineSimilaritiesNative,
  SqlcipherDatabase,
} from "./sqlcipher-database";
import {
  MAX_INTERCHANGE_NOTES,
  MAX_INTERCHANGE_REVISIONS,
  readInterchange,
  writeInterchange,
  type InterchangeNote,
  type StreamingInterchangeNote,
} from "./interchange";
import {
  MAX_MARKDOWN_EXPORT_NOTES,
  writeMarkdownExport,
  type MarkdownExportNote,
} from "./markdown-export";
import { privateDatabaseBytes } from "./diagnostics";
import {
  cosineSimilarity,
  embeddingBytes,
  embeddingFromBytes,
  validateEmbedding,
  type DerivedIndexStatus,
  type RetrievalMode,
  type TextEmbeddingModel,
} from "./retrieval";
import {
  SYSTEM_SMART_VIEWS,
  deriveSystemSmartViewIds,
  isSystemSmartViewId,
  type SmartViewSummary,
} from "./smart-views";
import {
  deriveNoteOrganization,
  isOrganizationFacetKind,
  organizationDateRanges,
  organizationFacetKey,
  type NoteOrganization,
  type OrganizationBrowseKind,
  type OrganizationFacetKind,
  type OrganizationFacetSummary,
  type OrganizationOverview,
} from "./organization";
import {
  TEMPORAL_RESOLVER_VERSION,
  resolveTemporalExpressions,
  temporalEmbeddingContext,
  type TemporalAnnotation,
} from "./temporal";
import { DerivedIndexCoordinator } from "./derived-index-coordinator";

const QUERY_STOP_WORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "be",
  "can",
  "could",
  "did",
  "do",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "need",
  "of",
  "on",
  "remember",
  "recorded",
  "should",
  "the",
  "this",
  "to",
  "us",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "would",
]);
const EMBEDDING_CHUNK_CHARACTERS = 400;
const EMBEDDING_ATTEMPTS = 3;
const EMBEDDING_DELAYED_ATTEMPTS = 5;
const EMBEDDING_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_SEMANTIC_QUERY_TIMEOUT_MS = 1_500;
const CONNECTOR_RECALL_DEADLINE_MS = 2_000;
const MAX_RECALL_CANDIDATES = 10_000;
const MAX_TEMPORAL_ANNOTATIONS_PER_TEXT = 32;
const MAX_EMBEDDING_CHUNK_CANDIDATES = 100_000;
const SEMANTIC_HUBNESS_PENALTY = 0.55;
const TEMPORAL_TEXT_MATCH_BOOST = 10;

export type EffectiveSearchMode = "exact" | "indexing" | "hybrid" | "degraded";

// The app's visible search is exploratory: a person can inspect a broader set of
// plausible notes. Agent recall remains pinned to the embedding model's stricter
// threshold so automatic citations do not become noisier.
const MINIMUM_EXPLORATORY_SEARCH_SIMILARITY = 0.7;
export type SearchNotesExecution = SearchNotesPage & { searchMode: EffectiveSearchMode };

type HybridRecallExecution = {
  results: RecallResult[];
  searchMode: Exclude<EffectiveSearchMode, "exact">;
};

type NoteRow = {
  id: string;
  content: string;
  current_revision: number;
  source_json: string | null;
  created_at: string;
  updated_at: string;
};

type SearchRow = NoteRow & {
  excerpt: string;
  rank: number;
};

type EmbeddingRow = NoteRow & {
  embedding_revision: number;
  chunk_index: number;
  content_start: number;
  content_end: number;
  vector: Uint8Array;
};

type EmbeddingCandidateRow = Omit<EmbeddingRow, keyof NoteRow | "vector"> & {
  id: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
};

type EmbeddingVectorRow = EmbeddingCandidateRow & { vector: Uint8Array };
type HydratedEmbeddingRow = Omit<EmbeddingRow, "vector">;

type SemanticVector = {
  row: EmbeddingCandidateRow;
  vector: Float32Array;
  magnitude: number;
};

type SemanticCandidate = SemanticVector & { similarity: number };

type VectorWithMagnitude = {
  vector: Float32Array;
  magnitude: number;
};

type SemanticIndexCache = {
  modelKey: string;
  vectors: SemanticVector[];
  packedVectors: Float32Array;
  magnitudes: Float32Array;
  corpusSimilarities: Float64Array;
  noteOrdinals: Uint32Array;
  noteCount: number;
};

type RevisionRow = {
  note_id: string;
  revision: number;
  content: string;
  source_json: string | null;
  created_at: string;
};

type SchemaVersionRow = {
  user_version: number;
};

type OrganizationFacetRow = {
  facet_key: string;
  facet_label: string;
  note_count: number;
};

type BrowseCursor = {
  version: 1;
  kind: "browse";
  fingerprint: string;
  createdAt: string;
  id: string;
};

type SearchCursor = {
  version: 1;
  kind: "search";
  fingerprint: string;
  rank: number;
  createdAt: string;
  id: string;
};

type HybridSearchCursor = {
  version: 1;
  kind: "hybrid-search";
  fingerprint: string;
  score: number;
  createdAt: string;
  id: string;
};

type TemporalSearchCursor = {
  version: 1;
  kind: "temporal-search";
  fingerprint: string;
  score: number;
  createdAt: string;
  id: string;
};

type RevisionsCursor = {
  version: 1;
  kind: "revisions";
  fingerprint: string;
  revision: number;
  createdAt: string;
  id: string;
};

type SchemaMigration = {
  version: number;
  sql: string;
  prepare?: (database: Database) => void;
};

const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    sql: `
      create table if not exists notes (
        rowid integer primary key autoincrement,
        id text not null unique,
        content text not null,
        source_json text,
        created_at text not null,
        updated_at text not null
      );

      create virtual table if not exists notes_fts using fts5(
        content,
        content = 'notes',
        content_rowid = 'rowid',
        tokenize = 'unicode61'
      );

      create trigger if not exists notes_fts_insert after insert on notes begin
        insert into notes_fts(rowid, content) values (new.rowid, new.content);
      end;

      create trigger if not exists notes_fts_delete after delete on notes begin
        insert into notes_fts(notes_fts, rowid, content)
        values ('delete', old.rowid, old.content);
      end;

      create trigger if not exists notes_fts_update after update of content on notes begin
        insert into notes_fts(notes_fts, rowid, content)
        values ('delete', old.rowid, old.content);
        insert into notes_fts(rowid, content) values (new.rowid, new.content);
      end;
    `,
  },
  {
    version: 2,
    sql: `
      alter table notes add column current_revision integer not null default 1;

      create table note_revisions (
        note_id text not null,
        revision integer not null,
        content text not null,
        source_json text,
        created_at text not null,
        primary key (note_id, revision),
        foreign key (note_id) references notes(id) on delete cascade
      );

      insert into note_revisions (
        note_id, revision, content, source_json, created_at
      )
      select id, 1, content, source_json, created_at from notes;
    `,
  },
  {
    version: 3,
    sql: `
      create index notes_created_order
      on notes (created_at desc, id desc);
    `,
  },
  {
    version: 4,
    sql: `
      alter table notes add column source_search text;

      update notes
      set source_search = trim(
        coalesce(json_extract(source_json, '$.application'), '') || ' ' ||
        coalesce(json_extract(source_json, '$.url'), '') || ' ' ||
        coalesce(json_extract(source_json, '$.author'), '') || ' ' ||
        coalesce(json_extract(source_json, '$.timestamp'), '') || ' ' ||
        coalesce(json_extract(source_json, '$.label'), '')
      );

      drop trigger if exists notes_fts_insert;
      drop trigger if exists notes_fts_delete;
      drop trigger if exists notes_fts_update;
      drop table if exists notes_fts;

      create virtual table notes_fts using fts5(
        content,
        source_search,
        content = 'notes',
        content_rowid = 'rowid',
        tokenize = 'unicode61'
      );

      create trigger notes_fts_insert after insert on notes begin
        insert into notes_fts(rowid, content, source_search)
        values (new.rowid, new.content, new.source_search);
      end;

      create trigger notes_fts_delete after delete on notes begin
        insert into notes_fts(notes_fts, rowid, content, source_search)
        values ('delete', old.rowid, old.content, old.source_search);
      end;

      create trigger notes_fts_update after update of content, source_search on notes begin
        insert into notes_fts(notes_fts, rowid, content, source_search)
        values ('delete', old.rowid, old.content, old.source_search);
        insert into notes_fts(rowid, content, source_search)
        values (new.rowid, new.content, new.source_search);
      end;

      insert into notes_fts(rowid, content, source_search)
      select rowid, content, source_search from notes;
    `,
  },
  {
    version: 5,
    sql: `
      create table note_embeddings (
        note_id text primary key,
        note_revision integer not null,
        model_id text not null,
        model_revision text not null,
        dimensions integer not null check (dimensions > 0),
        vector blob not null,
        indexed_at text not null,
        foreign key (note_id) references notes(id) on delete cascade
      );

      create index note_embeddings_model
      on note_embeddings (model_id, model_revision, dimensions);
    `,
  },
  {
    version: 6,
    sql: `
      create table note_smart_views (
        note_id text not null,
        view_id text not null,
        note_revision integer not null,
        assigned_at text not null,
        primary key (note_id, view_id),
        foreign key (note_id) references notes(id) on delete cascade
      );

      create index note_smart_views_lookup
      on note_smart_views (view_id, note_revision, note_id);
    `,
  },
  {
    version: 7,
    sql: `
      drop index note_embeddings_model;
      alter table note_embeddings rename to note_embeddings_v5;

      create table note_embeddings (
        note_id text primary key,
        note_revision integer not null,
        model_id text not null,
        model_revision text not null,
        dimensions integer not null check (dimensions > 0),
        chunk_count integer not null check (chunk_count > 0),
        indexed_at text not null,
        foreign key (note_id) references notes(id) on delete cascade
      );

      create table note_embedding_chunks (
        note_id text not null,
        chunk_index integer not null,
        content_start integer not null,
        content_end integer not null,
        vector blob not null,
        primary key (note_id, chunk_index),
        foreign key (note_id) references note_embeddings(note_id) on delete cascade
      );

      create index note_embeddings_model
      on note_embeddings (model_id, model_revision, dimensions);

      drop table note_embeddings_v5;
    `,
  },
  {
    version: 8,
    sql: `
      create table note_organization (
        note_id text primary key,
        note_revision integer not null,
        compact_label text not null,
        indexed_at text not null,
        foreign key (note_id) references notes(id) on delete cascade
      );

      create table note_organization_facets (
        note_id text not null,
        facet_kind text not null check (facet_kind in ('people', 'sources', 'topics')),
        facet_key text not null,
        facet_label text not null,
        note_revision integer not null,
        primary key (note_id, facet_kind, facet_key),
        foreign key (note_id) references notes(id) on delete cascade
      );

      create index note_organization_facets_lookup
      on note_organization_facets (facet_kind, facet_key, note_revision, note_id);
    `,
  },
  {
    version: 9,
    sql: `
      create table if not exists note_temporal_index (
        note_id text primary key,
        note_revision integer not null,
        reference_timestamp text not null,
        timezone text not null,
        resolver_version integer not null,
        indexed_at text not null,
        foreign key (note_id) references notes(id) on delete cascade
      );

      create table if not exists note_temporal_annotations (
        note_id text not null,
        annotation_index integer not null,
        note_revision integer not null,
        original_phrase text not null,
        expression_start integer not null,
        expression_end integer not null,
        range_start text not null,
        range_end text not null,
        confidence real not null,
        primary key (note_id, annotation_index),
        foreign key (note_id) references note_temporal_index(note_id) on delete cascade
      );

      create index if not exists note_temporal_annotations_range
      on note_temporal_annotations (range_start, range_end, note_revision, note_id);
    `,
  },
  {
    version: 10,
    prepare: (database) => {
      const columns = database
        .query<{ name: string }, []>("pragma table_info(note_temporal_index)")
        .all();
      if (!columns.some(({ name }) => name === "source_timestamp")) {
        database.exec("alter table note_temporal_index add column source_timestamp text");
      }
    },
    sql: `
      update note_temporal_index
      set source_timestamp = (
        select json_extract(notes.source_json, '$.timestamp')
        from notes
        where notes.id = note_temporal_index.note_id
      );

      create index if not exists note_temporal_index_source_timestamp
      on note_temporal_index (source_timestamp, note_revision, note_id);
    `,
  },
] as const;

const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;

export class SqliteMemory implements Memory {
  readonly #database: Database;
  readonly #ownsDatabase: boolean;
  readonly #databasePath: string;
  readonly #encryptionKey: Uint8Array | undefined;
  readonly #embeddingModel: TextEmbeddingModel | null;
  readonly #retrievalMode: RetrievalMode;
  readonly #now: () => Date;
  readonly #timeZone: () => string;
  readonly #derivedIndexes: DerivedIndexCoordinator<Note>;
  #semanticIndexCache: SemanticIndexCache | null = null;
  #closed = false;

  constructor(
    databasePath: string,
    private readonly vault: VaultContext,
    options: {
      embeddingModel?: TextEmbeddingModel | null;
      retrievalMode?: RetrievalMode;
      encryptionKey?: Uint8Array;
      database?: SqlcipherDatabase;
      now?: () => Date;
      timeZone?: string;
      timeZoneProvider?: () => string;
    } = {},
  ) {
    this.#databasePath = databasePath;
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }

    this.#embeddingModel = options.embeddingModel ?? null;
    this.#retrievalMode = options.retrievalMode ?? "lexical";
    this.#now = options.now ?? (() => new Date());
    this.#timeZone = options.timeZoneProvider ?? (options.timeZone
      ? () => options.timeZone!
      : () => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.#encryptionKey = options.encryptionKey
      ? Uint8Array.from(options.encryptionKey)
      : undefined;
    if (this.#retrievalMode === "hybrid" && !this.#embeddingModel) {
      throw new Error("Hybrid retrieval requires a local embedding model");
    }

    this.#ownsDatabase = options.database === undefined;
    this.#database = options.database
      ? options.database as unknown as Database
      : openDatabase(databasePath, this.#encryptionKey, { create: true });
    this.#derivedIndexes = new DerivedIndexCoordinator<Note>({
      model: this.#embeddingModel?.descriptor ?? null,
      rebuildSynchronous: () => {
        this.#ensureTemporalIndexes();
        this.#rebuildSmartViews();
        this.#rebuildOrganization();
      },
      replaceSynchronous: (note) => {
        this.#replaceSmartViewAssignments(note);
        this.#replaceOrganizationAssignments(note);
        this.#replaceTemporalIndex(note);
      },
      missingSemanticNotes: () => this.#missingEmbeddingNotes(),
      indexSemanticNotes: (notes, reportError) =>
        this.#indexEmbeddingBatch(notes, reportError),
      totalNotes: () => this.#noteCount(),
      indexedNotes: () => this.#indexedEmbeddingCount(),
      invalidateSemanticCache: () => {
        this.#semanticIndexCache = null;
      },
    });
    try {
      if (databasePath !== ":memory:") {
        chmodSync(databasePath, 0o600);
      }
      this.#database.exec("PRAGMA foreign_keys = ON;");
      this.#database.exec(
        this.#encryptionKey ? "PRAGMA journal_mode = DELETE;" : "PRAGMA journal_mode = WAL;",
      );
      this.#migrate(databasePath);
      this.#derivedIndexes.initialize();
    } catch (error) {
      try {
        if (this.#ownsDatabase) this.#database.close();
      } finally {
        this.#encryptionKey?.fill(0);
      }
      throw error;
    }
  }

  async capabilities(vault: VaultContext): Promise<MemoryCapability[]> {
    this.#assertVault(vault);
    return [...MEMORY_CAPABILITIES];
  }

  async remember(vault: VaultContext, input: RememberInput): Promise<Note> {
    return this.#database.transaction(
      () => this.rememberInCurrentTransaction(vault, input),
    )();
  }

  rememberInCurrentTransaction(vault: VaultContext, input: RememberInput): Note {
    this.#assertVault(vault);
    const content = input.content;
    if (!content.trim()) {
      throw new MemoryError("invalid_input", "Note content cannot be empty");
    }
    if (countCharacters(content) > MAX_NOTE_CHARACTERS) {
      throw new MemoryError(
        "invalid_input",
        `Note content cannot exceed ${MAX_NOTE_CHARACTERS} characters`,
      );
    }

    const id = randomUUID();
    const now = this.#nextCreatedAt();
    const source = normalizeSource(input.source);

    const sourceJson = source ? JSON.stringify(source) : null;
    const sourceSearch = sourceSearchText(source);
    this.#database
      .query(
        `insert into notes (
           id, content, current_revision, source_json, source_search, created_at, updated_at
         ) values (?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, content, sourceJson, sourceSearch, now, now);
    this.#database
      .query(
        `insert into note_revisions (
           note_id, revision, content, source_json, created_at
         ) values (?, 1, ?, ?, ?)`,
      )
      .run(id, content, sourceJson, now);
    const note = { id, content, revision: 1, source, createdAt: now, updatedAt: now };
    this.#derivedIndexes.replace(note);
    return note;
  }

  async recall(
    vault: VaultContext,
    query: string,
    limit = DEFAULT_RECALL_RESULTS,
  ): Promise<RecallResult[]> {
    this.#assertVault(vault);
    if (query.length > MAX_RECALL_QUERY_CHARACTERS) {
      throw new MemoryError(
        "invalid_input",
        `Recall query cannot exceed ${MAX_RECALL_QUERY_CHARACTERS} characters`,
      );
    }
    if (isUnderspecifiedDeicticQuery(query)) return [];
    if (this.#retrievalMode === "hybrid" && this.#embeddingModel) {
      const operation = () => this.#hybridRecall(
          vault,
          query,
          limit,
          DEFAULT_SEMANTIC_QUERY_TIMEOUT_MS,
        );
      const execution = this.#encryptionKey
        ? await (this.#database as unknown as SqlcipherDatabase)
          .withProgressDeadline(CONNECTOR_RECALL_DEADLINE_MS, operation)
        : await operation();
      return execution.results;
    }
    return (
      await this.searchNotesWithDeadline(vault, {
        query,
        limit,
      }, CONNECTOR_RECALL_DEADLINE_MS)
    ).results;
  }

  async getNote(vault: VaultContext, id: string): Promise<Note | null> {
    return this.getNoteInCurrentTransaction(vault, id);
  }

  getNoteInCurrentTransaction(vault: VaultContext, id: string): Note | null {
    this.#assertVault(vault);
    const row = this.#database
      .query<NoteRow, [string]>(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes
         where id = ?`,
      )
      .get(id);
    return row ? rowToNote(row) : null;
  }

  async browseNotes(
    vault: VaultContext,
    input: BrowseNotesInput = {},
  ): Promise<BrowseNotesPage> {
    this.#assertVault(vault);
    const safeLimit = boundedLimit(input.limit, 50, 100);
    const cursor = input.cursor
      ? decodeCursor<BrowseCursor>(input.cursor, "browse", "recent")
      : null;
    const rows = this.#database
      .query<
        NoteRow,
        [string | null, string | null, string | null, string | null, number]
      >(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes
         where (? is null or created_at < ? or (created_at = ? and id < ?))
         order by created_at desc, id desc
         limit ?`,
      )
      .all(
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        safeLimit + 1,
      );
    const hasNextPage = rows.length > safeLimit;
    const pageRows = hasNextPage ? rows.slice(0, safeLimit) : rows;
    const last = pageRows.at(-1);
    return {
      notes: pageRows.map(rowToNote),
      nextCursor:
        hasNextPage && last
          ? encodeCursor({
              version: 1,
              kind: "browse",
              fingerprint: "recent",
              createdAt: last.created_at,
              id: last.id,
            } satisfies BrowseCursor)
          : null,
    };
  }

  smartViews(vault: VaultContext): SmartViewSummary[] {
    this.#assertVault(vault);
    const counts = new Map(
      this.#database
        .query<{ view_id: string; count: number }, []>(
          `select assignments.view_id, count(*) as count
           from note_smart_views assignments
           join notes on notes.id = assignments.note_id
           where assignments.note_revision = notes.current_revision
           group by assignments.view_id`,
        )
        .all()
        .map((row) => [row.view_id, row.count]),
    );
    return SYSTEM_SMART_VIEWS.map((view) => ({
      ...view,
      noteCount: counts.get(view.id) ?? 0,
    }));
  }

  async browseSmartView(
    vault: VaultContext,
    viewId: string,
    input: BrowseNotesInput = {},
  ): Promise<BrowseNotesPage> {
    this.#assertVault(vault);
    if (!isSystemSmartViewId(viewId)) {
      throw new MemoryError("invalid_input", "Unknown smart view");
    }
    const fingerprint = `smart-view:${viewId}`;
    const cursor = input.cursor
      ? decodeCursor<BrowseCursor>(input.cursor, "browse", fingerprint)
      : null;
    const safeLimit = boundedLimit(input.limit, 50, 100);
    const rows = this.#database
      .query<NoteRow, [string, string | null, string | null, string | null, string | null, number]>(
        `select notes.id, notes.content, notes.current_revision, notes.source_json,
                notes.created_at, notes.updated_at
         from note_smart_views assignments
         join notes on notes.id = assignments.note_id
         where assignments.view_id = ?
           and assignments.note_revision = notes.current_revision
           and (? is null or notes.created_at < ? or
                (notes.created_at = ? and notes.id < ?))
         order by notes.created_at desc, notes.id desc
         limit ?`,
      )
      .all(
        viewId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        safeLimit + 1,
      );
    const hasNextPage = rows.length > safeLimit;
    const pageRows = hasNextPage ? rows.slice(0, safeLimit) : rows;
    const last = pageRows.at(-1);
    return {
      notes: pageRows.map(rowToNote),
      nextCursor:
        hasNextPage && last
          ? encodeCursor({
              version: 1,
              kind: "browse",
              fingerprint,
              createdAt: last.created_at,
              id: last.id,
            } satisfies BrowseCursor)
          : null,
    };
  }

  noteOrganization(
    vault: VaultContext,
    noteId: string,
  ): NoteOrganization | null {
    this.#assertVault(vault);
    const row = this.#database
      .query<{ compact_label: string }, [string]>(
        `select compact_label
         from note_organization organization
         join notes on notes.id = organization.note_id
         where organization.note_id = ?
           and organization.note_revision = notes.current_revision`,
      )
      .get(noteId);
    if (!row) return null;
    const facets = this.#database
      .query<
        { facet_kind: OrganizationFacetKind; facet_label: string },
        [string]
      >(
        `select facet_kind, facet_label
         from note_organization_facets facets
         join notes on notes.id = facets.note_id
         where facets.note_id = ?
           and facets.note_revision = notes.current_revision
         order by facets.facet_kind asc, facets.facet_label collate nocase asc`,
      )
      .all(noteId);
    return {
      label: row.compact_label,
      people: facets
        .filter((facet) => facet.facet_kind === "people")
        .map((facet) => facet.facet_label),
      sources: facets
        .filter((facet) => facet.facet_kind === "sources")
        .map((facet) => facet.facet_label),
      topics: facets
        .filter((facet) => facet.facet_kind === "topics")
        .map((facet) => facet.facet_label),
    };
  }

  organizationOverview(
    vault: VaultContext,
    now = new Date(),
  ): OrganizationOverview {
    this.#assertVault(vault);
    return {
      people: this.#organizationFacetSummaries("people", 12),
      sources: this.#organizationFacetSummaries("sources", 12),
      topics: this.#organizationFacetSummaries("topics", 8, 2),
      dates: organizationDateRanges(now)
        .map((range) => ({
          key: range.key,
          label: range.label,
          noteCount: this.#dateRangeNoteCount(range.start, range.end),
        }))
        .filter((range) => range.noteCount > 0),
    };
  }

  async browseOrganizationFacet(
    vault: VaultContext,
    selection: { kind: OrganizationBrowseKind; key: string },
    input: BrowseNotesInput = {},
    now = new Date(),
  ): Promise<BrowseNotesPage> {
    this.#assertVault(vault);
    const safeLimit = boundedLimit(input.limit, 50, 100);
    const normalizedKey = organizationFacetKey(selection.key);
    const dateRange =
      selection.kind === "dates"
        ? organizationDateRanges(now).find((range) => range.key === normalizedKey)
        : null;
    if (
      (selection.kind === "dates" && !dateRange) ||
      (selection.kind !== "dates" && !isOrganizationFacetKind(selection.kind)) ||
      !normalizedKey ||
      normalizedKey.length > 200
    ) {
      throw new MemoryError("invalid_input", "Unknown organization facet");
    }
    const fingerprint = dateRange
      ? `organization:dates:${dateRange.key}:${dateRange.start ?? ""}:${dateRange.end ?? ""}`
      : `organization:${selection.kind}:${normalizedKey}`;
    const cursor = input.cursor
      ? decodeCursor<BrowseCursor>(input.cursor, "browse", fingerprint)
      : null;
    const rows = dateRange
      ? this.#database
          .query<
            NoteRow,
            [
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              number,
            ]
          >(
            `select id, content, current_revision, source_json, created_at, updated_at
             from notes
             where (? is null or created_at >= ?)
               and (? is null or created_at < ?)
               and (? is null or created_at < ? or (created_at = ? and id < ?))
             order by created_at desc, id desc
             limit ?`,
          )
          .all(
            dateRange.start,
            dateRange.start,
            dateRange.end,
            dateRange.end,
            cursor?.createdAt ?? null,
            cursor?.createdAt ?? null,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            safeLimit + 1,
          )
      : this.#database
          .query<
            NoteRow,
            [string, string, string | null, string | null, string | null, string | null, number]
          >(
            `select notes.id, notes.content, notes.current_revision, notes.source_json,
                    notes.created_at, notes.updated_at
             from note_organization_facets facets
             join notes on notes.id = facets.note_id
             where facets.facet_kind = ?
               and facets.facet_key = ?
               and facets.note_revision = notes.current_revision
               and (? is null or notes.created_at < ? or
                    (notes.created_at = ? and notes.id < ?))
             order by notes.created_at desc, notes.id desc
             limit ?`,
          )
          .all(
            selection.kind,
            normalizedKey,
            cursor?.createdAt ?? null,
            cursor?.createdAt ?? null,
            cursor?.createdAt ?? null,
            cursor?.id ?? null,
            safeLimit + 1,
          );
    const hasNextPage = rows.length > safeLimit;
    const pageRows = hasNextPage ? rows.slice(0, safeLimit) : rows;
    const last = pageRows.at(-1);
    return {
      notes: pageRows.map(rowToNote),
      nextCursor:
        hasNextPage && last
          ? encodeCursor({
              version: 1,
              kind: "browse",
              fingerprint,
              createdAt: last.created_at,
              id: last.id,
            } satisfies BrowseCursor)
          : null,
    };
  }

  async searchNotes(
    vault: VaultContext,
    input: SearchNotesInput,
  ): Promise<SearchNotesPage> {
    const execution = await this.#searchNotesExecution(
      vault,
      input,
      DEFAULT_SEMANTIC_QUERY_TIMEOUT_MS,
    );
    return { results: execution.results, nextCursor: execution.nextCursor };
  }

  async #searchNotesExecution(
    vault: VaultContext,
    input: SearchNotesInput,
    semanticTimeoutMs: number,
  ): Promise<SearchNotesExecution> {
    if (this.#retrievalMode === "hybrid" && this.#embeddingModel) {
      this.#assertVault(vault);
      if (input.query.length > MAX_RECALL_QUERY_CHARACTERS) {
        throw new MemoryError(
          "invalid_input",
          `Recall query cannot exceed ${MAX_RECALL_QUERY_CHARACTERS} characters`,
        );
      }
      const fingerprint = this.#hybridSearchFingerprint(input.query);
      const cursor = input.cursor
        ? decodeCursor<HybridSearchCursor>(
            input.cursor,
            "hybrid-search",
            fingerprint,
          )
        : null;
      const safeLimit = boundedLimit(
        input.limit,
        DEFAULT_RECALL_RESULTS,
        MAX_RECALL_RESULTS,
      );
      const execution = await this.#hybridRecall(
        vault,
        input.query,
        null,
        semanticTimeoutMs,
        Math.min(
          this.#embeddingModel.minimumSimilarity,
          MINIMUM_EXPLORATORY_SEARCH_SIMILARITY,
        ),
      );
      const temporal = this.#queryTemporalAnnotations(input.query);
      const lexicalIds = temporal.length === 0
        ? new Set(this.#allLexicalResults(vault, input.query).map((result) => result.note.id))
        : null;
      const ranked = lexicalIds && lexicalIds.size > 0
        ? execution.results.filter((result) => lexicalIds.has(result.note.id))
        : execution.results;
      const remaining = cursor
        ? ranked.filter((result) => hybridResultAfterCursor(result, cursor))
        : ranked;
      const hasNextPage = remaining.length > safeLimit;
      const results = hasNextPage ? remaining.slice(0, safeLimit) : remaining;
      const last = results.at(-1);
      return {
        results,
        searchMode: execution.searchMode,
        nextCursor:
          hasNextPage && last
            ? encodeCursor({
                version: 1,
                kind: "hybrid-search",
                fingerprint,
                score: last.score,
                createdAt: last.note.createdAt,
                id: last.note.id,
              } satisfies HybridSearchCursor)
            : null,
      };
    }
    return { ...(await this.#lexicalSearchNotes(vault, input)), searchMode: "exact" };
  }

  async searchNotesWithDeadline(
    vault: VaultContext,
    input: SearchNotesInput,
    timeoutMs: number,
  ): Promise<SearchNotesExecution> {
    const semanticTimeoutMs = Math.max(
      1,
      Math.min(DEFAULT_SEMANTIC_QUERY_TIMEOUT_MS, timeoutMs - 250),
    );
    if (!this.#encryptionKey) {
      return this.#searchNotesExecution(vault, input, semanticTimeoutMs);
    }
    return (this.#database as unknown as SqlcipherDatabase).withProgressDeadline(
      timeoutMs,
      () => this.#searchNotesExecution(vault, input, semanticTimeoutMs),
    );
  }

  async #lexicalSearchNotes(
    vault: VaultContext,
    input: SearchNotesInput,
  ): Promise<SearchNotesPage> {
    this.#assertVault(vault);
    if (input.query.length > MAX_RECALL_QUERY_CHARACTERS) {
      throw new MemoryError(
        "invalid_input",
        `Recall query cannot exceed ${MAX_RECALL_QUERY_CHARACTERS} characters`,
      );
    }
    const temporal = this.#queryTemporalAnnotations(input.query);
    if (temporal.length > 0) {
      const ranked = this.#rankTemporalResults(
        this.#allLexicalResults(vault, input.query),
        temporal,
      );
      const fingerprint = this.#temporalSearchFingerprint(input.query, temporal);
      const cursor = input.cursor
        ? decodeCursor<TemporalSearchCursor>(input.cursor, "temporal-search", fingerprint)
        : null;
      const safeLimit = boundedLimit(
        input.limit,
        DEFAULT_RECALL_RESULTS,
        MAX_RECALL_RESULTS,
      );
      const remaining = cursor
        ? ranked.filter((result) => hybridResultAfterCursor(result, cursor))
        : ranked;
      const hasNextPage = remaining.length > safeLimit;
      const results = hasNextPage ? remaining.slice(0, safeLimit) : remaining;
      const last = results.at(-1);
      return {
        results,
        nextCursor: hasNextPage && last
          ? encodeCursor({
              version: 1,
              kind: "temporal-search",
              fingerprint,
              score: last.score,
              createdAt: last.note.createdAt,
              id: last.note.id,
            } satisfies TemporalSearchCursor)
          : null,
      };
    }
    const ftsQuery = buildFtsQuery(input.query);
    const fingerprint = createHash("sha256")
      .update(ftsQuery ?? "")
      .digest("base64url");
    const cursor = input.cursor
      ? decodeCursor<SearchCursor>(input.cursor, "search", fingerprint)
      : null;
    if (!ftsQuery) return { results: [], nextCursor: null };
    const safeLimit = boundedLimit(
      input.limit,
      DEFAULT_RECALL_RESULTS,
      MAX_RECALL_RESULTS,
    );
    const rows = this.#database
      .query<
        SearchRow,
        [
          string,
          number | null,
          number | null,
          number | null,
          string | null,
          string | null,
          string | null,
          number,
        ]
      >(
        `with ranked as (
           select
             notes.id,
             notes.content,
             notes.current_revision,
             notes.source_json,
             notes.created_at,
             notes.updated_at,
             snippet(notes_fts, 0, '', '', ' … ', 24) as excerpt,
             bm25(notes_fts, 1.0, 0.35) as rank
           from notes_fts
           join notes on notes.rowid = notes_fts.rowid
           where notes_fts match ?
         )
         select * from ranked
         where (
           ? is null or rank > ? or
           (rank = ? and (created_at < ? or (created_at = ? and id < ?)))
         )
         order by rank asc, created_at desc, id desc
         limit ?`,
      )
      .all(
        ftsQuery,
        cursor?.rank ?? null,
        cursor?.rank ?? null,
        cursor?.rank ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        safeLimit + 1,
      );
    const hasNextPage = rows.length > safeLimit;
    const pageRows = hasNextPage ? rows.slice(0, safeLimit) : rows;
    const last = pageRows.at(-1);
    return {
      results: pageRows.map(searchRowToResult),
      nextCursor:
        hasNextPage && last
          ? encodeCursor({
              version: 1,
              kind: "search",
              fingerprint,
              rank: last.rank,
              createdAt: last.created_at,
              id: last.id,
            } satisfies SearchCursor)
          : null,
    };
  }

  async updateNote(
    vault: VaultContext,
    id: string,
    input: UpdateNoteInput,
  ): Promise<Note> {
    return this.#database.transaction(
      () => this.updateNoteInCurrentTransaction(vault, id, input),
    )();
  }

  updateNoteInCurrentTransaction(
    vault: VaultContext,
    id: string,
    input: UpdateNoteInput,
  ): Note {
    this.#assertVault(vault);
    if (!input.content.trim()) {
      throw new MemoryError("invalid_input", "Note content cannot be empty");
    }
    if (countCharacters(input.content) > MAX_NOTE_CHARACTERS) {
      throw new MemoryError(
        "invalid_input",
        `Note content cannot exceed ${MAX_NOTE_CHARACTERS} characters`,
      );
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new MemoryError(
        "invalid_input",
        "expectedRevision must be a positive integer",
      );
    }

    const current = this.#database
      .query<NoteRow, [string]>(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes
         where id = ?`,
      )
      .get(id);
    if (!current) throw new MemoryError("not_found", "Note was not found");
    if (current.current_revision !== input.expectedRevision) {
      throw new MemoryError(
        "conflict",
        `Note changed after revision ${input.expectedRevision}; reload before saving`,
      );
    }

    const revision = current.current_revision + 1;
    const updatedAt = this.#now().toISOString();
    const source =
      input.source === undefined
        ? parseSource(current.source_json)
        : normalizeSource(input.source ?? undefined);
    const sourceJson = source ? JSON.stringify(source) : null;
    if (input.content === current.content && sourceJson === current.source_json) {
      return rowToNote(current);
    }
    const sourceSearch = sourceSearchText(source);
    this.#database
      .query(
        `insert into note_revisions (
           note_id, revision, content, source_json, created_at
         ) values (?, ?, ?, ?, ?)`,
      )
      .run(id, revision, input.content, sourceJson, updatedAt);
    this.#database
      .query(
        `update notes
         set content = ?, current_revision = ?, source_json = ?, source_search = ?, updated_at = ?
         where id = ?`,
      )
      .run(input.content, revision, sourceJson, sourceSearch, updatedAt, id);
    const note = {
      id,
      content: input.content,
      revision,
      source,
      createdAt: current.created_at,
      updatedAt,
    };
    this.#derivedIndexes.replace(note);
    return note;
  }

  getNoteRevisionInCurrentTransaction(
    vault: VaultContext,
    id: string,
    revision: number,
  ): NoteRevision | null {
    this.#assertVault(vault);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new MemoryError("invalid_input", "Revision must be a positive integer");
    }
    const row = this.#database
      .query<RevisionRow, [string, number]>(
        `select note_id, revision, content, source_json, created_at
         from note_revisions
         where note_id = ? and revision = ?`,
      )
      .get(id, revision);
    return row
      ? {
          noteId: row.note_id,
          revision: row.revision,
          content: row.content,
          source: parseSource(row.source_json),
          createdAt: row.created_at,
        }
      : null;
  }

  async listNoteRevisions(
    vault: VaultContext,
    id: string,
    input: ListNoteRevisionsInput = {},
  ): Promise<NoteRevisionsPage> {
    this.#assertVault(vault);
    const fingerprint = createHash("sha256").update(id).digest("base64url");
    const cursor = input.cursor
      ? decodeCursor<RevisionsCursor>(input.cursor, "revisions", fingerprint)
      : null;
    const safeLimit = boundedLimit(input.limit, 20, 50);
    const rows = this.#database
      .query<RevisionRow, [string, number | null, number | null, number]>(
        `select note_id, revision, content, source_json, created_at
         from note_revisions
         where note_id = ? and (? is null or revision < ?)
         order by revision desc
         limit ?`,
      )
      .all(id, cursor?.revision ?? null, cursor?.revision ?? null, safeLimit + 1);
    const hasNextPage = rows.length > safeLimit;
    const pageRows = hasNextPage ? rows.slice(0, safeLimit) : rows;
    const revisions = pageRows.map((row) => ({
        noteId: row.note_id,
        revision: row.revision,
        content: row.content,
        source: parseSource(row.source_json),
        createdAt: row.created_at,
      }));
    const last = pageRows.at(-1);
    return {
      revisions,
      nextCursor:
        hasNextPage && last
          ? encodeCursor({
              version: 1,
              kind: "revisions",
              fingerprint,
              revision: last.revision,
              createdAt: last.created_at,
              id,
            } satisfies RevisionsCursor)
          : null,
    };
  }

  async forget(vault: VaultContext, id: string): Promise<boolean> {
    return this.#database.transaction(
      () => this.forgetInCurrentTransaction(vault, id),
    )();
  }

  forgetInCurrentTransaction(
    vault: VaultContext,
    id: string,
    expectedRevision?: number,
  ): boolean {
    this.#assertVault(vault);
    if (
      expectedRevision !== undefined &&
      (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    ) {
      throw new MemoryError(
        "invalid_input",
        "expectedRevision must be a positive integer",
      );
    }
    const result = expectedRevision === undefined
      ? this.#database.query("delete from notes where id = ?").run(id)
      : this.#database
          .query("delete from notes where id = ? and current_revision = ?")
          .run(id, expectedRevision);
    if (result.changes > 0) this.#derivedIndexes.remove();
    return result.changes > 0;
  }

  async waitForDerivedIndex(): Promise<void> {
    await this.#derivedIndexes.wait();
  }

  derivedIndexStatus(vault: VaultContext): DerivedIndexStatus {
    this.#assertVault(vault);
    return this.#derivedIndexes.status();
  }

  diagnosticSnapshot(vault: VaultContext): {
    schemaVersion: number;
    integrity: "ok" | "failed";
    noteCount: number;
    revisionCount: number;
    databaseBytes: number;
  } {
    this.#assertVault(vault);
    const schemaVersion = this.#database
      .query<SchemaVersionRow, []>("PRAGMA user_version;")
      .get()?.user_version ?? 0;
    const integrity = this.#database
      .query<{ quick_check: string }, []>("PRAGMA quick_check;")
      .get()?.quick_check === "ok" ? "ok" : "failed";
    const noteCount = this.#database
      .query<{ count: number }, []>("select count(*) as count from notes")
      .get()?.count ?? 0;
    const revisionCount = this.#database
      .query<{ count: number }, []>(
        "select count(*) as count from note_revisions",
      )
      .get()?.count ?? 0;
    const databaseBytes =
      this.#databasePath === ":memory:"
        ? 0
        : privateDatabaseBytes(this.#databasePath);
    return { schemaVersion, integrity, noteCount, revisionCount, databaseBytes };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#derivedIndexes.close();
    this.#semanticIndexCache = null;
    try {
      if (this.#ownsDatabase) this.#database.close();
    } finally {
      this.#encryptionKey?.fill(0);
    }
  }

  async #hybridRecall(
    vault: VaultContext,
    query: string,
    limit: number | null,
    semanticTimeoutMs: number,
    minimumSimilarity?: number,
  ): Promise<HybridRecallExecution> {
    this.#assertVault(vault);
    const model = this.#embeddingModel;
    if (!model) return { results: [], searchMode: "degraded" };
    const temporal = this.#queryTemporalAnnotations(query);
    const rawLexical = this.#allLexicalResults(vault, query);
    const lexical = strongRecallLexicalResults(
      query,
      rawLexical,
    );
    if (
      lexical.length === 0 &&
      temporal.length === 0 &&
      (isUnderspecifiedDeicticQuery(query) || requestsUnsavedLiveState(query))
    ) {
      return { results: [], searchMode: "hybrid" };
    }
    const indexState = this.derivedIndexStatus(vault).state;
    if (indexState !== "ready") {
      return {
        results: this.#limitedTemporalResults(rawLexical, temporal, limit),
        searchMode: indexState === "indexing" ? "indexing" : "degraded",
      };
    }

    let queryVector: Float32Array;
    try {
      [queryVector] = await withTimeout(
        model.embed([query + temporalEmbeddingContext(temporal)]),
        semanticTimeoutMs,
      );
      if (!queryVector) {
        return {
          results: this.#limitedTemporalResults(rawLexical, temporal, limit),
          searchMode: "degraded",
        };
      }
      validateEmbedding(queryVector, model.descriptor);
    } catch {
      return {
        results: this.#limitedTemporalResults(rawLexical, temporal, limit),
        searchMode: "degraded",
      };
    }

    const descriptor = model.descriptor;
    const queryMagnitude = vectorMagnitude(queryVector);
    let semanticIndex: SemanticIndexCache;
    try {
      semanticIndex = this.#semanticIndex(descriptor);
    } catch (error) {
      if (!isInterrupted(error)) throw error;
      return {
        results: this.#limitedTemporalResults(rawLexical, temporal, limit),
        searchMode: "degraded",
      };
    }
    const similarityThreshold = minimumSimilarity ?? model.minimumSimilarity;
    const nativeSimilarities = cosineSimilaritiesNative(
      queryVector,
      semanticIndex.packedVectors,
      semanticIndex.magnitudes,
    );
    const bestScores = new Float64Array(semanticIndex.noteCount);
    bestScores.fill(Number.NEGATIVE_INFINITY);
    const bestVectorIndexes = new Int32Array(semanticIndex.noteCount);
    bestVectorIndexes.fill(-1);
    for (let index = 0; index < semanticIndex.vectors.length; index += 1) {
      const candidate = semanticIndex.vectors[index]!;
      const querySimilarity = nativeSimilarities?.[index] ??
        cosineSimilarityWithMagnitudes(
          queryVector,
          queryMagnitude,
          candidate.vector,
          candidate.magnitude,
        );
      if (!Number.isFinite(querySimilarity) || querySimilarity < similarityThreshold) {
        continue;
      }
      const similarity = querySimilarity -
        SEMANTIC_HUBNESS_PENALTY * semanticIndex.corpusSimilarities[index]!;
      const noteOrdinal = semanticIndex.noteOrdinals[index]!;
      if (similarity > bestScores[noteOrdinal]!) {
        bestScores[noteOrdinal] = similarity;
        bestVectorIndexes[noteOrdinal] = index;
      }
    }
    let semanticCandidates: SemanticCandidate[] = [];
    for (let ordinal = 0; ordinal < bestVectorIndexes.length; ordinal += 1) {
      const vectorIndex = bestVectorIndexes[ordinal]!;
      if (vectorIndex < 0) continue;
      semanticCandidates.push({
        ...semanticIndex.vectors[vectorIndex]!,
        similarity: bestScores[ordinal]!,
      });
    }
    semanticCandidates.sort((left, right) => right.similarity - left.similarity);

    if (lexical.length === 0 && temporal.length === 0) {
      semanticCandidates = this.#withoutSupersededRevisionMatches(query, semanticCandidates);
    }
    const semantic = this.#hydrateSemanticCandidates(
      limit === null
        ? semanticCandidates
        : semanticCandidates.slice(0, MAX_RECALL_RESULTS),
    );

    const fused = new Map<string, { result: RecallResult; score: number }>();
    lexical.forEach((result, index) => {
      fused.set(result.note.id, {
        result,
        score: 2 + reciprocalRank(index),
      });
    });
    semantic.forEach((candidate, index) => {
      const note = rowToNote(candidate.row);
      const existing = fused.get(note.id);
      const result = existing?.result ?? semanticRowToResult(candidate.row, candidate.similarity);
      fused.set(note.id, {
        result,
        score:
          (existing?.score ?? 1) +
          reciprocalRank(index) +
          candidate.similarity * 0.01,
      });
    });

    const ranked = [...fused.values()]
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.result.note.createdAt.localeCompare(left.result.note.createdAt) ||
          right.result.note.id.localeCompare(left.result.note.id),
      )
      .map(({ result, score }) => ({ ...result, score }));
    const temporallyRanked = temporal.length > 0
      ? this.#rankTemporalResults(ranked, temporal)
      : ranked;
    return {
      results: limit === null
        ? temporallyRanked
        : temporallyRanked.slice(0, boundedLimit(limit, DEFAULT_RECALL_RESULTS, MAX_RECALL_RESULTS)),
      searchMode: "hybrid",
    };
  }

  #hydrateSemanticCandidates(
    candidates: readonly SemanticCandidate[],
  ): Array<{ row: HydratedEmbeddingRow; similarity: number }> {
    const statement = this.#database.query<NoteRow, [string]>(
      `select id, content, current_revision, source_json, created_at, updated_at
       from notes
       where id = ?`,
    );
    try {
      return candidates.flatMap((candidate) => {
        const note = statement.get(candidate.row.id);
        if (!note || note.current_revision !== candidate.row.current_revision) return [];
        return [{
          row: { ...note, ...candidate.row },
          similarity: candidate.similarity,
        }];
      });
    } finally {
      closePreparedStatement(statement);
    }
  }

  #semanticIndex(
    descriptor: TextEmbeddingModel["descriptor"],
  ): SemanticIndexCache {
    const modelKey = `${descriptor.id}\u0000${descriptor.revision}\u0000${descriptor.dimensions}`;
    if (this.#semanticIndexCache?.modelKey === modelKey) {
      return this.#semanticIndexCache;
    }

    const statement = this.#database.query<
      EmbeddingVectorRow,
      [string, string, number]
    >(
      `select
         notes.id,
         notes.current_revision,
         notes.created_at,
         notes.updated_at,
         embeddings.note_revision as embedding_revision,
         chunks.chunk_index,
         chunks.content_start,
         chunks.content_end,
         chunks.vector
       from note_embeddings embeddings
       join notes on notes.id = embeddings.note_id
       join note_embedding_chunks chunks on chunks.note_id = embeddings.note_id
       where embeddings.note_revision = notes.current_revision
         and embeddings.model_id = ?
         and embeddings.model_revision = ?
         and embeddings.dimensions = ?
       limit ${MAX_EMBEDDING_CHUNK_CANDIDATES}`,
    );
    let rows: EmbeddingVectorRow[];
    try {
      rows = statement.all(
        descriptor.id,
        descriptor.revision,
        descriptor.dimensions,
      );
    } finally {
      closePreparedStatement(statement);
    }
    const vectors = rows.flatMap(({ vector: bytes, ...row }) => {
      const vector = embeddingFromBytes(bytes, descriptor.dimensions);
      if (!vector) return [];
      const magnitude = vectorMagnitude(vector);
      if (!Number.isFinite(magnitude) || magnitude <= 0) return [];
      return [{ row, vector, magnitude }];
    });
    const centroid = embeddingCentroid(
      vectors.map((candidate) => candidate.vector),
      descriptor.dimensions,
    );
    const packedVectors = new Float32Array(
      vectors.length * descriptor.dimensions,
    );
    const magnitudes = new Float32Array(vectors.length);
    const corpusSimilarities = new Float64Array(vectors.length);
    const noteOrdinals = new Uint32Array(vectors.length);
    const noteOrdinalById = new Map<string, number>();
    vectors.forEach((candidate, index) => {
      packedVectors.set(candidate.vector, index * descriptor.dimensions);
      magnitudes[index] = candidate.magnitude;
      let noteOrdinal = noteOrdinalById.get(candidate.row.id);
      if (noteOrdinal === undefined) {
        noteOrdinal = noteOrdinalById.size;
        noteOrdinalById.set(candidate.row.id, noteOrdinal);
      }
      noteOrdinals[index] = noteOrdinal;
      corpusSimilarities[index] = centroid
        ? cosineSimilarityWithMagnitudes(
            centroid.vector,
            centroid.magnitude,
            candidate.vector,
            candidate.magnitude,
          )
        : 0;
    });
    const cache = {
      modelKey,
      vectors,
      packedVectors,
      magnitudes,
      corpusSimilarities,
      noteOrdinals,
      noteCount: noteOrdinalById.size,
    } satisfies SemanticIndexCache;
    this.#semanticIndexCache = cache;
    return cache;
  }

  #allLexicalResults(vault: VaultContext, query: string): RecallResult[] {
    this.#assertVault(vault);
    if (query.length > MAX_RECALL_QUERY_CHARACTERS) {
      throw new MemoryError(
        "invalid_input",
        `Recall query cannot exceed ${MAX_RECALL_QUERY_CHARACTERS} characters`,
      );
    }
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    return this.#database
      .query<SearchRow, [string]>(
        `select
           notes.id,
           notes.content,
           notes.current_revision,
           notes.source_json,
           notes.created_at,
           notes.updated_at,
           snippet(notes_fts, 0, '', '', ' … ', 24) as excerpt,
           bm25(notes_fts, 1.0, 0.35) as rank
         from notes_fts
         join notes on notes.rowid = notes_fts.rowid
         where notes_fts match ?
         order by rank asc, notes.created_at desc, notes.id desc
         limit ${MAX_RECALL_CANDIDATES}`,
      )
      .all(ftsQuery)
      .map(searchRowToResult);
  }

  #hybridSearchFingerprint(query: string): string {
    const status = this.derivedIndexStatus(this.vault);
    const hash = createHash("sha256")
      .update(query)
      .update("\0")
      .update(status.state)
      .update("\0")
      .update(String(status.indexedNotes));
    for (const annotation of this.#queryTemporalAnnotations(query)) {
      hash
        .update("\0")
        .update(annotation.rangeStart)
        .update("/")
        .update(annotation.rangeEnd);
    }
    const revisions = this.#database
      .query<{ id: string; current_revision: number }, []>(
        "select id, current_revision from notes order by id asc",
      )
      .all();
    for (const revision of revisions) {
      hash
        .update("\0")
        .update(revision.id)
        .update(":")
        .update(String(revision.current_revision));
    }
    return hash.digest("base64url");
  }

  #queryTemporalAnnotations(query: string): TemporalAnnotation[] {
    return resolveTemporalExpressions(query, {
      referenceTimestamp: this.#now().toISOString(),
      timeZone: this.#timeZone(),
    }).slice(0, MAX_TEMPORAL_ANNOTATIONS_PER_TEXT);
  }

  #temporalSearchFingerprint(
    query: string,
    annotations: readonly TemporalAnnotation[],
  ): string {
    const hash = createHash("sha256").update(query);
    for (const annotation of annotations) {
      hash.update("\0").update(annotation.rangeStart).update("/").update(annotation.rangeEnd);
    }
    const revisions = this.#database
      .query<{ id: string; current_revision: number }, []>(
        "select id, current_revision from notes order by id asc",
      )
      .all();
    for (const revision of revisions) {
      hash.update("\0").update(revision.id).update(":").update(String(revision.current_revision));
    }
    return hash.digest("base64url");
  }

  #limitedTemporalResults(
    lexical: readonly RecallResult[],
    temporal: readonly TemporalAnnotation[],
    limit: number | null,
  ): RecallResult[] {
    const ranked = temporal.length > 0
      ? this.#rankTemporalResults(lexical, temporal)
      : [...lexical];
    return limit === null
      ? ranked
      : ranked.slice(0, boundedLimit(limit, DEFAULT_RECALL_RESULTS, MAX_RECALL_RESULTS));
  }

  #rankTemporalResults(
    base: readonly RecallResult[],
    annotations: readonly TemporalAnnotation[],
  ): RecallResult[] {
    const candidates = new Map<string, RecallResult>();
    for (const annotation of annotations) {
      const statement = this.#database
        .query<NoteRow & { temporal_score: number }, [string, string, string, string, string, string]>(
          `select notes.id, notes.content, notes.current_revision, notes.source_json,
                  notes.created_at, notes.updated_at,
                  max(matches.temporal_score) as temporal_score
           from (
             select temporal.note_id, 5 as temporal_score
             from note_temporal_annotations temporal
             join note_temporal_index temporal_index
               on temporal_index.note_id = temporal.note_id
              and temporal_index.note_revision = temporal.note_revision
             where temporal.range_start < ? and temporal.range_end > ?
             union all
             select notes.id as note_id, 3 as temporal_score
             from notes
             where notes.created_at >= ? and notes.created_at < ?
             union all
             select temporal_index.note_id, 6 as temporal_score
             from note_temporal_index temporal_index
             where temporal_index.source_timestamp >= ?
               and temporal_index.source_timestamp < ?
           ) matches
           join notes on notes.id = matches.note_id
           group by notes.id
           order by temporal_score desc, notes.created_at desc, notes.id desc
           limit ${MAX_RECALL_CANDIDATES}`,
        );
      let rows: Array<NoteRow & { temporal_score: number }>;
      try {
        rows = statement.all(
          annotation.rangeEnd,
          annotation.rangeStart,
          annotation.rangeStart,
          annotation.rangeEnd,
          annotation.rangeStart,
          annotation.rangeEnd,
        );
      } finally {
        closePreparedStatement(statement);
      }
      for (const row of rows) {
        const note = rowToNote(row);
        const temporalScore = row.temporal_score;
        const existing = candidates.get(note.id);
        if (!existing || temporalScore > existing.score) {
          candidates.set(note.id, {
            note,
            citation: {
              noteId: note.id,
              revision: note.revision,
              excerpt: note.content.slice(0, 400),
              source: note.source,
              createdAt: note.createdAt,
            },
            score: temporalScore,
          });
        }
      }
    }
    const baseById = new Map(base.map((result) => [result.note.id, result]));
    return [...candidates.values()]
      .map((candidate) => {
        const matching = baseById.get(candidate.note.id);
        return matching
          ? {
              ...matching,
              score:
                TEMPORAL_TEXT_MATCH_BOOST +
                candidate.score +
                Math.max(0, matching.score) * 0.01,
            }
          : candidate;
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.note.createdAt.localeCompare(left.note.createdAt) ||
          right.note.id.localeCompare(left.note.id),
      );
  }

  #ensureTemporalIndexes(): void {
    const statement = this.#database
      .query<NoteRow & { indexed_timezone: string | null }, [number]>(
        `select notes.id, notes.content, notes.current_revision, notes.source_json,
                notes.created_at, notes.updated_at,
                temporal.timezone as indexed_timezone
         from notes
         left join note_temporal_index temporal on temporal.note_id = notes.id
         where temporal.note_id is null
            or temporal.note_revision != notes.current_revision
            or temporal.resolver_version != ?`,
      );
    let notes: Array<NoteRow & { indexed_timezone: string | null }>;
    try {
      notes = statement.all(TEMPORAL_RESOLVER_VERSION);
    } finally {
      closePreparedStatement(statement);
    }
    this.#database.transaction(() => {
      for (const row of notes) {
        this.#replaceTemporalIndex(
          rowToNote(row),
          row.indexed_timezone ?? this.#timeZone(),
          true,
        );
      }
    })();
  }

  #replaceTemporalIndex(
    note: Note,
    timeZone = this.#timeZone(),
    invalidateEmbedding = false,
  ): void {
    const annotations = resolveTemporalExpressions(note.content, {
      referenceTimestamp: note.updatedAt,
      timeZone,
    }).slice(0, MAX_TEMPORAL_ANNOTATIONS_PER_TEXT);
    const run = (sql: string, parameters: readonly SQLQueryBindings[]): void =>
      runDatabaseStatement(this.#database, sql, parameters);
    if (invalidateEmbedding) {
      this.#semanticIndexCache = null;
      run("delete from note_embedding_chunks where note_id = ?", [note.id]);
      run("delete from note_embeddings where note_id = ?", [note.id]);
    }
    run("delete from note_temporal_annotations where note_id = ?", [note.id]);
    run("delete from note_temporal_index where note_id = ?", [note.id]);
    run(
      `insert into note_temporal_index (
           note_id, note_revision, reference_timestamp, source_timestamp,
           timezone, resolver_version, indexed_at
         ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        note.id,
        note.revision,
        note.updatedAt,
        note.source?.timestamp ?? null,
        timeZone,
        TEMPORAL_RESOLVER_VERSION,
        this.#now().toISOString(),
      ],
    );
    annotations.forEach((annotation, index) => {
      run(
        `insert into note_temporal_annotations (
           note_id, annotation_index, note_revision, original_phrase,
           expression_start, expression_end, range_start, range_end, confidence
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          note.id,
          index,
          note.revision,
          annotation.phrase,
          annotation.start,
          annotation.end,
          annotation.rangeStart,
          annotation.rangeEnd,
          annotation.confidence,
        ],
      );
    });
  }

  #noteTemporalAnnotations(noteId: string): TemporalAnnotation[] {
    const statement = this.#database.query<{
        original_phrase: string;
        expression_start: number;
        expression_end: number;
        range_start: string;
        range_end: string;
        reference_timestamp: string;
        timezone: string;
        resolver_version: number;
        confidence: number;
      }, [string]>(
        `select annotations.original_phrase, annotations.expression_start,
                annotations.expression_end, annotations.range_start,
                annotations.range_end, temporal.reference_timestamp,
                temporal.timezone, temporal.resolver_version,
                annotations.confidence
         from note_temporal_annotations annotations
         join note_temporal_index temporal on temporal.note_id = annotations.note_id
         join notes on notes.id = annotations.note_id
         where annotations.note_id = ?
           and annotations.note_revision = notes.current_revision
           and temporal.note_revision = notes.current_revision
         order by annotations.annotation_index asc`,
      );
    let rows: Array<{
      original_phrase: string;
      expression_start: number;
      expression_end: number;
      range_start: string;
      range_end: string;
      reference_timestamp: string;
      timezone: string;
      resolver_version: number;
      confidence: number;
    }>;
    try {
      rows = statement.all(noteId);
    } finally {
      closePreparedStatement(statement);
    }
    return rows.map((row) => ({
        phrase: row.original_phrase,
        start: row.expression_start,
        end: row.expression_end,
        rangeStart: row.range_start,
        rangeEnd: row.range_end,
        referenceTimestamp: row.reference_timestamp,
        timeZone: row.timezone,
        resolverVersion: row.resolver_version,
        confidence: row.confidence,
      }));
  }

  #missingEmbeddingNotes(): readonly Note[] {
    if (!this.#embeddingModel) return [];
    const descriptor = this.#embeddingModel.descriptor;
    return this.#database
      .query<NoteRow, [string, string, number]>(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes
         where not exists (
           select 1 from note_embeddings embeddings
           where embeddings.note_id = notes.id
             and embeddings.note_revision = notes.current_revision
             and embeddings.model_id = ?
             and embeddings.model_revision = ?
             and embeddings.dimensions = ?
             and embeddings.chunk_count = (
               select count(*) from note_embedding_chunks chunks
               where chunks.note_id = embeddings.note_id
             )
         )
         order by created_at asc, id asc`,
      )
      .all(descriptor.id, descriptor.revision, descriptor.dimensions)
      .map(rowToNote);
  }

  #noteCount(): number {
    return this.#database
      .query<{ count: number }, []>("select count(*) as count from notes")
      .get()?.count ?? 0;
  }

  #indexedEmbeddingCount(): number {
    const model = this.#embeddingModel;
    if (!model) return 0;
    const descriptor = model.descriptor;
    return this.#database
      .query<{ count: number }, [string, string, number]>(
        `select count(*) as count
         from note_embeddings embeddings
         join notes on notes.id = embeddings.note_id
         where embeddings.note_revision = notes.current_revision
           and embeddings.model_id = ?
           and embeddings.model_revision = ?
           and embeddings.dimensions = ?
           and embeddings.chunk_count = (
             select count(*) from note_embedding_chunks chunks
             where chunks.note_id = embeddings.note_id
           )`,
      )
      .get(descriptor.id, descriptor.revision, descriptor.dimensions)?.count ?? 0;
  }

  #rebuildSmartViews(): void {
    const notes = this.#database
      .query<NoteRow, []>(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes`,
      )
      .all()
      .map(rowToNote);
    this.#database.transaction(() => {
      this.#database.query("delete from note_smart_views").run();
      for (const note of notes) this.#replaceSmartViewAssignments(note);
    })();
  }

  #replaceSmartViewAssignments(note: Note): void {
    this.#database
      .query("delete from note_smart_views where note_id = ?")
      .run(note.id);
    const insert = this.#database.query(
      `insert into note_smart_views (note_id, view_id, note_revision, assigned_at)
       values (?, ?, ?, ?)`,
    );
    for (const viewId of deriveSystemSmartViewIds(note)) {
      insert.run(note.id, viewId, note.revision, note.updatedAt);
    }
  }

  #organizationFacetSummaries(
    kind: OrganizationFacetKind,
    limit: number,
    minimumCount = 1,
  ): OrganizationFacetSummary[] {
    return this.#database
      .query<OrganizationFacetRow, [OrganizationFacetKind, number, number]>(
        `select facets.facet_key, min(facets.facet_label) as facet_label,
                count(distinct facets.note_id) as note_count
         from note_organization_facets facets
         where facets.facet_kind = ?
         group by facets.facet_key
         having count(distinct facets.note_id) >= ?
         order by note_count desc, facet_label collate nocase asc
         limit ?`,
      )
      .all(kind, minimumCount, limit)
      .map((row) => ({
        key: row.facet_key,
        label: row.facet_label,
        noteCount: row.note_count,
      }));
  }

  #dateRangeNoteCount(start: string | null, end: string | null): number {
    return this.#database
      .query<
        { count: number },
        [string | null, string | null, string | null, string | null]
      >(
        `select count(*) as count
         from notes
         where (? is null or created_at >= ?)
           and (? is null or created_at < ?)`,
      )
      .get(start, start, end, end)?.count ?? 0;
  }

  #rebuildOrganization(): void {
    const notes = this.#database
      .query<NoteRow, []>(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes`,
      )
      .all()
      .map(rowToNote);
    this.#database.transaction(() => {
      this.#database.query("delete from note_organization_facets").run();
      this.#database.query("delete from note_organization").run();
      for (const note of notes) this.#replaceOrganizationAssignments(note);
    })();
  }

  #replaceOrganizationAssignments(note: Note): void {
    const organization = deriveNoteOrganization(note);
    this.#database
      .query("delete from note_organization_facets where note_id = ?")
      .run(note.id);
    this.#database
      .query("delete from note_organization where note_id = ?")
      .run(note.id);
    this.#database
      .query(
        `insert into note_organization (
           note_id, note_revision, compact_label, indexed_at
         ) values (?, ?, ?, ?)`,
      )
      .run(note.id, note.revision, organization.label, note.updatedAt);
    const insertFacet = this.#database.query(
      `insert into note_organization_facets (
         note_id, facet_kind, facet_key, facet_label, note_revision
       ) values (?, ?, ?, ?, ?)`,
    );
    for (const [kind, labels] of [
      ["people", organization.people],
      ["sources", organization.sources],
      ["topics", organization.topics],
    ] as const) {
      for (const label of labels) {
        insertFacet.run(
          note.id,
          kind,
          organizationFacetKey(label),
          label,
          note.revision,
        );
      }
    }
  }

  async #indexEmbeddingBatch(
    notes: readonly Note[],
    reportError: (error: unknown) => void,
  ): Promise<void> {
    const model = this.#embeddingModel;
    if (!model || this.#closed || notes.length === 0) return;
    const slicesByNote = notes.map((note) => {
      const annotations = this.#noteTemporalAnnotations(note.id);
      return embeddingSlices(note.content, annotations).map((slice) => ({
        ...slice,
        embeddingContent:
          slice.content +
          temporalEmbeddingContext(
            annotations.filter((annotation) =>
              annotation.start >= slice.start && annotation.end <= slice.end),
          ) +
          sourceEmbeddingContext(note.source),
      }));
    });
    const slices = slicesByNote.flat();
    const vectors = await embedWithRetries(
      model,
      slices.map((slice) => slice.embeddingContent),
      () => this.#closed,
      reportError,
    );
    if (vectors.length !== slices.length) {
      throw new Error(
        `Embedding model ${model.descriptor.id} returned ${vectors.length} vectors for ${slices.length} chunks`,
      );
    }
    vectors.forEach((vector) => validateEmbedding(vector, model.descriptor));
    if (this.#closed) return;
    const descriptor = model.descriptor;
    const currentRevisionStatement = this.#database.query<
      { current_revision: number },
      [string]
    >("select current_revision from notes where id = ?");
    const upsert = this.#database.query(
      `insert into note_embeddings (
         note_id, note_revision, model_id, model_revision,
         dimensions, chunk_count, indexed_at
       ) values (?, ?, ?, ?, ?, ?, ?)
       on conflict(note_id) do update set
         note_revision = excluded.note_revision,
         model_id = excluded.model_id,
         model_revision = excluded.model_revision,
         dimensions = excluded.dimensions,
         chunk_count = excluded.chunk_count,
         indexed_at = excluded.indexed_at`,
    );
    const deleteChunks = this.#database.query(
      "delete from note_embedding_chunks where note_id = ?",
    );
    const insertChunk = this.#database.query(
      `insert into note_embedding_chunks (
         note_id, chunk_index, content_start, content_end, vector
       ) values (?, ?, ?, ?, ?)`,
    );
    const indexedAt = new Date().toISOString();
    let vectorOffset = 0;
    this.#database.transaction(() => {
      notes.forEach((note, index) => {
        const noteSlices = slicesByNote[index]!;
        const currentRevision = currentRevisionStatement.get(note.id)?.current_revision;
        if (currentRevision !== note.revision) {
          vectorOffset += noteSlices.length;
          return;
        }
        upsert.run(
          note.id,
          note.revision,
          descriptor.id,
          descriptor.revision,
          descriptor.dimensions,
          noteSlices.length,
          indexedAt,
        );
        deleteChunks.run(note.id);
        noteSlices.forEach((slice, chunkIndex) => {
          insertChunk.run(
            note.id,
            chunkIndex,
            slice.start,
            slice.end,
            embeddingBytes(vectors[vectorOffset + chunkIndex]!),
          );
        });
        vectorOffset += noteSlices.length;
      });
    })();
  }

  #assertVault(vault: VaultContext): void {
    if (!vaultContextsEqual(vault, this.vault)) {
      throw new MemoryError(
        "unauthorized",
        "Vault context does not match this memory service",
      );
    }
  }

  #withoutSupersededRevisionMatches<
    T extends { row: { id: string; current_revision: number } },
  >(
    query: string,
    candidates: readonly T[],
  ): T[] {
    const tokens = meaningfulQueryTokens(query);
    if (tokens.length < 2 || candidates.length === 0) return [...candidates];
    const statement = this.#database.query<{ content: string }, [string]>(
      `select revisions.content
       from note_revisions revisions
       join notes on notes.id = revisions.note_id
       where revisions.note_id = ? and revisions.revision < notes.current_revision`,
    );
    try {
      const retained: T[] = [];
      for (const candidate of candidates) {
        const matchesSupersededRevision = candidate.row.current_revision > 1 &&
          statement.all(candidate.row.id).some((row) => {
            const contentTokens = new Set(normalizedTextTokens(row.content));
            return tokens.every((token) => contentTokens.has(token));
          });
        if (!matchesSupersededRevision) retained.push(candidate);
      }
      return retained;
    } finally {
      closePreparedStatement(statement);
    }
  }

  #nextCreatedAt(): string {
    const latest = this.#database
      .query<{ created_at: string | null }, []>(
        `select created_at
         from notes
         order by created_at desc, id desc
         limit 1`,
      )
      .get()?.created_at;
    const latestTime = latest ? Date.parse(latest) : Number.NaN;
    return new Date(
      Math.max(this.#now().valueOf(), Number.isFinite(latestTime) ? latestTime + 1 : 0),
    ).toISOString();
  }

  exportInterchange(
    vault: VaultContext,
    destinationPath: string,
    applicationVersion: string,
    assertCanContinue: () => void = () => {},
  ): void {
    this.#assertVault(vault);
    assertCanContinue();
    this.#database.transaction(() => {
      const noteCount = this.#database
        .query<{ count: number }, []>("select count(*) as count from notes")
        .get()?.count ?? 0;
      const revisionCount = this.#database
        .query<{ count: number }, []>(
          "select count(*) as count from note_revisions",
        )
        .get()?.count ?? 0;
      if (noteCount > MAX_INTERCHANGE_NOTES) {
        throw new Error(`Interchange cannot exceed ${MAX_INTERCHANGE_NOTES} notes`);
      }
      if (revisionCount > MAX_INTERCHANGE_REVISIONS) {
        throw new Error(
          `Interchange cannot exceed ${MAX_INTERCHANGE_REVISIONS} revisions`,
        );
      }
      const noteStatement = this.#database.query<NoteRow, []>(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes
         order by id asc`,
      );
      const revisionStatement = this.#database.query<RevisionRow, [string]>(
        `select note_id, revision, content, source_json, created_at
         from note_revisions
         where note_id = ?
         order by revision asc`,
      );
      const streamNotes = function* (): Iterable<StreamingInterchangeNote> {
        for (const row of noteStatement.iterate()) {
          assertCanContinue();
          const revisions = function* () {
            for (const revision of revisionStatement.iterate(row.id)) {
              assertCanContinue();
              yield {
                noteId: revision.note_id,
                revision: revision.revision,
                content: revision.content,
                source: parseSource(revision.source_json),
                createdAt: revision.created_at,
              };
            }
          };
          yield {
            id: row.id,
            currentRevision: row.current_revision,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            revisions,
          };
        }
      };
      writeInterchange(
        destinationPath,
        streamNotes,
        noteCount,
        revisionCount,
        applicationVersion,
        assertCanContinue,
      );
    })();
  }

  exportMarkdown(
    vault: VaultContext,
    destinationPath: string,
    applicationVersion: string,
    assertCanContinue: () => void = () => {},
  ): void {
    this.#assertVault(vault);
    assertCanContinue();
    this.#database.transaction(() => {
      const noteCount = this.#database
        .query<{ count: number }, []>("select count(*) as count from notes")
        .get()?.count ?? 0;
      if (noteCount > MAX_MARKDOWN_EXPORT_NOTES) {
        throw new Error(
          `Markdown export cannot exceed ${MAX_MARKDOWN_EXPORT_NOTES} notes`,
        );
      }
      const noteStatement = this.#database.query<NoteRow, []>(
        `select id, content, current_revision, source_json, created_at, updated_at
         from notes
         order by id asc`,
      );
      const streamNotes = function* (): Iterable<MarkdownExportNote> {
        for (const row of noteStatement.iterate()) {
          assertCanContinue();
          yield {
            id: row.id,
            revision: row.current_revision,
            content: row.content,
            source: parseSource(row.source_json),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        }
      };
      writeMarkdownExport(
        destinationPath,
        streamNotes,
        noteCount,
        applicationVersion,
        assertCanContinue,
      );
    })();
  }

  static restoreInterchange(
    interchangePath: string,
    databasePath: string,
    vault: VaultContext,
    currentApplicationVersion: string,
    options: {
      encryptionKey?: Uint8Array;
      temporaryDirectoryPath?: string;
      beforePublish?: (temporaryDatabasePath: string) => void;
    } = {},
  ): void {
    const document = readInterchange(
      interchangePath,
      currentApplicationVersion,
    );
    if (pathEntryExists(databasePath)) {
      throw new Error(`Restore requires a clean vault path: ${databasePath}`);
    }

    const parent = dirname(databasePath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporaryDirectory = options.temporaryDirectoryPath ??
      mkdtempSync(join(parent, ".afternote-restore-"));
    if (options.temporaryDirectoryPath) {
      mkdirSync(temporaryDirectory, { mode: 0o700 });
    }
    const temporaryDatabasePath = join(temporaryDirectory, "vault.db");
    let restored: SqliteMemory | undefined;
    let published = false;
    try {
      restored = new SqliteMemory(temporaryDatabasePath, vault, {
        encryptionKey: options.encryptionKey,
      });
      restored.#importInterchange(document.notes);
      restored.close();
      restored = undefined;
      const verification = openDatabase(temporaryDatabasePath, options.encryptionKey, {
        readonly: true,
      });
      try {
        const integrity = verification
          .query<{ quick_check: string }, []>("PRAGMA quick_check;")
          .get()?.quick_check;
        const noteCount = verification
          .query<{ count: number }, []>("select count(*) as count from notes")
          .get()?.count;
        const revisionCount = verification
          .query<{ count: number }, []>(
            "select count(*) as count from note_revisions",
          )
          .get()?.count;
        if (
          integrity !== "ok" ||
          noteCount !== document.manifest.noteCount ||
          revisionCount !== document.manifest.revisionCount
        ) {
          throw new Error("Restored vault failed integrity validation");
        }
      } finally {
        verification.close();
      }
      chmodSync(temporaryDatabasePath, 0o600);
      options.beforePublish?.(temporaryDatabasePath);
      linkSync(temporaryDatabasePath, databasePath);
      published = true;
      syncDirectory(parent);
    } catch (error) {
      restored?.close();
      if (published) rmSync(databasePath, { force: true });
      throw error;
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  #migrate(databasePath: string): void {
    const currentVersion = this.#database
      .query<SchemaVersionRow, []>("PRAGMA user_version;")
      .get()?.user_version ?? 0;

    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new MemoryError(
        "incompatible_schema",
        `This Afternote build cannot open newer schema version ${currentVersion}; ` +
          `it supports up to version ${CURRENT_SCHEMA_VERSION}.`,
      );
    }

    if (
      databasePath !== ":memory:" &&
      currentVersion > 0 &&
      currentVersion < CURRENT_SCHEMA_VERSION
    ) {
      this.#ensurePreMigrationBackup(databasePath, currentVersion);
    }

    for (const migration of SCHEMA_MIGRATIONS) {
      if (migration.version <= currentVersion) continue;

      this.#database.transaction(() => {
        migration.prepare?.(this.#database);
        this.#database.exec(migration.sql);
        this.#database.exec(`PRAGMA user_version = ${migration.version};`);
      })();
    }
  }

  #importInterchange(notes: InterchangeNote[]): void {
    this.#database.transaction(() => {
      const existing = this.#database
        .query<{ count: number }, []>("select count(*) as count from notes")
        .get()?.count;
      if (existing !== 0) {
        throw new Error("Restore requires an empty temporary vault");
      }
      for (const note of notes) {
        const current = note.revisions.find(
          (revision) => revision.revision === note.currentRevision,
        );
        if (!current) {
          throw new Error(`Note ${note.id} is missing its current revision`);
        }
        this.#database
          .query(
            `insert into notes (
               id, content, current_revision, source_json, source_search, created_at, updated_at
             ) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            note.id,
            current.content,
            note.currentRevision,
            current.source ? JSON.stringify(current.source) : null,
            sourceSearchText(current.source),
            note.createdAt,
            note.updatedAt,
          );
        for (const revision of note.revisions) {
          this.#database
            .query(
              `insert into note_revisions (
                 note_id, revision, content, source_json, created_at
               ) values (?, ?, ?, ?, ?)`,
            )
            .run(
              note.id,
              revision.revision,
              revision.content,
              revision.source ? JSON.stringify(revision.source) : null,
              revision.createdAt,
            );
        }
      }
    })();
  }

  #ensurePreMigrationBackup(databasePath: string, schemaVersion: number): void {
    const previousUmask = process.umask(0o077);
    let temporaryDirectory: string | undefined;
    let backupPath: string | undefined;
    let published = false;
    try {
      temporaryDirectory = mkdtempSync(
        join(dirname(databasePath), ".afternote-migration-"),
      );
      const temporaryBackupPath = join(temporaryDirectory, "backup.db");
      if (this.#encryptionKey) {
        const backup = openDatabase(temporaryBackupPath, this.#encryptionKey, {
          create: true,
        });
        try {
          (this.#database as unknown as SqlcipherDatabase).backupTo(
            backup as unknown as SqlcipherDatabase,
          );
        } finally {
          backup.close();
        }
      } else {
        this.#database.query("VACUUM INTO ?").run(temporaryBackupPath);
      }
      chmodSync(temporaryBackupPath, 0o600);
      assertMigrationBackup(temporaryBackupPath, schemaVersion, this.#encryptionKey);
      const fingerprint = hashFile(temporaryBackupPath);
      backupPath =
        `${databasePath}.pre-migration-v${schemaVersion}-${fingerprint}.db`;
      if (pathEntryExists(backupPath)) {
        assertMigrationBackup(backupPath, schemaVersion, this.#encryptionKey);
        if (hashFile(backupPath) !== fingerprint) {
          throw new Error("Pre-migration backup fingerprint mismatch");
        }
        return;
      }
      renameSync(temporaryBackupPath, backupPath);
      published = true;
      assertMigrationBackup(backupPath, schemaVersion, this.#encryptionKey);
    } catch (error) {
      if (published && backupPath) rmSync(backupPath, { force: true });
      throw new MemoryError(
        "unavailable",
        "Could not create a verified pre-migration vault backup",
        { cause: error },
      );
    } finally {
      if (temporaryDirectory) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      process.umask(previousUmask);
    }
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hashFile(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function assertMigrationBackup(
  path: string,
  schemaVersion: number,
  encryptionKey?: Uint8Array,
): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Pre-migration backup must be a regular file");
  }
  if (process.platform !== "win32") {
    if ((info.mode & 0o077) !== 0) {
      throw new Error("Pre-migration backup permissions must be 0600 or stricter");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error("Pre-migration backup must be owned by the current user");
    }
  }

  const backup = openDatabase(path, encryptionKey, { readonly: true });
  try {
    const version = backup
      .query<SchemaVersionRow, []>("PRAGMA user_version;")
      .get()?.user_version ?? 0;
    const integrity = backup
      .query<{ quick_check: string }, []>("PRAGMA quick_check;")
      .get()?.quick_check;
    if (version !== schemaVersion || integrity !== "ok") {
      throw new Error("Pre-migration backup verification failed");
    }
  } finally {
    backup.close();
  }
}

function openDatabase(
  path: string,
  encryptionKey: Uint8Array | undefined,
  options: { create?: boolean; readonly?: boolean },
): Database {
  if (!encryptionKey) return new Database(path, options);
  return new SqlcipherDatabase(path, {
    key: encryptionKey,
    readonly: options.readonly,
  }) as unknown as Database;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    content: row.content,
    revision: row.current_revision,
    source: parseSource(row.source_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function searchRowToResult(row: SearchRow): RecallResult {
  const note = rowToNote(row);
  return {
    note,
    citation: {
      noteId: note.id,
      revision: note.revision,
      excerpt: row.excerpt,
      source: note.source,
      createdAt: note.createdAt,
    },
    score: -row.rank,
  };
}

function semanticRowToResult(
  row: HydratedEmbeddingRow,
  score: number,
): RecallResult {
  const note = rowToNote(row);
  const excerpt = note.content.slice(row.content_start, row.content_end);
  return {
    note,
    citation: {
      noteId: note.id,
      revision: note.revision,
      excerpt,
      source: note.source,
      createdAt: note.createdAt,
    },
    score,
  };
}

function embeddingCentroid(
  vectors: readonly Float32Array[],
  dimensions: number,
): VectorWithMagnitude | null {
  if (vectors.length === 0) return null;
  const centroid = new Float32Array(dimensions);
  for (const vector of vectors) {
    for (let index = 0; index < dimensions; index += 1) {
      centroid[index] += vector[index]! / vectors.length;
    }
  }
  const magnitude = vectorMagnitude(centroid);
  return Number.isFinite(magnitude) && magnitude > 0
    ? { vector: centroid, magnitude }
    : null;
}

function vectorMagnitude(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}

function cosineSimilarityWithMagnitudes(
  left: Float32Array,
  leftMagnitude: number,
  right: Float32Array,
  rightMagnitude: number,
): number {
  if (
    left.length === 0 ||
    left.length !== right.length ||
    leftMagnitude === 0 ||
    rightMagnitude === 0
  ) {
    return Number.NaN;
  }
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
  }
  return dot / (leftMagnitude * rightMagnitude);
}

function hybridResultAfterCursor(
  result: RecallResult,
  cursor: Pick<HybridSearchCursor, "score" | "createdAt" | "id">,
): boolean {
  return (
    result.score < cursor.score ||
    (result.score === cursor.score &&
      (result.note.createdAt < cursor.createdAt ||
        (result.note.createdAt === cursor.createdAt && result.note.id < cursor.id)))
  );
}

type EmbeddingSlice = { content: string; start: number; end: number };

function embeddingSlices(
  content: string,
  protectedRanges: readonly Pick<TemporalAnnotation, "start" | "end">[] = [],
): EmbeddingSlice[] {
  const slices: EmbeddingSlice[] = [];
  let start = 0;
  while (start < content.length) {
    const nominalContent = Array.from(content.slice(start))
      .slice(0, EMBEDDING_CHUNK_CHARACTERS)
      .join("");
    let end = start + nominalContent.length;
    for (const range of protectedRanges) {
      if (range.start < end && range.end > end) end = Math.max(end, range.end);
    }
    slices.push({ content: content.slice(start, end), start, end });
    start = end;
  }
  return slices;
}

async function embedWithRetries(
  model: TextEmbeddingModel,
  texts: readonly string[],
  stopped: () => boolean,
  onImmediateAttemptsExhausted: (error: unknown) => void,
): Promise<Float32Array[]> {
  let lastError: unknown;
  const maximumAttempts = EMBEDDING_ATTEMPTS + EMBEDDING_DELAYED_ATTEMPTS;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (stopped()) return [];
    try {
      return await model.embed(texts);
    } catch (error) {
      lastError = error;
      if (attempt === EMBEDDING_ATTEMPTS) {
        onImmediateAttemptsExhausted(error);
      }
      if (attempt < EMBEDDING_ATTEMPTS) {
        await Bun.sleep(25 * attempt);
      } else if (attempt < maximumAttempts) {
        await Bun.sleep(
          EMBEDDING_RETRY_BASE_DELAY_MS *
            2 ** (attempt - EMBEDDING_ATTEMPTS),
        );
      }
    }
  }
  throw lastError;
}

function reciprocalRank(index: number): number {
  return 1 / (60 + index + 1);
}

async function withTimeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Local semantic query timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isInterrupted(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("interrupted");
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) {
    throw new MemoryError("invalid_input", "limit must be a finite number");
  }
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

function closePreparedStatement(statement: object): void {
  const candidate = statement as { finalize?: () => void; close?: () => void };
  if (typeof candidate.finalize === "function") candidate.finalize();
  else candidate.close?.();
}

function runDatabaseStatement(
  database: Database,
  sql: string,
  parameters: readonly SQLQueryBindings[],
): void {
  const candidate = database as unknown as {
    run?: (sql: string, parameters: readonly SQLQueryBindings[]) => unknown;
  };
  if (typeof candidate.run === "function") {
    candidate.run(sql, parameters);
    return;
  }
  const statement = database.query(sql);
  try {
    statement.run(...parameters);
  } finally {
    closePreparedStatement(statement);
  }
}

function encodeCursor(
  cursor: BrowseCursor | SearchCursor | HybridSearchCursor | TemporalSearchCursor | RevisionsCursor,
): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor<
  T extends BrowseCursor | SearchCursor | HybridSearchCursor | TemporalSearchCursor | RevisionsCursor,
>(
  encoded: string,
  kind: T["kind"],
  fingerprint: T["fingerprint"],
): T {
  if (!encoded || encoded.length > 2_000) {
    throw new MemoryError("invalid_input", "Cursor is invalid");
  }
  try {
    const cursor = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<T>;
    if (
      cursor.version !== 1 ||
      cursor.kind !== kind ||
      cursor.fingerprint !== fingerprint ||
      typeof cursor.createdAt !== "string" ||
      typeof cursor.id !== "string" ||
      (kind === "search" &&
        (typeof (cursor as Partial<SearchCursor>).rank !== "number" ||
          !Number.isFinite((cursor as Partial<SearchCursor>).rank))) ||
      ((kind === "hybrid-search" || kind === "temporal-search") &&
        (typeof (cursor as Partial<HybridSearchCursor>).score !== "number" ||
          !Number.isFinite((cursor as Partial<HybridSearchCursor>).score))) ||
      (kind === "revisions" &&
        (typeof (cursor as Partial<RevisionsCursor>).revision !== "number" ||
          !Number.isInteger((cursor as Partial<RevisionsCursor>).revision)))
    ) {
      throw new Error("Cursor fields are invalid");
    }
    return cursor as T;
  } catch (error) {
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(
      "invalid_input",
      kind === "search"
        ? "Cursor does not match this search"
        : kind === "hybrid-search" || kind === "temporal-search"
          ? "Hybrid search cursor does not match this query"
        : kind === "revisions"
          ? "Cursor does not match this revision history"
          : "Browse cursor is invalid",
      { cause: error },
    );
  }
}

function normalizeSource(source: SourceContext | undefined): SourceContext | null {
  if (!source) return null;
  const maximumLengths: Record<keyof SourceContext, number> = {
    application: MAX_SOURCE_APPLICATION_CHARACTERS,
    url: MAX_SOURCE_URL_CHARACTERS,
    author: MAX_SOURCE_AUTHOR_CHARACTERS,
    timestamp: MAX_SOURCE_TIMESTAMP_CHARACTERS,
    label: MAX_SOURCE_LABEL_CHARACTERS,
  };
  const normalized: SourceContext = {};
  for (const key of Object.keys(maximumLengths) as Array<keyof SourceContext>) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new MemoryError("invalid_input", `source.${key} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (countCharacters(trimmed) > maximumLengths[key]) {
      throw new MemoryError(
        "invalid_input",
        `source.${key} cannot exceed ${maximumLengths[key]} characters`,
      );
    }
    if (key === "timestamp") {
      const timestamp = normalizeSourceTimestamp(trimmed);
      if (!timestamp) {
        throw new MemoryError(
          "invalid_input",
          "source.timestamp must be an ISO-8601 timestamp with a timezone",
        );
      }
      normalized.timestamp = timestamp;
    } else {
      normalized[key] = trimmed;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function parseSource(value: string | null): SourceContext | null {
  if (!value) return null;
  return JSON.parse(value) as SourceContext;
}

function sourceSearchText(source: SourceContext | null): string | null {
  if (!source) return null;
  const values = [
    source.application,
    source.url,
    source.author,
    source.timestamp,
    source.label,
  ].filter((value): value is string => value !== undefined);
  return values.length > 0 ? values.join(" ") : null;
}

function sourceEmbeddingContext(source: SourceContext | null): string {
  if (!source) return "";
  const fields = [
    source.application ? `Source application: ${source.application}.` : null,
    source.author ? `Source author: ${source.author}.` : null,
    source.label ? `Source label: ${source.label}.` : null,
    source.timestamp ? `Source timestamp: ${source.timestamp}.` : null,
  ].filter((field): field is string => field !== null);
  return fields.length > 0 ? `\n\n[Afternote metadata: ${fields.join(" ")}]` : "";
}

function buildFtsQuery(query: string): string | null {
  const meaningfulTokens = meaningfulQueryTokens(query);
  if (meaningfulTokens.length === 0) return null;
  return meaningfulTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function meaningfulQueryTokens(query: string): string[] {
  const tokens = normalizedTextTokens(query);
  return [...new Set(tokens)]
    .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token))
    .slice(0, 32);
}

function normalizedTextTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function strongRecallLexicalResults(
  query: string,
  results: readonly RecallResult[],
): RecallResult[] {
  const queryTokens = meaningfulQueryTokens(query);
  const minimumMatches = Math.min(2, queryTokens.length);
  if (minimumMatches < 2) return [...results];
  return results.filter((result) => {
    const searchable = new Set(normalizedTextTokens([
      result.note.content,
      sourceSearchText(result.note.source),
    ].filter((value): value is string => Boolean(value)).join(" ")));
    return queryTokens.filter((token) => searchable.has(token)).length >= minimumMatches;
  });
}

function isUnderspecifiedDeicticQuery(query: string): boolean {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.some((word) => ["this", "that", "these", "those", "it"].includes(word))) {
    return false;
  }
  const generic = new Set([
    "about",
    "app",
    "application",
    "did",
    "does",
    "is",
    "it",
    "memory",
    "note",
    "recorded",
    "source",
    "that",
    "these",
    "thing",
    "this",
    "those",
    "was",
    "what",
    "which",
  ]);
  return words.length > 0 && words.every((word) => generic.has(word));
}

function requestsUnsavedLiveState(query: string): boolean {
  const words = new Set(normalizedTextTokens(query));
  const requestsInboxState =
    ["email", "inbox", "mail"].some((word) => words.has(word)) &&
    ["new", "unread", "waiting"].some((word) => words.has(word));
  return requestsInboxState;
}
