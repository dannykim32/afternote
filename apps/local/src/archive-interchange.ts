import { createHash } from "node:crypto";
import type { ConversationArchive } from "./conversation-archives";
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_PASSAGES, MAX_PASSAGE_CHARACTERS, MAX_VAULT_ARCHIVE_PASSAGES } from "./conversation-archive-limits";

export type InterchangeArchive = ConversationArchive & { passages: string[] };
export type StreamingInterchangeArchive = ConversationArchive & { passages: () => Iterable<string> };

/** Stable field order shared by the streaming writer and the validating reader. */
export function* archiveJson(archive: StreamingInterchangeArchive): Iterable<string> {
  yield JSON.stringify({
    id: archive.id, title: archive.title, state: archive.state,
    expectedBytes: archive.expectedBytes, sha256: archive.sha256,
    savedBytes: archive.savedBytes, passageCount: archive.passageCount, createdAt: archive.createdAt,
  }).slice(0, -1) + ',"passages":[';
  let first = true;
  for (const passage of archive.passages()) {
    yield (first ? "" : ",") + JSON.stringify(passage);
    first = false;
  }
  yield "]}";
}

export function validateInterchangeArchives(value: unknown): asserts value is InterchangeArchive[] {
  if (!Array.isArray(value) || value.length > 4096) invalid();
  const ids = new Set<string>();
  let reserved = 0;
  let totalPassages = 0;
  let pending = 0;
  for (const archive of value) {
    if (!archive || typeof archive !== "object" || Array.isArray(archive) ||
        Object.keys(archive).sort().join(",") !==
        "createdAt,expectedBytes,id,passageCount,passages,savedBytes,sha256,state,title") invalid();
    if (typeof archive.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(archive.id) || ids.has(archive.id)) invalid();
    ids.add(archive.id);
    if (!validText(archive.title, 200) || typeof archive.createdAt !== "string" ||
        !Number.isFinite(Date.parse(archive.createdAt)) || new Date(archive.createdAt).toISOString() !== archive.createdAt ||
        typeof archive.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(archive.sha256) ||
        !integer(archive.expectedBytes, 1, MAX_ARCHIVE_BYTES) ||
        !integer(archive.savedBytes, 0, archive.expectedBytes) ||
        !integer(archive.passageCount, 0, MAX_ARCHIVE_PASSAGES) ||
        !Array.isArray(archive.passages) || archive.passages.length !== archive.passageCount ||
        (archive.state !== "importing" && archive.state !== "ready")) invalid();
    reserved += archive.expectedBytes;
    totalPassages += archive.passageCount;
    if (archive.state === "importing") pending++;
    if (reserved > 256 * 1024 * 1024 || totalPassages > MAX_VAULT_ARCHIVE_PASSAGES || pending > 8) invalid();
    let bytes = 0;
    const hash = createHash("sha256");
    for (const passage of archive.passages) {
      if (!validText(passage, MAX_PASSAGE_CHARACTERS)) invalid();
      bytes += Buffer.byteLength(passage);
      hash.update(passage);
    }
    const sha256 = hash.digest("hex");
    if (bytes !== archive.savedBytes || (archive.state === "ready" &&
        (bytes !== archive.expectedBytes || sha256 !== archive.sha256))) invalid();
  }
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max * 2 &&
    !/[\uD800-\uDFFF]/u.test(value) && Array.from(value).length <= max;
}

function invalid(): never { throw new Error("Interchange Archive is invalid or exceeds Vault limits"); }
