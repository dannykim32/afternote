# Conversation Archives

Status: implementation in progress. Not part of the published Beta 5 release.
Review baseline: `a238c106eff79e9b2994c6c873a4877f250f01b9`.

## Checkpoint 1

Storage and the streaming file importer are implemented and exercised with
synthetic encrypted Vaults. They are not wired to the CLI, MCP, or native app.
Existing Note export fails closed when Archives exist until the next checkpoint
adds an Archive-aware interchange format. No public build should enable import
with that gate outstanding.

Still required: broker authorization/audit integration, transactional export and
restore, approved deletion, Connector tools, the native viewer, and end-to-end
lock/revoke tests. Connector archive-read permission policy is awaiting the Owner's
choice; do not silently expand existing grants.

## Intent

The Owner explicitly imports a real transcript too large for an ordinary Note.
Afternote preserves it as one immutable Archive in the encrypted Vault. A Connector
retrieves relevant Passages or bounded pages, never the entire Archive by default.
This is not automatic conversation capture or a promise that an AI host can
reconstruct history no longer in its context.
Import does not modify or remove the original transcript file. That source file
remains outside the encrypted Vault; its contents are not made private by import.

## First delivery

- UTF-8 text/Markdown transcript import, byte-for-byte preservation. Existing
  speaker labels and timestamps remain text; do not infer missing metadata.
- Bounded, ordered, retry-safe batches with durable import progress. Incomplete
  Archives cannot appear in search or normal reads. Completion verifies size and
  SHA-256. Cancellation removes the partial Archive.
- Separate canonical Archive/Passage storage and rebuildable search index, inside
  the existing encrypted Vault. Ordinary Note limits do not change.
- Native import, progress, list, search, and paged read-only viewer. Lock and
  session invalidation clear plaintext and reject stale completions.
- Authenticated Connector passage search/read; revocation and vault lock apply.
  Transcript content is untrusted data, never instructions. Returned passages can
  leave the Mac when supplied to a connected AI provider.
- Export/restore and deletion must include Archives before enabling import in a
  user build. No silent omission from a successful Vault backup.
- Exact passage indexing first; semantic passage indexing must be explicitly
  reported as unavailable until its incremental, resource-bounded path exists.
  A saved Archive is not a claim that semantic indexing finished.

## Bounds and storage contract

The initial ceiling is 64 MiB of UTF-8 per Archive (size, not token count), 32,768
Passages, 8,192 Unicode characters per Passage, and eight Passages per append.
At most eight incomplete imports, 4,096 Archives, 32,768 total Passages and
256 MiB of canonical Archive text per Vault. Both text and row counts are bounded.
Read pages return at most eight Passages. Search returns at most twenty excerpts.
Reject invalid UTF-8, empty transcripts, invalid bounds, changed retry payloads,
out-of-order writes, and content that disagrees with its import manifest.

The Archive storage module borrows the broker-owned database; it does not open a
Vault, retain its key, or confer authorization. The caller must authorize every
operation and stop import/read work when the Vault or Connection is invalidated.
Archive schema work uses the verified pre-migration backup path. Canonical writes
and synchronous index projections commit together. Content hashes detect transfer
errors; they are not substitutes for authorization.

## Verification and release gates

The Owner approved tests at transcript import/encrypted storage, authenticated
search/paged reads, and the native viewer. Use synthetic transcripts only. Exercise
interruption/retry, cancellation, integrity failures, lock/revoke, large input,
Unicode boundaries, export/restore, migration backups, and ordinary Note regression.

Delivery checkpoints: storage and streaming import; broker/CLI and backup lifecycle;
Connector retrieval; native viewer and end-to-end verification. An internal
checkpoint is not a shipped feature. No release, signing, publication, or production
Vault modification is authorized by this implementation task.

## Later

Provider-specific structured exports, connector-driven capture, attachments,
optional labeled summaries, and cross-device sync are separate work. Do not raise
transport limits or let Connectors read arbitrary filesystem paths to support this.
