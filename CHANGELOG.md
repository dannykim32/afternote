# Changelog

This project follows [Semantic Versioning](https://semver.org/) for public source and
binary releases. Until the first public tag, changes remain under Unreleased.

## Unreleased

### Added

- Native Apple Silicon Mac app with an encrypted local vault.
- Scoped Remember and Recall connectors for Codex and Claude Code.
- Exact, temporal, and optional local semantic retrieval with cited source evidence.
- Signed lifecycle tooling for install, upgrade, rollback, uninstall, and reinstall.
- Generated SPDX SBOM, license inventory, and third-party notices.

### Fixed

- Notes refresh when the app becomes active, so connector saves show up without restarting it.
- Revision history stays available from cited search results. Unchanged saves no longer create a
  revision, and the editor now has an explicit discard action.
- Settings tracks the real vault state and can unlock a locked vault.
- Routine authentication for Notes, Connections, Codex, and Claude Code defaults to once a
  day, with 15-minute and four-hour options. Sensitive actions still ask for fresh approval.
- The Mac installer opens in a compact Finder window with properly sized install icons.
- Removed the teal rule beside search results.

### Security

- Worker requests now use a mutually signed, PID-bound post-exec XPC channel instead of
  inherited standard streams.
- Public releases build from a fresh detached checkout, reject ambient compiler inputs,
  record the installed dependency tree and toolchain, and bind the embedded app runtime to
  payload manifest v2.
- Uninstall fails closed when launchd still reports the broker active.
- The SQLCipher key is stored in the data-protection Keychain and is available only while
  the device is unlocked to the signed worker access group.
- Connector sessions end on screen lock, sleep, logout, manual lock, and broker restart.
- Release builds pin the dependency graph and native inputs, verify host and internal code
  identities, redact internal errors, and bind packaged payloads to a signed manifest.
- Browser and Slack connector experiments are intentionally excluded from this candidate.

No public binary or source release has been made from this candidate.
