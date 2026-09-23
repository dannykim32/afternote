# Conversation Archives: Beta 6 candidate review

Review baseline: public main `a238c106eff79e9b2994c6c873a4877f250f01b9`.
Implementation reviewed through `b44548b`; the small quota/layout follow-up is
`09dbe9d`. This is candidate evidence, not public-release acceptance.

## Standards review

The independent review reported no hard violations. Its one nonblocking finding,
duplicated archive quotas in import and backup validation, was corrected by sharing
the same constants. The reviewer verified that correction without changing limits
or boundary comparisons.

## Spec review

The independent review reported no functional findings against the approved scope:
explicit file import, encrypted immutable Archives, separately approved connector
search and paged reads, a native viewer, interruption/retry, and lock/revocation.
Archives do not silently expand Note permissions or reconstruct unavailable chat
history. Archive search is exact; Note semantic search is unchanged.

## Verification before the guarded build

- Default suite: 690 passed, 10 explicitly skipped, zero failures. The guarded
  build separately runs the applicable desktop, model and performance gates.
- Storage/import follow-up: 23 passed, zero failures, including encrypted storage,
  retry, cancellation, bounded quotas, archive-inclusive backups and recovery.
- Real namespaced XPC integration: 103 assertions passed, including native file
  import, denial before Archive approval, bounded approved reads, and revocation.
- Forced terminal-audit failures roll back Archive mutations with their audit
  records; fixture content does not enter the audit log.
- Native importer exercises a million-word synthetic UTF-8 transcript, Unicode
  boundaries, malformed input, symlinks and resumable batches.
- Native viewer checks cover stale callback rejection, loading state, distinct
  search rows, page labels and text wrapping at its 820-point minimum width.

The finish reviewer accepted the four material viewer fixes at the code/test
scope. Native layer-backed controls were not fully represented by the offscreen
captures. Live keyboard/VoiceOver behavior and a complete visual pass are not
established by those captures.

## Restricted-build environment follow-up

The clean-source release attempt exposed two pre-existing ambient-runtime
assumptions: bare `tsc` required Node, and the fake Codex host's `env bun` launcher
required Bun on PATH. Typecheck now uses the invoking pinned Bun executable; the
test fixture uses a quoted absolute-runtime launcher. Release PATH and all
readiness assertions remain unchanged. Both failures were reproduced before
fixing them. The 18 focused checks pass under restricted PATH, including a fixture
path containing spaces and an apostrophe. Independent review found no issue in
either correction. The complete guarded build must still rerun from the clean
corrected commit.

That corrected build passed 691 default tests, both desktop gateway/restore
checks, bundled-model desktop readiness, the 10,000-note gate, the 97-package
OSV audit, 19 package lifecycle tests and compiled offline semantic recall.
Packaging then exposed a locale-dependent provisioning-date parser: PlistBuddy
rendered a valid 2044 date with the `WITA` timezone, which JavaScript rejected.
Typed `plutil` extraction now returns UTC RFC3339 instead. A regression reproduces
the old failure and verifies future dates, expired dates, wrong plist types and
malformed data. Both existing release profiles pass read-only preflight with the
unchanged role and entitlement checks. No credentials were changed. Independent
review found no issue; the guarded build must rerun from this correction too.

## Still required for distribution

The clean-source guarded release build, final signature/notarization verification,
and the signed-artifact acceptance steps in [RELEASING.md](RELEASING.md) remain
separate gates. Automated owner-presence fixtures are not physical Touch ID or
real Codex/Claude host acceptance. Preserve the existing beta coverage caveats;
do not report unperformed checks as passed.
