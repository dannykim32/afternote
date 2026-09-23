import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { MemoryError } from "@afternote/memory";
import { SqlcipherDatabase } from "./sqlcipher-database";
import { CONVERSATION_ARCHIVE_SCHEMA } from "./conversation-archive-schema";

type SchemaVersionRow = { user_version: number };

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
  { version: 11, sql: CONVERSATION_ARCHIVE_SCHEMA },
] as const;

const CURRENT_SCHEMA_VERSION = SCHEMA_MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Upgrade the Note schema only after verifying a recoverable backup of an existing
 * on-disk vault. Each version commits atomically; a failed version remains retryable.
 * The caller owns the database and key. Neither is retained or closed here.
 */
export function migrateNoteSchema(
  database: Database,
  databasePath: string,
  encryptionKey?: Uint8Array,
): void {
  const currentVersion = database
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
    ensurePreMigrationBackup(database, databasePath, currentVersion, encryptionKey);
  }

  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    database.transaction(() => {
      migration.prepare?.(database);
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version};`);
    })();
  }
}

function ensurePreMigrationBackup(
  database: Database,
  databasePath: string,
  schemaVersion: number,
  encryptionKey?: Uint8Array,
): void {
  const previousUmask = process.umask(0o077);
  let temporaryDirectory: string | undefined;
  let backupPath: string | undefined;
  let published = false;
  try {
    temporaryDirectory = mkdtempSync(
      join(dirname(databasePath), ".afternote-migration-"),
    );
    const temporaryBackupPath = join(temporaryDirectory, "backup.db");
    if (encryptionKey) {
      const backup = openNoteDatabase(temporaryBackupPath, encryptionKey, {
        create: true,
      });
      try {
        (database as unknown as SqlcipherDatabase).backupTo(
          backup as unknown as SqlcipherDatabase,
        );
      } finally {
        backup.close();
      }
    } else {
      database.query("VACUUM INTO ?").run(temporaryBackupPath);
    }
    chmodSync(temporaryBackupPath, 0o600);
    assertMigrationBackup(temporaryBackupPath, schemaVersion, encryptionKey);
    const fingerprint = hashFile(temporaryBackupPath);
    backupPath =
      `${databasePath}.pre-migration-v${schemaVersion}-${fingerprint}.db`;
    if (pathEntryExists(backupPath)) {
      assertMigrationBackup(backupPath, schemaVersion, encryptionKey);
      if (hashFile(backupPath) !== fingerprint) {
        throw new Error("Pre-migration backup fingerprint mismatch");
      }
      return;
    }
    renameSync(temporaryBackupPath, backupPath);
    published = true;
    assertMigrationBackup(backupPath, schemaVersion, encryptionKey);
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

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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

  const backup = openNoteDatabase(path, encryptionKey, { readonly: true });
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

// Select the real SQLite or SQLCipher adapter without migrating readonly callers.
// The returned connection belongs to the caller.
export function openNoteDatabase(
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
