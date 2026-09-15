# Semantic-search setup in the native app

Baseline: `45f6fca2936350a2bee832f02723ad574c8c6536` (published Alpha 25 plus feed/docs).

## Scope

- Settings offers an explicit **Install semantic search** action, explains the approximately
  23 MB local model download, and states that both Notes search and connected-tool Recall use it.
- Show checking, downloading/verifying, installed, indexing, active, and retryable failure states.
  Navigation and late status replies must not trigger duplicate installations or hide failures.
- Use the authentic packaged command and existing pinned-download verification. Never install
  automatically on app launch or merely by opening Settings. Keep stdout machine-readable.
- Activate a newly installed model through the authenticated Library broker interface without
  restarting the vault, discarding editor drafts, revoking connectors, or changing note revisions.
  A locked vault or expired/missing Library session must not be bypassed. Offer normal Notes
  authentication when needed; that existing flow retains its draft/authorization rules.
- Exact search remains usable while indexing and after failure. The release default stays exact.
  No agent-generated note metadata, new model, automatic download, or default change is in scope.
- Tests cover the existing storage/retrieval and owner-broker boundaries, native Settings action
  flow and stale replies, CLI JSON output, installation failures, and existing lifecycle behavior.

## Retrieval boundary

UI search and MCP Recall share the local index. Their ranking thresholds differ: UI search is
more exploratory; agent Recall is stricter. Host models may reformulate queries, but do not see
notes that retrieval did not return. The current agent Remember input contains note text; verified
connector attribution is attached by Afternote. Search-hint metadata requires a separate design.

## Release

Do not replace or retag the accepted Alpha 25 artifact. Ship this in a new version after normal
release gates and signed-build acceptance. No release credentials or policies change here.
