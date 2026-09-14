# Changelog

This project follows [Semantic Versioning](https://semver.org/) for public source and
binary releases. Changes intended for the next public tag may be staged under their version
during release review.

## Unreleased

## 2.0.0-alpha.23 - 2026-09-14

### Changed

- Separate native Connections rendering, Note-editor drafts and controls, and submitted
  retrieval state from the app coordinator, with standalone behavioral tests.
- Isolate Note schema upgrades and verified backups, native broker result validation,
  and audit-history pagination in focused modules.
- Make broker method/role routing explicit while preserving replay, recovery, vault-lock,
  and handler-authorization ordering. Wire validation and peer-safe errors now have
  their own tested module.
- Expand first-run instructions and document module ownership and remaining engineering work.

### Fixed

- Center Connections content and align its action columns; present connector repair as
  a quieter contextual action alongside revocation.

Release candidate: packaging, notarization, and second-Mac acceptance are pending.
See the [prelaunch smoke test](docs/PRELAUNCH_SMOKE_TEST.md); Alpha 22 does not contain
these changes.

## 2.0.0-alpha.22 - 2026-09-13

### Fixed

- Claude Desktop activity remains attributed to Claude Desktop when its tool selector routes
  through the bundled Claude Code process and intervening signed `disclaimer` helper.
- Claude Desktop bridge detection supports both verified two-level and three-level launch
  layouts without depending on usernames, installation paths, process IDs, or Mac models.

### Security

- Cross-surface attribution now uses a bounded native ancestor-chain verifier. Every process in
  an accepted layout must satisfy its exact Anthropic code-signing requirement, and the chain is
  rechecked after validation to reject process changes during authorization.

## 2.0.0-alpha.21 - 2026-09-13

### Fixed

- Added signed host-chain attribution for Claude Desktop requests that arrive through the
  user-scoped Claude Code MCP registration. This release modeled a two-level bridge; Alpha 22
  extends it to Claude Desktop's observed intervening-helper layout.
- A repairable connector now keeps its **Repair Afternote** action visible when an older broker
  connection still has active authority; revocation remains available as a separate action.

### Security

- Cross-surface Claude attribution, connector identity, authorization, audit events, and source
  metadata are bound to the authenticated host process rather than the host-selected MCP name.

## 2.0.0-alpha.20 - 2026-09-13

### Fixed

- Claude Code now uses the distinct `afternote-claude-code` MCP registration name so it no
  longer collides with Claude Desktop's `afternote` extension registration.
- Existing Afternote-owned Claude Code registrations named `afternote` are detected as a
  repairable legacy configuration and migrated transactionally without touching unrelated
  MCP servers.

### Changed

- Connector-bound MCP tools identify Codex, Claude Code, or Claude Desktop in their titles and
  instructions so hosts can choose the connector matching the active surface.

## 2.0.0-alpha.19 - 2026-09-13

### Fixed

- Runtime activation now verifies that the broker reports the package version being installed.
  A responding broker from the previous version is restarted instead of leaving the app and
  broker on incompatible response contracts.
- Reopening an already installed version repairs a stale broker as well as the public command
  link, so an interrupted upgrade can recover without removing the Vault or its Keychain item.

### Testing

- The package suite now covers version-skewed broker activation, same-version repair, and the
  exact diagnostics contract shared by the TypeScript broker and native CLI validator.

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
