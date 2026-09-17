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

## Beta 5 checkpoint — September 17, 2026

Accepted artifact: `2.0.0-beta.5`, Apple build `31`, source
`706421b2ab4e01c4b77f9e668d658ee2246da6c0`. DMG SHA256:
`ea96f357a6b0ff73ce9737f979bc29efff1fb1cbd7ea11987c9662f4fb32d364`.

The clean release pipeline passed type checking, 644 default-suite tests (10 explicit
skips), native gateway integration, actual bundled-model AppKit readiness, 10,000-note
performance, dependency audit, package lifecycle and compiled offline recall gates. The
signed, notarized final DMG separately passed integrity, Gatekeeper, model hashes and
network-denied model startup with fresh temporary configuration.

The native readiness regression reproduced a synchronous worker wait starving model
preparation even with a complete index. Beta 5 fixes that wait without changing the model
or embedding format. Founder acceptance on the affected second Mac confirmed readiness,
Codex retrieval of a note saved via Claude Desktop, and working revocation.

Coverage limits remain explicit: native fixtures simulate owner approval, package lifecycle
checks use isolated test installations, and the final read-only verification does not install
the app as a new macOS user. The targeted founder report does not independently establish
all three hosts and every approval/update/recovery path on this exact build. Carry these
coverage gaps into the non-founder beta trial; do not represent them as completed checks.

Known limitation: MCP recall does not yet return search-mode information. While local
semantic search is preparing or unavailable, an AI host can receive exact-search results
without knowing that fallback occurred. Check Notes for readiness; an empty result alone
is not evidence that the vault contains no relevant note. This is an engineering follow-up,
not a change to the accepted retrieval benchmark tradeoffs above.
