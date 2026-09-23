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

## Still required for distribution

The clean-source guarded release build, final signature/notarization verification,
and the signed-artifact acceptance steps in [RELEASING.md](RELEASING.md) remain
separate gates. Automated owner-presence fixtures are not physical Touch ID or
real Codex/Claude host acceptance. Preserve the existing beta coverage caveats;
do not report unperformed checks as passed.
