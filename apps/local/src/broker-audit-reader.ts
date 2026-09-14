import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SqlcipherDatabase } from "./sqlcipher-database";
import { canonicalBrokerTranscript } from "./vault-broker-canonical";
import { brokerClientDisplayLabel, type BrokerClientKind } from "./broker-client-kind";

export type AuditOutcome = "authorized" | "success" | "denied" | "error";
export const MAX_AUDIT_NOTE_REFS = 20;
const MAX_AUDIT_PAGE_SIZE = 100;
const DEFAULT_AUDIT_PAGE_SIZE = 50;
const MAX_AUDIT_RESPONSE_BYTES = 256_000;
const AUDIT_CURSOR_TTL_MS = 10 * 60 * 1_000;

export type AuditPageRequest = { pageSize?: number; cursor?: string };
export type AuditPage = {
  events: Array<{
    eventId: string;
    occurredAt: string;
    clientId: string;
    clientKind: BrokerClientKind | null;
    clientDisplayLabel: string;
    grantId: string | null;
    sessionId: string | null;
    operation: string;
    outcome: AuditOutcome;
    errorCode: string | null;
    noteRefs: Array<{ noteId: string; revision: number }>;
  }>;
  nextCursor: string | null;
};

/** Reads metadata-only history from a borrowed broker database.
 * The caller authorizes inspection and owns database lifetime and audit writes.
 * Each reader owns its cursor key; cursors expire without extending on paging.
 */
export class BrokerAuditReader {
  readonly #database: SqlcipherDatabase;
  readonly #vaultId: string;
  readonly #bootId: string;
  readonly #now: () => number;
  readonly #auditCursorKey = randomBytes(32);

  constructor(options: {
    database: SqlcipherDatabase;
    vaultId: string;
    bootId: string;
    now: () => number;
  }) {
    this.#database = options.database;
    this.#vaultId = options.vaultId;
    this.#bootId = options.bootId;
    this.#now = options.now;
  }

