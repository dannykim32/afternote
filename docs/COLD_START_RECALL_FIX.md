# Cold-start Recall release gate

## Scope

Fix the intermittent immediate-paraphrase failure in the unchanged Beta 6
candidate, `f570a2e`. The Owner approved regression coverage at the broker's
save/search/readiness interfaces and the compiled offline semantic check,
including slow startup and lock/revoke during startup. Review this fix against
that commit. These ordinary Note fixes remain part of Beta 7 independently of the
retired, unreleased Conversation Archives experiment.

The release remains gated on automated verification and manual acceptance of
the signed candidate. A passing retry alone is not evidence that a failure is fixed.

## Behavior

- Remember commits canonical Notes without waiting for the semantic engine.
- A broker search that needs semantics may wait up to ten seconds for local
  inference preparation before beginning its existing bounded query work.
  This is not a wait for an entire large-library index rebuild.
- Exact evidence remains available during startup. Warm searches do not repeat
  the startup lexical probe. The probe uses the existing SQLite work deadline.
- Stalled preparation returns `unavailable`, not a successful empty search.
  A later request can succeed when preparation completes.
- Connector Recall cannot expose the Library's search-mode field. If semantic
  work is incomplete and has no exact fallback, it returns `unavailable` rather
  than implying that no matching Note exists. A completed search with no match
  still returns an empty result.
- Normal semantic work retains its 1.5-second budget and existing SQLite limits.
  Only Connector Recall receives a 15-second transport budget to accommodate
  bounded startup. Explicit transport overrides and mutation budgets are unchanged.
- Authority is checked after startup and before returning asynchronous Connector
  reads. Library search remains bound to its original session before lookup and
  before returning results. Lock, expiry, revocation, and session replacement
  cannot turn late work into new access. The serialized production broker still
  processes lifecycle requests in order; a queued lock is not a preemptive interrupt.

## Regression evidence and acceptance

Regression cases cover delayed preparation, exact fallback, stalled preparation
and retry, Library lock/replacement/expiry, Connector expiry/revocation, and slow
query inference. They use isolated encrypted Vaults and a controllable inference
adapter; no installed Vault or Keychain item is modified.

The compiled offline check must retain its immediate Recall assertion, included
model pins, encrypted storage check, both Connector canaries, and index readiness
assertions. Do not add sleeps or retries to make its first Recall pass.

On a newly built signed candidate, run these ordinary Note checks:

1. Fully quit and reopen Afternote. Immediately save a synthetic Note and ask a
   Connector for it using a paraphrase with no literal match. Verify its citation.
2. Repeat with Notes search after reopening. Exact identifiers should remain
   searchable while semantic startup is in progress.
3. Lock the Vault and verify Connector Recall fails. Unlock and verify the normal
   authorization flow resumes without losing Notes or Revisions.
4. Revoke a Connector and verify it cannot retrieve a Note until explicitly
   reconnected. Check that Settings still uses the configured authentication policy.
5. If search reports temporary unavailability, record the error and diagnostics;
   do not interpret it as a successful no-match result or clear the Vault.
