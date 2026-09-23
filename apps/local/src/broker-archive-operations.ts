import { assertExactObject, BrokerProtocolError } from "./broker-wire-protocol";
import type { ConversationArchives, ArchivePosition } from "./conversation-archives";
import type { LibraryScope, LibraryCursorCodec } from "./vault-broker-library";

type ArchiveOperation = {
  scope: LibraryScope;
  mutation: boolean;
  execute: (store: ConversationArchives) => unknown;
};

/** Connector reads share the same bounded storage contract; no path or mutation API. */
export function archiveConnectorOperation(method: string, params: unknown): (store: ConversationArchives) => unknown {
  if (method === "archive.search") {
    assertExactObject(params, ["query", "limit"]);
    const { query, limit } = params as Record<string, unknown>;
    if (typeof query !== "string" || typeof limit !== "number") invalid();
    return (store) => ({ results: store.search(query, limit), searchMode: "exact" });
  }
  if (method === "archive.read") {
    assertExactObject(params, ["id", "startIndex", "limit"]);
    const value = params as Record<string, unknown>;
    const id = archiveId(value.id), { startIndex, limit } = value;
    if (typeof startIndex !== "number" || typeof limit !== "number") invalid();
    return (store) => store.read(id, startIndex, limit);
  }
  throw new BrokerProtocolError("scope_denied", "Archive operation is not supported");
}

/** Validates bounded wire data; the worker retains admission, scopes and audit. */
export function archiveLibraryOperation(
  method: string, params: Record<string, unknown>, cursors: LibraryCursorCodec,
): ArchiveOperation {
  switch (method) {
    case "library.archive_begin": {
      assertExactObject(params, ["title", "bytes", "sha256"]);
      if (typeof params.title !== "string" || typeof params.bytes !== "number" || typeof params.sha256 !== "string") invalid();
      const manifest = { title: params.title, bytes: params.bytes, sha256: params.sha256 };
      return { scope: method, mutation: true, execute: (store) => ({ archive: store.beginInCurrentTransaction(manifest) }) };
    }
    case "library.archive_append": {
      assertExactObject(params, ["id", "startIndex", "passages"]);
      const id = archiveId(params.id);
      if (typeof params.startIndex !== "number" || !Array.isArray(params.passages) || params.passages.some((p) => typeof p !== "string")) invalid();
      const startIndex = params.startIndex, passages = params.passages as string[];
      return { scope: method, mutation: true, execute: (store) => ({ archive: store.appendInCurrentTransaction(id, startIndex, passages) }) };
    }
    case "library.archive_complete": {
      assertExactObject(params, ["id"]);
      const id = archiveId(params.id);
      return { scope: method, mutation: true, execute: (store) => ({ archive: store.completeInCurrentTransaction(id) }) };
    }
    case "library.archive_cancel": {
      assertExactObject(params, ["id"]);
      const id = archiveId(params.id);
      return { scope: method, mutation: true, execute: (store) => ({ discarded: store.cancelInCurrentTransaction(id) }) };
    }
    case "library.archive_status": {
      assertExactObject(params, ["id"]);
      const id = archiveId(params.id);
      return { scope: method, mutation: false, execute: (store) => ({ archive: store.status(id) }) };
    }
    case "library.archive_read": {
      assertExactObject(params, ["id", "startIndex", "limit"]);
      const id = archiveId(params.id);
      if (typeof params.startIndex !== "number" || typeof params.limit !== "number") invalid();
      const startIndex = params.startIndex, limit = params.limit;
      return { scope: method, mutation: false, execute: (store) => store.read(id, startIndex, limit) };
    }
    case "library.archive_search": {
      assertExactObject(params, ["query", "limit"]);
      if (typeof params.query !== "string" || typeof params.limit !== "number") invalid();
      const query = params.query, limit = params.limit;
      return { scope: method, mutation: false, execute: (store) => ({ results: store.search(query, limit), searchMode: "exact" }) };
    }
    case "library.archive_list": {
      assertExactObject(params, ["state", "cursor", "limit"]);
      if ((params.state !== "ready" && params.state !== "importing") || typeof params.limit !== "number") invalid();
      const state = params.state, limit = params.limit;
      let after: ArchivePosition | undefined;
      if (params.cursor !== null) {
        if (typeof params.cursor !== "string") invalid();
        try {
          after = JSON.parse(cursors.decode({ cursor: params.cursor, operation: "archives", filter: { state } }));
        } catch { throw new BrokerProtocolError("invalid_cursor", "Archive cursor is stale or invalid"); }
      }
      return { scope: method, mutation: false, execute: (store) => {
        const page = store.listPage({ state, limit, after });
        return { archives: page.archives, nextCursor: page.next ? cursors.encode({
          operation: "archives", filter: { state }, memoryCursor: JSON.stringify(page.next),
        }) : null };
      } };
    }
    default: throw new BrokerProtocolError("not_found", "Archive operation is unavailable");
  }
}

export function archiveId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}

function invalid(): never { throw new BrokerProtocolError("invalid_request", "Archive request is invalid"); }
