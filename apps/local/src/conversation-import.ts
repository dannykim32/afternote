import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setImmediate as yieldToCaller } from "node:timers/promises";
import { MemoryError } from "@afternote/memory";
import {
  MAX_ARCHIVE_BATCH, MAX_ARCHIVE_BYTES, MAX_PASSAGE_CHARACTERS,
  type ArchiveManifest, type ConversationArchive,
} from "./conversation-archives";

// The file reader runs in the Owner's process; a broker adapter can implement this
// bounded interface without giving the broker or any Connector a filesystem path.
export interface ArchiveImportDestination {
  begin(manifest: ArchiveManifest): ConversationArchive | Promise<ConversationArchive>;
  status(id: string): ConversationArchive | Promise<ConversationArchive>;
  append(id: string, startIndex: number, passages: string[]): ConversationArchive | Promise<ConversationArchive>;
  complete(id: string): ConversationArchive | Promise<ConversationArchive>;
}

export type ArchiveImportProgress = {
  phase: "verifying" | "saving" | "saved";
  totalBytes: number;
  savedBytes: number;
  archiveId?: string;
};

export type ArchiveImportOptions = {
  resumeId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveImportProgress) => void;
};

export async function importConversationFile(
  path: string,
  title: string,
  destination: ArchiveImportDestination,
  options: ArchiveImportOptions = {},
): Promise<ConversationArchive> {
  options.signal?.throwIfAborted();
  if (!isAbsolute(path)) throw new MemoryError("invalid_input", "Select an absolute transcript file path");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile() || file.size < 1 || file.size > MAX_ARCHIVE_BYTES) {
      throw new MemoryError("invalid_input", "Transcript must be a nonempty regular file of at most 64 MiB");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of fileChunks(descriptor)) {
      options.signal?.throwIfAborted();
      bytes += chunk.length;
      hash.update(chunk);
      options.onProgress?.({ phase: "verifying", totalBytes: file.size, savedBytes: 0 });
    }
    options.signal?.throwIfAborted();
    const sha256 = hash.digest("hex");
    const archive = options.resumeId
      ? await destination.status(options.resumeId)
      : await destination.begin({ title, bytes, sha256 });
    if (archive.sha256 !== sha256 || archive.expectedBytes !== bytes || archive.title !== title) {
      throw new MemoryError("conflict", "Selected transcript does not match the pending Archive");
    }
    const report = (value: ConversationArchive) => options.onProgress?.({
      phase: value.state === "ready" ? "saved" : "saving", totalBytes: bytes,
      savedBytes: value.savedBytes, archiveId: value.id,
    });
    report(archive);
    options.signal?.throwIfAborted();
    if (archive.state === "ready") return archive;
    const batch: string[] = [];
    let index = 0;
    for await (const passage of textPassages(descriptor)) {
      options.signal?.throwIfAborted();
      batch.push(passage);
      if (batch.length === MAX_ARCHIVE_BATCH) {
        report(await destination.append(archive.id, index, batch));
        index += batch.length;
        batch.length = 0;
      }
    }
    options.signal?.throwIfAborted();
    if (batch.length) report(await destination.append(archive.id, index, batch));
    options.signal?.throwIfAborted();
    const saved = await destination.complete(archive.id);
    report(saved);
    return saved;
  } finally { closeSync(descriptor); }
}

async function* fileChunks(descriptor: number): AsyncGenerator<Buffer> {
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (true) {
    const count = readSync(descriptor, buffer, 0, buffer.length, position);
    if (!count) break;
    position += count;
    if (position > MAX_ARCHIVE_BYTES) throw new MemoryError("invalid_input", "Transcript exceeds 64 MiB");
    yield buffer.subarray(0, count);
    await yieldToCaller();
  }
}

async function* textPassages(descriptor: number): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = "";
  for await (const bytes of fileChunks(descriptor)) {
    pending += decoder.decode(bytes, { stream: true });
    const characters = Array.from(pending);
    let offset = 0;
    while (characters.length - offset >= MAX_PASSAGE_CHARACTERS) {
      let end = offset + MAX_PASSAGE_CHARACTERS;
      // Keep ordinary words whole; a single oversized unbroken token still has
      // to obey the transport bound. Whitespace remains part of the transcript.
      for (let boundary = end; boundary > offset + MAX_PASSAGE_CHARACTERS / 2; boundary--) {
        if (/\s/u.test(characters[boundary - 1]!)) { end = boundary; break; }
      }
      yield characters.slice(offset, end).join("");
      offset = end;
    }
    pending = characters.slice(offset).join("");
  }
  pending += decoder.decode();
  if (pending) yield pending;
}
