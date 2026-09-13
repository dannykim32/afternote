# Changelog

This project follows [Semantic Versioning](https://semver.org/) for public source and
binary releases. Changes intended for the next public tag may be staged under their version
during release review.

## Unreleased

## 2.0.0-alpha.18 - 2026-09-13

### Added

- Share-safe diagnostics now compare coarse per-connector Note-attribution buckets with
  Remember, Recall, and Get Note audit-outcome buckets. This makes activity-counter failures
  diagnosable without exposing note text, note IDs, local paths, or event timestamps.

### Security

- Connector activity diagnostics remain behind fresh owner approval, cross the signed native
  broker boundary, and are strictly validated before the CLI or app can display or save them.

## 2.0.0-alpha.17 - 2026-09-13

### Fixed

- Existing encrypted vaults remain readable across upgrades because the vault worker's
  Keychain access group is now derived from its signed role rather than release-operator input.
- Connections refreshes its share-safe saved and recalled counts whenever Afternote returns
  to the foreground, including activity from Claude Desktop.

### Security

- Release construction rejects an operator-supplied vault Keychain group and inspects the
  actual signed worker and client-signer entitlements before notarization.

## 2.0.0-alpha.16 - 2026-09-12 (withdrawn)

### Fixed

- Connections now refreshes its share-safe saved and recalled counts whenever Afternote
  returns to the foreground, so Claude Desktop activity appears without a manual refresh
  or owner-authentication prompt.

### Known issue

- Withdrawn because the vault worker was signed with the client-signing Keychain access group,
  preventing upgraded installations from reading their existing installation-bound vault key.

## 2.0.0-alpha.15 - 2026-09-12

### Fixed

- Codex, Claude Code, and Claude Desktop now share the configured routine-authentication
  window across broker restarts. Locking the vault, changing the policy, or reaching the
  configured expiry still requires fresh owner approval.
- Connections refreshes without asking for Touch ID and reports durable saved and recalled
  counts for every connector, including Claude Desktop.
- Claude Desktop saves use broker-verified connector attribution instead of optional
  model-supplied source metadata, preventing metadata failures or source spoofing.

### Security

- Persistent routine authorization stays inside the encrypted broker database. Newly signed,
  paired connector processes receive fresh connection-bound least-privilege sessions; prior
  process sessions remain invalid after a broker restart.

## 2.0.0-alpha.14 - 2026-09-12

### Added

- Claude Desktop support through a minimal local MCPB package. Afternote verifies Anthropic's
  signed app, creates a separate device-bound connector identity, and leaves extension approval
  to Claude's own install dialog.

### Security

- Claude Desktop runs through the same signed broker boundary and least-privilege Remember,
  Recall, and Get Note grant as the existing connectors. Its authority, revocation, and reconnect
  state remain separate from Claude Code. Runtime admission verifies both Anthropic's direct
  launcher and its signed Claude Desktop parent, so the general-purpose launcher cannot be used
  by an unrelated process to impersonate Claude.

## 2.0.0-alpha.13 - 2026-09-12

### Fixed

- Recall and Get Note now recover inside an existing Codex or Claude Code session when the
  native broker restarts during an app upgrade. If the vault is locked, the connector reports
  that state instead of exposing a stale XPC transport error.
- Remember remains single-attempt across an ambiguous transport failure, preventing an automatic
  retry from creating a duplicate note when the original save may have completed.

## 2.0.0-alpha.12 - 2026-09-10

### Added

- Signed in-app update checks for official releases, with a manual Check for Updates command
  and a configurable daily background check.
- A guarded Sparkle appcast step that signs the notarized DMG and fails the release if the
  expected version, byte length, HTTPS URL, or EdDSA signature is missing.

### Security

- Pinned Sparkle 2.9.6 by archive digest, embedded and re-signed its release framework, and
  added it to the generated SBOM and third-party license inventory.
- Update checks send no optional system profile. Downloads and installation always require
  user approval, and both the feed and update archive must pass EdDSA verification.

## 2.0.0-alpha.11 - 2026-09-10

### Fixed

- Refreshing Connections now rescans Codex and Claude Code connector installation state, so
  connector changes made with the Afternote CLI appear without restarting the app.

## 2.0.0-alpha.10 - 2026-09-09

### Fixed

- Development archives now refuse to replace an existing Developer ID installation, preventing
  an ad-hoc broker from being selected for a vault protected by the release Keychain identity.
- Source-built apps identify themselves to macOS as Afternote Development with a separate bundle
  identifier, so Finder and the Dock do not present them as the signed Afternote app.

## 2.0.0-alpha.9 - 2026-09-08

### Added

- Native Apple Silicon Mac app with an encrypted local vault.
- Scoped Remember and Recall connectors for Codex and Claude Code.
- Exact, temporal, and optional local semantic retrieval with cited source evidence.
- Signed lifecycle tooling for install, upgrade, rollback, uninstall, and reinstall.
- Generated SPDX SBOM, license inventory, and third-party notices.
- Public quick start, synthetic product screenshot, architecture overview, and an explicit
  alpha.8-to-alpha.9 compatibility test.

### Changed

- Connector installation and health checks now share one lifecycle module with Codex and
  Claude Code adapters.
- Owner-presence challenge claims, derived-index lifecycle, release policy, native XPC
  transport, and product-surface routing now have explicit interfaces and focused tests.
- Removed dormant telemetry consent plumbing and other stale pre-publication surfaces.

### Fixed

- Notes refresh when the app becomes active, so connector saves show up without restarting it.
- Revision history stays available from cited search results. Unchanged saves no longer create a
  revision, and the editor now has an explicit discard action.
- Settings tracks the real vault state and can unlock a locked vault.
- Routine authentication for Notes, Connections, Codex, and Claude Code defaults to once a
  day, with 15-minute and four-hour options. Sensitive actions still ask for fresh approval.
- The Mac installer opens in a compact Finder window with properly sized, centered install icons.
- App startup repairs a missing `~/.local/bin/afternote` command link when the private runtime is
  already installed and valid.
- Removed the teal rule beside search results.
- Codex discovery and uninstall now cover standard user, Homebrew, and application-bundle
  installations; successful uninstall warnings are shown to the user.
- Configuration-time and runtime connector checks now enforce the same full Developer ID
  requirement.
- Broker replay records are pruned after their useful validation window.

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
