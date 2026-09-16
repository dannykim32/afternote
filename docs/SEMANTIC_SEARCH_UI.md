# Semantic-search setup in the native app

Original baseline: `45f6fca2936350a2bee832f02723ad574c8c6536` (published Alpha 25 plus feed/docs).
Model-choice/layout revision baseline: `31d83fd`.

## Scope

- Settings uses a full-width, left-aligned **Search by meaning** section with one right-aligned
  **Enable search by meaning** action. Model tiers and hardware recommendations have been
  removed from the native UI. The current development bundle is EmbeddingGemma q4 plus a
  local Ettin reranker, about 375 MB total. Download size is not memory use or a quality guarantee.
- Only the explicit enable action installs and selects the engine. Opening Settings never
  downloads it. The published Alpha 25 Light installation remains active until the user requests the upgrade.
  Installation and verification failures leave the previous selection intact. Earlier development
  Balanced snapshots without the reranker need the explicit repair action before this candidate
  considers them ready; exact search remains available. They were never published installations.
- The shared local model serves both Notes search and connected-tool Recall. Agent-written
  search metadata is a separate feature and is not included here.
- Show checking, downloading/verifying, installed, indexing, active, and retryable failure states.
  Navigation and late status replies must not trigger duplicate installations or hide failures.
- Use the authentic packaged command and existing pinned-download verification. Never install
  automatically on app launch or merely by opening Settings. Keep stdout machine-readable.
- Activate a newly installed model through the authenticated Library broker interface without
  restarting the vault, discarding editor drafts, revoking connectors, or changing note revisions.
  A locked vault or expired/missing Library session must not be bypassed. Offer normal Notes
  authentication when needed; that existing flow retains its draft/authorization rules.
- Exact search remains usable while indexing and after failure. The release default stays exact.
  No agent-generated note metadata or automatic download is in scope. Model quality at scale
  and signed-build acceptance remain publication gates; the current candidate is not cleared for publication.
- Tests cover the existing storage/retrieval and owner-broker boundaries, native Settings action
  flow and stale replies, CLI JSON output, installation failures, and existing lifecycle behavior.

## Retrieval boundary

UI search and MCP Recall share the local index and, with the new engine, the same
semantic relevance and ranking rules. Legacy embedding-only profiles retain their historical cutoffs. Host models may reformulate queries, but do not see
notes that retrieval did not return. The current agent Remember input contains note text; verified
connector attribution is attached by Afternote. Search-hint metadata requires a separate design.

## Release

Do not replace or retag the accepted Alpha 25 artifact. Ship this in a new version after normal
release gates and signed-build acceptance. No release credentials or policies change here.

## Signed-build acceptance before publication

Use a new release version. Keep the accepted Alpha 25 artifacts intact.

1. On a Mac without a model, open Settings. Verify the single enable action,
   download details, and wrapping at normal and minimum window widths. Verify no download until clicked. Confirm the notice covers Notes and connected tools.
2. Interrupt a download, then retry. Navigate to Notes and back; an installation failure
   must remain visible. Verify the downloaded files and runtime load before accepting readiness.
3. With an authenticated Notes session and an unsaved editor draft, install the engine and upgrade a legacy installation
   while indexing and while polling status. An old model reply must not mark a new model active.
   Verify indexing completes, the draft remains intact, and existing notes keep their revisions.
4. With the vault locked or Notes expired, verify installation cannot read/index notes until
   normal Notes authentication. Lock during indexing; late status replies must not restore access.
5. Save a synthetic note and try a paraphrase in Notes and through each approved connector.
   Inspect the returned original citation. Verify both surfaces find the same note;
   a particular paraphrase is not guaranteed to match. Verify exact search continues to work.
6. Relaunch and confirm the model is reused without downloading again. Recheck signed helper
   execution, doctor, release provenance, update behavior, and the existing connector smoke gates.

## Model-specific runtime contracts

Each profile has a pinned revision and per-file size/SHA-256 allowlist. No user-provided model
URL or path is accepted by the installer. Model selection is private, bounded local JSON.
Gemma uses task-specific query/document prefixes and its projected sentence embedding output.
Qwen uses query instructions, left padding, and last-token pooling. Vectors from different
models cannot mix: switches invalidate cached vectors, retire queued indexing work, and reject
in-flight old query results. Indexing cancellation is checked between inference batches.
Rebuilds commit progress in batches of 32 notes; a restart resumes the missing work.
The authenticated refresh reply identifies the active model and displays indexed/total counts. Status polls do not reload or
rehash model weights; an install during a pending poll queues a fresh activation.
