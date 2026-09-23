import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import {
  MAX_NOTE_CHARACTERS,
  MAX_SOURCE_APPLICATION_CHARACTERS,
  MAX_SOURCE_AUTHOR_CHARACTERS,
  MAX_SOURCE_LABEL_CHARACTERS,
  MAX_SOURCE_TIMESTAMP_CHARACTERS,
  MAX_SOURCE_URL_CHARACTERS,
  countCharacters,
  normalizeSourceTimestamp,
  type NoteRevision,
  type SourceContext,
} from "@afternote/memory";
import { applicationMajor } from "./application-version";
import { writeExclusivePrivateFile } from "./exclusive-export";
import { archiveJson, validateInterchangeArchives, type InterchangeArchive, type StreamingInterchangeArchive } from "./archive-interchange";

export const AFTERNOTE_INTERCHANGE_FORMAT = "afternote-vault";
export const AFTERNOTE_INTERCHANGE_SCHEMA_VERSION = 2;
export const MAX_INTERCHANGE_BYTES = 256 * 1_024 * 1_024;
export const MAX_INTERCHANGE_NOTES = 100_000;
export const MAX_INTERCHANGE_REVISIONS = 500_000;

export type InterchangeNote = {
  id: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
  revisions: NoteRevision[];
};

export type InterchangeManifest = {
  algorithm: "sha256";
  noteCount: number;
  revisionCount: number;
  payloadSha256: string;
};

export type InterchangeDocument = {
  format: typeof AFTERNOTE_INTERCHANGE_FORMAT;
  schemaVersion: 1 | 2;
  applicationVersion: string;
  notes: InterchangeNote[];
  archives?: InterchangeArchive[];
  manifest: InterchangeManifest;
};

export type InterchangeSnapshot = {
  document: InterchangeDocument;
  bytes: number;
  sha256: string;
};

export type StreamingInterchangeNote = Omit<InterchangeNote, "revisions"> & {
  revisions: () => Iterable<NoteRevision>;
};

export function writeInterchange(
  path: string,
  notes: () => Iterable<StreamingInterchangeNote>,
  expectedNoteCount: number,
  expectedRevisionCount: number,
  applicationVersion: string,
  beforePublish: () => void = () => {},
  archives?: () => Iterable<StreamingInterchangeArchive>,
): void {
  applicationMajor(applicationVersion);
  if (expectedNoteCount > MAX_INTERCHANGE_NOTES) {
    throw new Error(`Interchange cannot exceed ${MAX_INTERCHANGE_NOTES} notes`);
  }
  if (expectedRevisionCount > MAX_INTERCHANGE_REVISIONS) {
    throw new Error(
      `Interchange cannot exceed ${MAX_INTERCHANGE_REVISIONS} revisions`,
    );
  }
  const schemaVersion = archives ? 2 : 1;
  const hashed = interchangePayloadDigest(notes, applicationVersion, archives);
  if (
    hashed.noteCount !== expectedNoteCount ||
    hashed.revisionCount !== expectedRevisionCount
  ) {
    throw new Error("Interchange source changed during export");
  }
  writeExclusivePrivateFile(path, (descriptor) => {
    let bytesWritten = 0;
    const write = (chunk: string) => {
      bytesWritten += Buffer.byteLength(chunk);
      if (bytesWritten > MAX_INTERCHANGE_BYTES) {
        throw new Error(`Interchange cannot exceed ${MAX_INTERCHANGE_BYTES} bytes`);
      }
      writeFileSync(descriptor, chunk);
    };
    write(`{\n  "format": ${JSON.stringify(AFTERNOTE_INTERCHANGE_FORMAT)},`);
    write(`\n  "schemaVersion": ${schemaVersion},`);
    write(`\n  "applicationVersion": ${JSON.stringify(applicationVersion)},`);
    write("\n  \"notes\": [");
    let noteIndex = 0;
    let revisionCount = 0;
    for (const note of notes()) {
      write(noteIndex === 0 ? "\n" : ",\n");
      revisionCount += writePrettyNote(write, note);
      noteIndex += 1;
    }
    if (noteIndex > 0) write("\n  ");
    write("]");
    if (archives) {
      write(',\n  "archives": [');
      let archiveIndex = 0;
      for (const archive of archives()) {
        if (archiveIndex++ > 0) write(",");
        for (const chunk of archiveJson(archive)) write(chunk);
      }
      write("]");
    }
    write(",\n  \"manifest\": {\n    \"algorithm\": \"sha256\",");
    write(`\n    "noteCount": ${expectedNoteCount},`);
    write(`\n    "revisionCount": ${expectedRevisionCount},`);
    write(`\n    "payloadSha256": ${JSON.stringify(hashed.payloadSha256)}`);
    write("\n  }\n}\n");
    if (noteIndex !== expectedNoteCount || revisionCount !== expectedRevisionCount) {
      throw new Error("Interchange source changed during export");
    }
  }, beforePublish);
}

