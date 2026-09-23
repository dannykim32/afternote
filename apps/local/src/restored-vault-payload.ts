import type { Database } from "bun:sqlite";
import type { SqlcipherDatabase } from "./sqlcipher-database";
import { ConversationArchives } from "./conversation-archives";
import { interchangePayloadDigest, type StreamingInterchangeNote } from "./interchange";

/** Reconstructs approved backup payloads from a read-only recovery candidate. */
export function restoredVaultPayloadDigests(database: SqlcipherDatabase, applicationVersion: string): string[] {
  const schemaQuery = database.query<{ user_version: number }, []>("pragma user_version");
  let schema: number;
  try { schema = schemaQuery.get()!.user_version; }
  finally { schemaQuery.close(); }
  if (schema < 8 || schema > 11) throw new Error("Unsupported restored Vault schema");
  const notes = database.query<{
    id: string; current_revision: number; created_at: string; updated_at: string;
  }, []>("select id, current_revision, created_at, updated_at from notes order by id");
  const revisions = database.query<{
    note_id: string; revision: number; content: string; source_json: string | null; created_at: string;
  }, [string]>("select note_id, revision, content, source_json, created_at from note_revisions where note_id = ? order by revision");
  const streamNotes = function* (): Iterable<StreamingInterchangeNote> {
    for (const note of notes.iterate()) yield {
      id: note.id, currentRevision: note.current_revision, createdAt: note.created_at, updatedAt: note.updated_at,
      revisions: function* () {
        for (const revision of revisions.iterate(note.id)) yield {
          noteId: revision.note_id, revision: revision.revision, content: revision.content,
          source: canonicalSource(revision.source_json), createdAt: revision.created_at,
        };
      },
    };
  };
  let archives: ConversationArchives | undefined;
  try {
    // Existing authenticated recovery markers can refer to a pre-Archive
    // encrypted candidate. Never migrate it or query tables it did not have.
    if (schema < 11) return [interchangePayloadDigest(streamNotes, applicationVersion).payloadSha256];
    archives = new ConversationArchives(database as unknown as Database);
    const store = archives;
    const hasArchives = store.listPage().archives.length > 0 || store.listPage({ state: "importing" }).archives.length > 0;
    const digests = [interchangePayloadDigest(streamNotes, applicationVersion, () => store.exportSnapshot()).payloadSha256];
    // Historical markers don't name the interchange version. The v1 digest is
    // eligible only when there is no Archive content it could omit.
    if (!hasArchives) digests.push(interchangePayloadDigest(streamNotes, applicationVersion).payloadSha256);
    return digests;
  } finally {
    archives?.close();
    revisions.close();
    notes.close();
  }
}

function canonicalSource(value: string | null): Record<string, string> | null {
  if (!value) return null;
  const source = JSON.parse(value) as Record<string, string>;
  const canonical: Record<string, string> = {};
  for (const key of ["application", "url", "author", "timestamp", "label"]) {
    if (source[key] !== undefined) canonical[key] = source[key];
  }
  return Object.keys(canonical).length > 0 ? canonical : null;
}