  read(input: AuditPageRequest): AuditPage {
    const pageSize = input.pageSize ?? DEFAULT_AUDIT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_AUDIT_PAGE_SIZE) {
      throw new Error(`Audit page size must be between 1 and ${MAX_AUDIT_PAGE_SIZE}`);
    }
    const cursor = input.cursor
      ? this.#decodeAuditCursor(input.cursor)
      : {
          snapshotRowId: this.#database.query<{ row_id: number }, []>(
            "select coalesce(max(rowid), 0) as row_id from broker_audit_events",
          ).get()!.row_id,
          beforeRowId: Number.MAX_SAFE_INTEGER,
          expiresAt: this.#now() + AUDIT_CURSOR_TTL_MS,
        };
    const rows = this.#database.query<{
      row_id: number;
      event_id: string;
      occurred_at: string;
      client_id: string;
      client_kind: BrokerClientKind | null;
      grant_id: string | null;
      session_id: string | null;
      operation: string;
      outcome: AuditOutcome;
      error_code: string | null;
      note_refs: string;
    }, [string, number, number]>(`
      select a.rowid as row_id, a.event_id, a.occurred_at, a.client_id,
             c.kind as client_kind, a.grant_id, a.session_id, a.operation,
             a.outcome, a.error_code, a.note_refs
      from broker_audit_events a
      left join broker_clients c on c.id = a.client_id and c.vault_id = ?
      where a.rowid <= ? and a.rowid < ?
      order by a.rowid desc
      limit ${pageSize + 1}
    `).all(this.#vaultId, cursor.snapshotRowId, cursor.beforeRowId);
    const visible = rows.slice(0, pageSize);
    const events = visible.map((row) => ({
      eventId: row.event_id,
      occurredAt: row.occurred_at,
      clientId: row.client_id,
      clientKind: row.client_kind,
      clientDisplayLabel: row.client_kind
        ? brokerClientDisplayLabel(row.client_kind)
        : row.client_id === "owner"
        ? "Owner"
        : row.client_id === "native-library"
        ? "Afternote Library"
        : row.client_id.startsWith("pending:")
        ? "Pending client"
        : "Unknown client",
      grantId: row.grant_id,
      sessionId: row.session_id,
      operation: row.operation,
      outcome: row.outcome,
      errorCode: row.error_code,
      noteRefs: parseAuditNoteRefs(row.note_refs),
    }));
    if (Buffer.byteLength(JSON.stringify(events)) > MAX_AUDIT_RESPONSE_BYTES) {
      throw new Error("Audit response exceeds the owner-inspection byte limit");
    }
    return {
      events,
      nextCursor: rows.length > pageSize && visible.length > 0
        ? this.#encodeAuditCursor({
            snapshotRowId: cursor.snapshotRowId,
            beforeRowId: visible.at(-1)!.row_id,
            expiresAt: cursor.expiresAt,
          })
        : null,
    };
  }

  #encodeAuditCursor(value: {
    snapshotRowId: number;
    beforeRowId: number;
    expiresAt: number;
  }): string {
    const payload = Buffer.from(canonicalBrokerTranscript({
      version: 1,
      vaultId: this.#vaultId,
      brokerBootId: this.#bootId,
      snapshotRowId: value.snapshotRowId,
      beforeRowId: value.beforeRowId,
      expiresAt: value.expiresAt,
    })).toString("base64url");
    const signature = createHmac("sha256", this.#auditCursorKey)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  #decodeAuditCursor(cursor: string): {
    snapshotRowId: number;
    beforeRowId: number;
    expiresAt: number;
  } {
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2_048) {
      throw new Error("audit cursor is invalid");
    }
    const [payload, suppliedSignature, extra] = cursor.split(".");
    if (!payload || !suppliedSignature || extra !== undefined) {
      throw new Error("Audit cursor is malformed");
    }
    const expectedSignature = createHmac("sha256", this.#auditCursorKey)
      .update(payload)
      .digest();
    let signature: Buffer;
    try {
      signature = Buffer.from(suppliedSignature, "base64url");
    } catch {
      throw new Error("Audit cursor is malformed");
    }
    if (
      signature.toString("base64url") !== suppliedSignature ||
      signature.length !== expectedSignature.length ||
      !timingSafeEqual(signature, expectedSignature)
    ) {
      throw new Error("Audit cursor signature is invalid");
    }
    let decoded: unknown;
    try {
      const payloadBytes = Buffer.from(payload, "base64url");
      if (payloadBytes.toString("base64url") !== payload) {
        throw new Error("non-canonical payload");
      }
      decoded = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      throw new Error("Audit cursor payload is invalid");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Audit cursor payload is invalid");
    }
    const record = decoded as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\n") !==
        ["beforeRowId", "brokerBootId", "expiresAt", "snapshotRowId", "vaultId", "version"]
          .sort().join("\n") ||
      record.version !== 1 ||
      record.vaultId !== this.#vaultId ||
      record.brokerBootId !== this.#bootId ||
      !Number.isSafeInteger(record.snapshotRowId) ||
      !Number.isSafeInteger(record.beforeRowId) ||
      !Number.isSafeInteger(record.expiresAt) ||
      (record.snapshotRowId as number) < 0 ||
      (record.beforeRowId as number) < 1
    ) {
      throw new Error("Audit cursor context is invalid");
    }
    if ((record.expiresAt as number) <= this.#now()) {
      throw new Error("Audit cursor is stale");
    }
    return {
      snapshotRowId: record.snapshotRowId as number,
      beforeRowId: record.beforeRowId as number,
      expiresAt: record.expiresAt as number,
    };
  }
}

function parseAuditNoteRefs(value: string): Array<{ noteId: string; revision: number }> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > MAX_AUDIT_NOTE_REFS) {
    throw new Error("Stored audit note references are invalid");
  }
  return parsed.map((reference) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      throw new Error("Stored audit note reference is invalid");
    }
    const record = reference as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\n") !== "noteId\nrevision" ||
      typeof record.noteId !== "string" ||
      !Number.isInteger(record.revision)
    ) {
      throw new Error("Stored audit note reference is invalid");
    }
    if (record.noteId.length === 0 || record.noteId.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/.test(record.noteId)) {
      throw new Error("note ID is invalid");
    }
    if ((record.revision as number) <= 0) {
      throw new Error("Stored audit note revision is invalid");
    }
    return { noteId: record.noteId, revision: record.revision as number };
  });
}
