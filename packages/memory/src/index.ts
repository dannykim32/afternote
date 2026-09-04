export const MAX_NOTE_CHARACTERS = 100_000;
export const MAX_RECALL_QUERY_CHARACTERS = 2_000;
export const MAX_RECALL_RESULTS = 20;
export const DEFAULT_RECALL_RESULTS = 5;
export const MAX_SOURCE_APPLICATION_CHARACTERS = 100;
export const MAX_SOURCE_URL_CHARACTERS = 2_048;
export const MAX_SOURCE_AUTHOR_CHARACTERS = 200;
export const MAX_SOURCE_TIMESTAMP_CHARACTERS = 100;
export const MAX_SOURCE_LABEL_CHARACTERS = 200;

const ISO_8601_TIMESTAMP_WITH_TIMEZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u;

export function countCharacters(value: string): number {
  return Array.from(value).length;
}

export function normalizeSourceTimestamp(value: string): string | null {
  const match = ISO_8601_TIMESTAMP_WITH_TIMEZONE.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return null;
    }
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

export const MEMORY_CAPABILITIES = [
  "memory.remember",
  "memory.recall",
  "memory.get_note",
  "memory.forget",
] as const;

export type MemoryCapability = (typeof MEMORY_CAPABILITIES)[number];

export function isMemoryCapabilityList(
  value: unknown,
): value is MemoryCapability[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(
      (capability) =>
        typeof capability === "string" &&
        (MEMORY_CAPABILITIES as readonly string[]).includes(capability),
    )
  );
}

export type VaultContext = {
  vaultId: string;
  deployment: "local" | "hosted";
};

export function vaultContextsEqual(
  actual: VaultContext | undefined,
  expected: VaultContext,
): boolean {
  return (
    actual?.vaultId === expected.vaultId &&
    actual.deployment === expected.deployment
  );
}

export function missingMemoryCapability(
  capabilities: readonly string[],
): MemoryCapability | undefined {
  return MEMORY_CAPABILITIES.find(
    (capability) => !capabilities.includes(capability),
  );
}

export const MEMORY_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "conflict",
  "unavailable",
  "unauthorized",
  "unsupported_capability",
  "rate_limited",
  "incompatible_schema",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryError extends Error {
  readonly name = "MemoryError";

  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type SourceContext = {
  application?: string;
  url?: string;
  author?: string;
  timestamp?: string;
  label?: string;
};

export type Note = {
  id: string;
  content: string;
  revision: number;
  source: SourceContext | null;
  createdAt: string;
  updatedAt: string;
};

export type NoteRevision = {
  noteId: string;
  revision: number;
  content: string;
  source: SourceContext | null;
  createdAt: string;
};

export type Citation = {
  noteId: string;
  revision: number;
  excerpt: string;
  source: SourceContext | null;
  createdAt: string;
};

export type RecallResult = {
  note: Note;
  citation: Citation;
  score: number;
};

export type RememberInput = {
  content: string;
  source?: SourceContext;
};

export type UpdateNoteInput = {
  content: string;
  expectedRevision: number;
  source?: SourceContext | null;
};

export type BrowseNotesInput = {
  limit?: number;
  cursor?: string;
};

export type BrowseNotesPage = {
  notes: Note[];
  nextCursor: string | null;
};

export type SearchNotesInput = {
  query: string;
  limit?: number;
  cursor?: string;
};

export type SearchNotesPage = {
  results: RecallResult[];
  nextCursor: string | null;
};

export type ListNoteRevisionsInput = {
  limit?: number;
  cursor?: string;
};

export type NoteRevisionsPage = {
  revisions: NoteRevision[];
  nextCursor: string | null;
};

export interface Memory {
  capabilities(vault: VaultContext): Promise<MemoryCapability[]>;
  remember(vault: VaultContext, input: RememberInput): Promise<Note>;
  recall(
    vault: VaultContext,
    query: string,
    limit?: number,
  ): Promise<RecallResult[]>;
  browseNotes(
    vault: VaultContext,
    input?: BrowseNotesInput,
  ): Promise<BrowseNotesPage>;
  searchNotes(
    vault: VaultContext,
    input: SearchNotesInput,
  ): Promise<SearchNotesPage>;
  getNote(vault: VaultContext, id: string): Promise<Note | null>;
  updateNote(
    vault: VaultContext,
    id: string,
    input: UpdateNoteInput,
  ): Promise<Note>;
  listNoteRevisions(
    vault: VaultContext,
    id: string,
    input?: ListNoteRevisionsInput,
  ): Promise<NoteRevisionsPage>;
  forget(vault: VaultContext, id: string): Promise<boolean>;
}