export function interchangePayloadDigest(
  notes: () => Iterable<StreamingInterchangeNote>,
  applicationVersion: string,
  archives?: () => Iterable<StreamingInterchangeArchive>,
): { payloadSha256: string; noteCount: number; revisionCount: number } {
  const hash = createHash("sha256");
  hash.update(
    `{"format":${JSON.stringify(AFTERNOTE_INTERCHANGE_FORMAT)},` +
      `"schemaVersion":${archives ? 2 : 1},` +
      `"applicationVersion":${JSON.stringify(applicationVersion)},"notes":[`,
  );
  let noteCount = 0;
  let revisionCount = 0;
  for (const note of notes()) {
    if (noteCount > 0) hash.update(",");
    hash.update(
      `{"id":${JSON.stringify(note.id)},` +
        `"currentRevision":${note.currentRevision},` +
        `"createdAt":${JSON.stringify(note.createdAt)},` +
        `"updatedAt":${JSON.stringify(note.updatedAt)},"revisions":[`,
    );
    let noteRevisionCount = 0;
    for (const revision of note.revisions()) {
      if (noteRevisionCount > 0) hash.update(",");
      hash.update(
        `{"noteId":${JSON.stringify(revision.noteId)},` +
          `"revision":${revision.revision},` +
          `"content":${JSON.stringify(revision.content)},` +
          `"source":${JSON.stringify(canonicalSource(revision.source))},` +
          `"createdAt":${JSON.stringify(revision.createdAt)}}`,
      );
      noteRevisionCount += 1;
      revisionCount += 1;
    }
    hash.update("]}");
    noteCount += 1;
  }
  hash.update("]");
  if (archives) {
    hash.update(',"archives":[');
    let first = true;
    for (const archive of archives()) {
      if (!first) hash.update(",");
      for (const chunk of archiveJson(archive)) hash.update(chunk);
      first = false;
    }
    hash.update("]");
  }
  hash.update("}");
  return {
    payloadSha256: hash.digest("hex"),
    noteCount,
    revisionCount,
  };
}

function writePrettyNote(
  write: (chunk: string) => void,
  note: StreamingInterchangeNote,
): number {
  write("    {\n");
  write(`      "id": ${JSON.stringify(note.id)},\n`);
  write(`      "currentRevision": ${note.currentRevision},\n`);
  write(`      "createdAt": ${JSON.stringify(note.createdAt)},\n`);
  write(`      "updatedAt": ${JSON.stringify(note.updatedAt)},\n`);
  write("      \"revisions\": [");
  let revisionCount = 0;
  for (const revision of note.revisions()) {
    write(revisionCount === 0 ? "\n" : ",\n");
    write("        {\n");
    write(`          "noteId": ${JSON.stringify(revision.noteId)},\n`);
    write(`          "revision": ${revision.revision},\n`);
    write(`          "content": ${JSON.stringify(revision.content)},\n`);
    writePrettySource(write, revision.source);
    write(`          "createdAt": ${JSON.stringify(revision.createdAt)}\n`);
    write("        }");
    revisionCount += 1;
  }
  if (revisionCount > 0) write("\n      ");
  write("]\n    }");
  return revisionCount;
}

function writePrettySource(
  write: (chunk: string) => void,
  source: SourceContext | null,
): void {
  const canonical = canonicalSource(source);
  if (!canonical) {
    write("          \"source\": null,\n");
    return;
  }
  write("          \"source\": {\n");
  const entries = Object.entries(canonical);
  for (const [index, [key, value]] of entries.entries()) {
    write(
      `            ${JSON.stringify(key)}: ${JSON.stringify(value)}` +
        (index === entries.length - 1 ? "\n" : ",\n"),
    );
  }
  write("          },\n");
}

export function readInterchange(
  path: string,
  currentApplicationVersion: string,
): InterchangeDocument {
  return readInterchangeSnapshot(path, currentApplicationVersion).document;
}

