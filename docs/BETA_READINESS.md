# Beta release bar

## Decision — September 15, 2026

Proceed with the current single-engine semantic-search candidate into release acceptance.
Useful everyday recall, sound access controls, and dependable installation matter more for
this beta than perfect scores on small synthetic search fixtures. This explicitly supersedes
the earlier decision to block publication solely on learned-model recall and latency targets.
It does not declare an unbuilt or untested signed artifact ready to publish.

Keep the measurements and failed benchmark flags intact. The current candidate finds all
16 intended targets first in the fresh V3 set and rejects its 8 unsupported questions. At
10,000 notes it finds 12/14 semantic targets, versus 13/14 for the embedding-only baseline,
and takes roughly 0.6–0.7 seconds at p95. First search in the process-restart probe takes
1.3–1.4 seconds. These are accepted beta tradeoffs, subject to the ordinary-use check below.
[Evidence and limits](evals/2026-09-15-reranked-recall/README.md).

## What must hold

- Note access still requires the correct live authority. Lock, expiry and revocation must
  stop access; delayed searches must not expose stale note revisions or restore access.
- Saving, editing, upgrading and recovery must preserve note data and revision integrity.
- The beta includes pinned, verified models and enables local search by default. Failure is
  visible and does not bypass authentication or corrupt the vault.
- Exact search and original note citations remain usable. Semantic results are retrieved
  notes to assess, not verified answers or confidence probabilities. Occasional misses and
  related-but-unhelpful results are expected beta limitations.
- The reviewed artifact must pass the existing automated release pipeline, signing,
  notarization, clean-user installation and connector acceptance requirements. Development
  tests and a compiled model probe do not substitute for those artifact checks.

The existing automated fixture/performance gates remain unchanged. Learned-model evaluation
reports are a separate source of product evidence, not a reason to bypass failing release
commands or relax security checks. No new model tiers, relevance labels, model comparisons,
or agent-generated metadata are prerequisites for this beta.

## Bounded semantic acceptance on the next signed candidate

Use synthetic notes and the normal authenticated app and connector flows:

1. Launch without a model cache or network. Confirm search by meaning is enabled and its
   preparation state is understandable. Toggle off/on. Note contents must stay unchanged.
2. Recall a few ordinary notes using different words in Notes and in an approved AI tool;
   inspect the original text/citation. Also find an exact identifier. The aim is useful
   everyday retrieval, not 100% success on every wording.
3. Relaunch and try a first search. Confirm the app remains responsive, results arrive, and
   a failure or fallback is visible and recoverable. Repeated ordinary-search timeouts or
   an apparently broken search experience are bugs to fix, not accepted benchmark minutiae.
4. Lock and revoke while exercising search. Verify the next tool request cannot retrieve
   notes, the UI clears protected content, and late results cannot bring it back. Then
   recover through the supported approval/reconnection flow.
5. Interrupt indexing and retry/relaunch. Confirm exact search remains
   available when authorized and the semantic setup can recover without resetting the vault.

Run these alongside the existing clean-user and connector acceptance, using the exact new
signed artifact. Do not repeat model experiments unless a real acceptance failure warrants it.

## Current checkpoint

Source: semantic implementation `206faf7`; preserved evaluation checkpoint `78685ca`.
The full suite passed 631 tests with 10 explicit skips; type checking and the separate
compiled local-model installation/query check passed. These are development checks, not a
new independent security audit or signed-release acceptance. The next work is release
preparation and the bounded checks above. Existing Alpha 25 artifacts remain unchanged.
