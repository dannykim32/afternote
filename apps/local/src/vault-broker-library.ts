import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Citation, Note, NoteRevision } from "@afternote/memory";
import { canonicalBrokerTranscript } from "./vault-broker-canonical";

export const LIBRARY_SCOPES = [
  "library.browse",
  "library.search",
  "library.get_note",
  "library.list_revisions",
  "library.inspect_source",
  "library.remember",
  "library.update_note",
] as const;

export type LibraryScope = (typeof LIBRARY_SCOPES)[number];

export const LIBRARY_READ_SCOPES: readonly LibraryScope[] = [
  "library.browse",
  "library.search",
  "library.get_note",
  "library.list_revisions",
  "library.inspect_source",
];

export const LIBRARY_SESSION_DEFAULT_TTL_MS = 15 * 60 * 1_000;
export const LIBRARY_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
export const LIBRARY_CURSOR_TTL_MS = 10 * 60 * 1_000;
export const LIBRARY_MAX_PAGE_SIZE = 20;
export const LIBRARY_MAX_SEARCH_RESULTS = 20;
export const LIBRARY_MAX_REVISION_PAGE_SIZE = 20;
export const LIBRARY_EXCERPT_CHARACTERS = 280;

export type LibraryNoteSummary = {
  id: string;
  revision: number;
  excerpt: string;
  source: Note["source"];
  createdAt: string;
  updatedAt: string;
};

type CursorPayload = {
  version: 1;
  protocolVersion: 1;
  brokerBootId: string;
  vaultId: string;
  operation: "browse" | "search" | "revisions";
  filterSha256: string;
  memoryCursor: string;
  expiresAt: string;
};

export class LibraryCursorCodec {
  readonly #key: Buffer;
  readonly #bootId: string;
  readonly #vaultId: string;
  readonly #now: () => number;

  constructor(options: {
    key: Uint8Array;
    bootId: string;
    vaultId: string;
    now?: () => number;
  }) {
    this.#key = Buffer.from(options.key);
    this.#bootId = options.bootId;
    this.#vaultId = options.vaultId;
    this.#now = options.now ?? Date.now;
  }

  encode(input: {
    operation: CursorPayload["operation"];
    filter: unknown;
    memoryCursor: string;
  }): string {
    const payload: CursorPayload = {
      version: 1,
      protocolVersion: 1,
      brokerBootId: this.#bootId,
      vaultId: this.#vaultId,
      operation: input.operation,
      filterSha256: filterDigest(input.filter),
      memoryCursor: input.memoryCursor,
      expiresAt: new Date(this.#now() + LIBRARY_CURSOR_TTL_MS).toISOString(),
    };
    const encoded = Buffer.from(canonicalBrokerTranscript(payload)).toString("base64url");
    const signature = createHmac("sha256", this.#key).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  decode(input: {
    cursor: string;
    operation: CursorPayload["operation"];
    filter: unknown;
  }): string {
    if (input.cursor.length < 3 || input.cursor.length > 4_096) {
      throw new Error("Library cursor is malformed");
    }
    const [encoded, signature, extra] = input.cursor.split(".");
    if (!encoded || !signature || extra !== undefined) {
      throw new Error("Library cursor is malformed");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
      throw new Error("Library cursor is malformed");
    }
    const expected = createHmac("sha256", this.#key).update(encoded).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      throw new Error("Library cursor is malformed");
    }
    if (
      supplied.toString("base64url") !== signature
      || supplied.length !== expected.length
      || !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("Library cursor signature is invalid");
    }
    let value: unknown;
    try {
      const payloadBytes = Buffer.from(encoded, "base64url");
      if (payloadBytes.toString("base64url") !== encoded) {
        throw new Error("Library cursor payload encoding is non-canonical");
      }
      value = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      throw new Error("Library cursor is malformed");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Library cursor payload is invalid");
    }
    const payload = value as Record<string, unknown>;
    if (
      Object.keys(payload).sort().join("\n") !==
        [
          "brokerBootId",
          "expiresAt",
          "filterSha256",
          "memoryCursor",
          "operation",
          "protocolVersion",
          "vaultId",
          "version",
        ].sort().join("\n") ||
      payload.version !== 1 ||
      payload.protocolVersion !== 1 ||
      payload.brokerBootId !== this.#bootId ||
      payload.vaultId !== this.#vaultId ||
      payload.operation !== input.operation ||
      payload.filterSha256 !== filterDigest(input.filter) ||
      typeof payload.memoryCursor !== "string" ||
      payload.memoryCursor.length < 1 ||
      payload.memoryCursor.length > 2_048 ||
      typeof payload.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(payload.expiresAt))
    ) {
      throw new Error("Library cursor context is invalid");
    }
    if (Date.parse(payload.expiresAt) <= this.#now()) {
      throw new Error("Library cursor is stale");
    }
    return payload.memoryCursor;
  }

  close(): void {
    this.#key.fill(0);
  }
}

export function libraryNoteSummary(
  note: Note,
  preferredExcerpt?: string,
): LibraryNoteSummary {
  return {
    id: note.id,
    revision: note.revision,
    excerpt: boundedExcerpt(preferredExcerpt ?? note.content),
    source: note.source,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export function libraryRevisionSummary(revision: NoteRevision): {
  noteId: string;
  revision: number;
  createdAt: string;
} {
  return {
    noteId: revision.noteId,
    revision: revision.revision,
    createdAt: revision.createdAt,
  };
}

export function librarySearchResult(result: {
  citation: Citation;
}): {
  citation: {
    noteId: string;
    revision: number;
    excerpt: string;
    source: Citation["source"];
    createdAt: string;
  };
} {
  return {
    citation: {
      noteId: result.citation.noteId,
      revision: result.citation.revision,
      excerpt: boundedExcerpt(result.citation.excerpt),
      source: result.citation.source,
      createdAt: result.citation.createdAt,
    },
  };
}

export function libraryDeleteTarget(note: Note): string {
  const source = note.source?.label ?? note.source?.application;
  const excerpt = boundedExcerpt(note.content, 96).replace(/\s+/gu, " ");
  return `${source ? `${source}: ` : ""}${excerpt}`.slice(0, 140);
}

export function boundedExcerpt(value: string, maximum = LIBRARY_EXCERPT_CHARACTERS): string {
  const characters = Array.from(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ""));
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

function filterDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalBrokerTranscript(value))
    .digest("hex");
}
