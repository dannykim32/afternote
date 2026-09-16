# Search by meaning in Beta 1

Implementation baseline: `6b92d220bf3da9659a57e36ab237e318794cdf97` (Alpha 26).
The September 16 decision supersedes the Alpha 26 opt-in download flow.

## Scope and acceptance

- Ship one included engine: pinned EmbeddingGemma Q4 plus Ettin ARM INT8. No model-tier UI
  or first-run download. Include licenses, use restrictions and file digests in the sealed app.
- Search by meaning defaults on for Notes and approved connected-tool Recall. A right-aligned
  Enabled checkbox in Settings persists an explicit off choice. Show preparing, ready, off,
  missing/tampered files and activation failure clearly. Model terms are accessible in Settings.
- Opening an unlocked vault prepares the local runtime and indexes notes. Saving and editing
  queue derived indexing automatically. Immediate semantic recall can await indexing within
  its existing time budget; an exact match must remain immediately available while indexing.
- Settings changes use the authenticated Library refresh endpoint. A locked vault, expired
  session or revoked connector cannot be bypassed. Late replies cannot restore protected UI.
- Disable and model replacement retire queued inference; pending queries must not disclose
  stale note content. Existing authority, encryption, export and revision behavior stays intact.
- Runtime/model failures fall back visibly to exact search. A missing or invalid bundled model
  never initiates a network download. Reinstall repairs immutable model files; restarting the
  vault retries runtime preparation. Note data must survive either recovery.
- Keep Alpha 25 and Alpha 26 artifacts intact. Build a new Beta 1 with monotonically increasing
  Apple build number. Run type checking, focused tests, full suite, package/install checks,
  signed release pipeline, and independent signed artifact verification. Record remaining
  human-presence and second-Mac acceptance honestly; do not treat developer fixtures as those.
- Prepare announcement copy about explicit saving, useful recall across apps, granular access
  and security. Do not publish an announcement without the founder's final review.

## Beta quality

Useful everyday recall is the product bar. The existing measured limitations in
[BETA_READINESS.md](BETA_READINESS.md) are accepted. No additional model shopping,
agent-generated metadata, or perfect synthetic benchmark target is required.