export function readInterchangeSnapshot(
  path: string,
  currentApplicationVersion: string,
  afterReadForTest: () => void = () => {},
): InterchangeSnapshot {
  const bytes = readStableInterchangeBytes(path, afterReadForTest);
  return {
    document: parseInterchangeBytes(bytes, currentApplicationVersion),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function parseInterchangeBytes(
  bytes: Buffer,
  currentApplicationVersion: string,
): InterchangeDocument {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateJsonObjectKeys(text);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Duplicate JSON")) {
      throw error;
    }
    if (error instanceof Error && error.message.includes("nesting is too deep")) {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith("Interchange JSON")) {
      throw error;
    }
    throw new Error("Interchange source must contain valid UTF-8 JSON");
  }
  let document: InterchangeDocument;
  try {
    document = JSON.parse(text) as InterchangeDocument;
  } catch {
    throw new Error("Interchange source must contain valid UTF-8 JSON");
  }
  assertExactObjectKeys(
    document,
    ["format", "schemaVersion", "applicationVersion", "notes", "manifest",
      ...(document?.schemaVersion === 2 ? ["archives"] : [])],
    "Interchange",
  );
  if (document.format !== AFTERNOTE_INTERCHANGE_FORMAT) {
    throw new Error("Interchange format is not supported");
  }
  if (
    !Number.isInteger(document.schemaVersion) ||
    document.schemaVersion < 1
  ) {
    throw new Error("Interchange schema version must be a positive integer");
  }
  if (document.schemaVersion > AFTERNOTE_INTERCHANGE_SCHEMA_VERSION) {
    throw new Error(
      `Cannot restore newer interchange schema version ${document.schemaVersion}; ` +
        `this build supports up to version ${AFTERNOTE_INTERCHANGE_SCHEMA_VERSION}.`,
    );
  }
  const exportedMajor = applicationMajor(document.applicationVersion);
  const currentMajor = applicationMajor(currentApplicationVersion);
  if (exportedMajor > currentMajor) {
    throw new Error(
      `Cannot restore an export from newer application major ${exportedMajor}; ` +
        `this build uses major ${currentMajor}.`,
    );
  }
  if (!Array.isArray(document.notes)) {
    throw new Error("Interchange notes must be an array");
  }
  if (document.schemaVersion === 2) validateInterchangeArchives(document.archives);
  if (document.notes.length > MAX_INTERCHANGE_NOTES) {
    throw new Error(
      `Interchange cannot exceed ${MAX_INTERCHANGE_NOTES} notes`,
    );
  }
  const noteIds = new Set<string>();
  let revisionCount = 0;
  for (const note of document.notes) {
    if (!note || typeof note !== "object" || typeof note.id !== "string") {
      throw new Error("Every interchange note must have a string id");
    }
    assertExactObjectKeys(
      note,
      ["id", "currentRevision", "createdAt", "updatedAt", "revisions"],
      `Note ${note.id}`,
    );
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        note.id,
      )
    ) {
      throw new Error(`Note id is not a supported UUID: ${note.id}`);
    }
    if (noteIds.has(note.id)) {
      throw new Error(`Duplicate note id: ${note.id}`);
    }
    noteIds.add(note.id);
    assertNormalizedTimestamp(note.createdAt, `Note ${note.id} createdAt`);
    assertNormalizedTimestamp(note.updatedAt, `Note ${note.id} updatedAt`);
    if (!Array.isArray(note.revisions)) {
      throw new Error(`Note ${note.id} revisions must be an array`);
    }
    const revisionNumbers = new Set<number>();
    let previousRevisionTime = Number.NEGATIVE_INFINITY;
    for (const [revisionIndex, revision] of note.revisions.entries()) {
      revisionCount += 1;
      if (revisionCount > MAX_INTERCHANGE_REVISIONS) {
        throw new Error(
          `Interchange cannot exceed ${MAX_INTERCHANGE_REVISIONS} revisions`,
        );
      }
      if (
        !revision ||
        typeof revision !== "object" ||
        !Number.isInteger(revision.revision)
      ) {
        throw new Error(`Note ${note.id} has an invalid revision number`);
      }
      assertExactObjectKeys(
        revision,
        ["noteId", "revision", "content", "source", "createdAt"],
        `Revision ${revision.revision} for note ${note.id}`,
      );
      if (revision.noteId !== note.id) {
        throw new Error(
          `Revision ${revision.revision} noteId does not match note ${note.id}`,
        );
      }
      if (revisionNumbers.has(revision.revision)) {
        throw new Error(
          `Duplicate revision ${revision.revision} for note ${note.id}`,
        );
      }
      revisionNumbers.add(revision.revision);
      if (revision.revision !== revisionIndex + 1) {
        throw new Error(`Note ${note.id} revisions must be contiguous from 1`);
      }
      if (revision.source !== null) {
        assertExactObjectKeys(
          revision.source,
          ["application", "url", "author", "timestamp", "label"],
          `Revision ${revision.revision} source for note ${note.id}`,
        );
        assertSource(revision.source);
      }
      assertNormalizedTimestamp(
        revision.createdAt,
        `Revision ${revision.revision} for note ${note.id} createdAt`,
      );
      const revisionTime = Date.parse(revision.createdAt);
      if (revisionTime < previousRevisionTime) {
        throw new Error(`Note ${note.id} revision timestamps must be chronological`);
      }
      previousRevisionTime = revisionTime;
      if (typeof revision.content !== "string" || !revision.content.trim()) {
        throw new Error(
          `Revision ${revision.revision} for note ${note.id} must have content`,
        );
      }
      if (countCharacters(revision.content) > MAX_NOTE_CHARACTERS) {
        throw new Error(
          `Revision ${revision.revision} content cannot exceed ` +
            `${MAX_NOTE_CHARACTERS} characters`,
        );
      }
    }
    if (
      !Number.isInteger(note.currentRevision) ||
      !revisionNumbers.has(note.currentRevision)
    ) {
      throw new Error(
        `Note ${note.id} is missing current revision ${note.currentRevision}`,
      );
    }
    if (note.currentRevision !== note.revisions.length) {
      throw new Error(`Note ${note.id} current revision must be the latest revision`);
    }
    if (note.revisions[0]?.createdAt !== note.createdAt) {
      throw new Error(`Note ${note.id} createdAt must match revision 1`);
    }
    if (note.revisions.at(-1)?.createdAt !== note.updatedAt) {
      throw new Error(`Note ${note.id} updatedAt must match its current revision`);
    }
  }
  assertExactObjectKeys(
    document.manifest,
    ["algorithm", "noteCount", "revisionCount", "payloadSha256"],
    "Interchange manifest",
  );
  if (document.manifest.algorithm !== "sha256") {
    throw new Error("Interchange manifest algorithm must be sha256");
  }
  if (
    !Number.isInteger(document.manifest.noteCount) ||
    document.manifest.noteCount < 0 ||
    document.manifest.noteCount > MAX_INTERCHANGE_NOTES
  ) {
    throw new Error("Interchange manifest note count is invalid");
  }
  if (
    !Number.isInteger(document.manifest.revisionCount) ||
    document.manifest.revisionCount < 0 ||
    document.manifest.revisionCount > MAX_INTERCHANGE_REVISIONS
  ) {
    throw new Error("Interchange manifest revision count is invalid");
  }
  if (document.manifest.noteCount !== document.notes.length) {
    throw new Error(
      `Interchange manifest note count ${document.manifest.noteCount} ` +
        `does not match ${document.notes.length}`,
    );
  }
  if (document.manifest.revisionCount !== revisionCount) {
    throw new Error(
      `Interchange manifest revision count ${document.manifest.revisionCount} ` +
        `does not match ${revisionCount}`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(document.manifest.payloadSha256)) {
    throw new Error("Interchange manifest checksum must be lowercase SHA-256");
  }
  const notes = function* () {
    for (const note of canonicalizeNotes(document.notes)) {
      yield { ...note, revisions: () => note.revisions };
    }
  };
  const archives = document.schemaVersion === 2 ? function* () {
    for (const archive of [...document.archives!].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      yield { ...archive, passages: () => archive.passages };
    }
  } : undefined;
  const expectedChecksum = interchangePayloadDigest(notes, document.applicationVersion, archives).payloadSha256;
  if (document.manifest?.payloadSha256 !== expectedChecksum) {
    throw new Error("Interchange checksum does not match its payload");
  }
  return document;
}

function readStableInterchangeBytes(
  path: string,
  afterReadForTest: () => void,
): Buffer {
  const beforePath = lstatSync(path);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error("Interchange source must be a regular file");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > MAX_INTERCHANGE_BYTES) {
      throw new Error(
        `Interchange source must contain 1 to ${MAX_INTERCHANGE_BYTES} bytes`,
      );
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let bytesRead = 0;
    while (bytesRead < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        bytesRead,
        bytes.byteLength - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    const overflow = Buffer.allocUnsafe(1);
    const overflowBytes = readSync(descriptor, overflow, 0, 1, null);
    if (bytesRead !== bytes.byteLength || overflowBytes !== 0) {
      throw new Error(
        "Interchange source changed while it was read",
      );
    }
    afterReadForTest();
    const after = fstatSync(descriptor);
    const afterPath = lstatSync(path);
    if (
      !afterPath.isFile() || afterPath.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || after.size !== bytesRead ||
      after.dev !== afterPath.dev || after.ino !== afterPath.ino ||
      beforePath.dev !== before.dev || beforePath.ino !== before.ino
    ) {
      throw new Error("Interchange source changed while it was read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function assertNormalizedTimestamp(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a normalized ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a normalized ISO timestamp`);
  }
}

function assertExactObjectKeys(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} has unknown field "${key}"`);
    }
  }
}

function assertSource(source: Record<string, unknown>): void {
  const maximumLengths = {
    application: MAX_SOURCE_APPLICATION_CHARACTERS,
    url: MAX_SOURCE_URL_CHARACTERS,
    author: MAX_SOURCE_AUTHOR_CHARACTERS,
    timestamp: MAX_SOURCE_TIMESTAMP_CHARACTERS,
    label: MAX_SOURCE_LABEL_CHARACTERS,
  } as const;
  if (Object.keys(source).length === 0) {
    throw new Error("source must contain at least one field");
  }
  for (const key of Object.keys(maximumLengths) as Array<
    keyof typeof maximumLengths
  >) {
    const value = source[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`source.${key} must be a non-empty string`);
    }
    if (countCharacters(value) > maximumLengths[key]) {
      throw new Error(
        `source.${key} cannot exceed ${maximumLengths[key]} characters`,
      );
    }
    if (
      key === "timestamp" &&
      normalizeSourceTimestamp(value) !== value
    ) {
      throw new Error("source.timestamp must be a normalized ISO timestamp");
    }
  }
}

function assertNoDuplicateJsonObjectKeys(text: string): void {
  let index = 0;
  const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const maximumStringTokenLength = MAX_NOTE_CHARACTERS * 12 + 2;
  const skipWhitespace = () => {
    while (
      text[index] === " " ||
      text[index] === "\t" ||
      text[index] === "\n" ||
      text[index] === "\r"
    ) {
      index += 1;
    }
  };
  const parseString = (): string => {
    const start = index;
    if (text[index] !== '"') throw new Error("Interchange source is not valid JSON");
    index += 1;
    while (index < text.length) {
      if (index - start > maximumStringTokenLength) {
        throw new Error("Interchange JSON string token is too large");
      }
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index)) as string;
      }
      index += 1;
    }
    throw new Error("Interchange source is not valid JSON");
  };
  const parseValue = (depth: number): void => {
    if (depth > 64) throw new Error("Interchange JSON nesting is too deep");
    skipWhitespace();
    const token = text[index];
    if (token === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      let keyCount = 0;
      while (index < text.length) {
        skipWhitespace();
        const key = parseString();
        keyCount += 1;
        if (keyCount > 16) {
          throw new Error("Interchange JSON object has too many fields");
        }
        if (keys.has(key)) {
          throw new Error(`Duplicate JSON object key "${key}"`);
        }
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") {
          throw new Error("Interchange source is not valid JSON");
        }
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          throw new Error("Interchange source is not valid JSON");
        }
        index += 1;
      }
      throw new Error("Interchange source is not valid JSON");
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      let entryCount = 0;
      while (index < text.length) {
        entryCount += 1;
        if (entryCount > MAX_INTERCHANGE_REVISIONS) {
          throw new Error("Interchange JSON array has too many entries");
        }
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          throw new Error("Interchange source is not valid JSON");
        }
        index += 1;
      }
      throw new Error("Interchange source is not valid JSON");
    }
    if (token === '"') {
      parseString();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    numberPattern.lastIndex = index;
    const number = numberPattern.exec(text);
    if (!number) throw new Error("Interchange source is not valid JSON");
    index += number[0].length;
  };

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) {
    throw new Error("Interchange source is not valid JSON");
  }
}

function canonicalSource(source: SourceContext | null): SourceContext | null {
  if (!source) return null;
  const canonical: SourceContext = {};
  for (const key of [
    "application",
    "url",
    "author",
    "timestamp",
    "label",
  ] as const) {
    if (source[key] !== undefined) canonical[key] = source[key];
  }
  return Object.keys(canonical).length > 0 ? canonical : null;
}

function canonicalizeNotes(notes: InterchangeNote[]): InterchangeNote[] {
  return [...notes].sort(compareNoteIds).map((note) => ({
    id: note.id,
    currentRevision: note.currentRevision,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revisions: note.revisions.map((revision) => ({
      noteId: revision.noteId,
      revision: revision.revision,
      content: revision.content,
      source: canonicalSource(revision.source),
      createdAt: revision.createdAt,
    })),
  }));
}

function compareNoteIds(left: InterchangeNote, right: InterchangeNote): number {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}
