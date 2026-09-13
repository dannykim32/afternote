# Enterprise security review

This page is the short version for security and IT teams. It describes the first Apple
Silicon alpha as it exists today, including the reasons an organization may decide not to
approve it.

## Conditional recommendation

Afternote should be approved only for notes the organization already permits in its configured
Codex, Claude Code, or Claude Desktop environment. IT also needs to accept three limits: this is alpha software,
ordinary uninstall preserves encrypted user data and Keychain identity, and there is no current
fleet-management or application-level secure-erase workflow.

If any of those are disqualifying, do not deploy it yet.

## What runs

Afternote installs entirely in the current macOS account. A per-user LaunchAgent named
`dev.afternote.vault-broker` starts at login and keeps the native gateway available. The gateway
launches a private worker when needed. The native app performs owner actions, and Codex, Claude
Code, or Claude Desktop launches the Afternote CLI over standard MCP input/output.

The gateway exposes local launchd Mach services, not a TCP listener. It authenticates peers with
fixed Apple code-signing requirements. Its worker channel additionally requires the exact PID the
gateway launched. Connector requests are bound to the authenticated process, grant, scope,
session, signature, nonce, digest, and deadline.

Claude Desktop starts local MCP servers through Anthropic's signed `disclaimer` launcher.
Afternote admits that connector only when the launcher is its direct parent and the signed Claude
Desktop executable is the launcher's direct parent. Invoking the general-purpose launcher from an
unrelated process does not satisfy the chain.

No component requests root, administrator authorization, Full Disk Access, Accessibility, a
system or kernel extension, an inbound firewall rule, or an MDM profile. Owner-only actions use
the normal macOS LocalAuthentication prompt.

## Identities and entitlements

Official binaries use Apple Team Identifier `486B2A8N8A`. The public app identifier is
`dev.afternote.owner-control`; the broker, worker, CLI, and client signer use separate identifiers.
The worker alone receives the vault Keychain access group. The client signer receives a different
connector-key access group. The CLI does not receive either private-key group.

IT can verify the DMG, Developer ID signature, identifier, Team ID, Gatekeeper decision, and
stapled notarization ticket with the commands in [VERIFY_RELEASE.md](VERIFY_RELEASE.md). The signed
app also contains the SPDX SBOM, notices, licenses, build provenance, and a payload manifest over
its resources and embedded runtime. The outer app executable is covered by its Developer ID
signature; hashing it into the pre-sign manifest would include the signature region that signing
itself changes.

## Data and retention

The encrypted vault, connector records, optional model, and transactional recovery state live
under `~/.afternote`. Runtime files live under `~/Library/Application Support/Afternote`; the CLI
link is `~/.local/bin/afternote`; the LaunchAgent is in `~/Library/LaunchAgents`. Afternote modifies
only its own Codex and Claude Code MCP entries. Claude Desktop installation goes through Claude's
MCPB preview and explicit confirmation instead of a direct edit to Claude's private extension state.
The generated MCPB is not independently signed at the MCPB package layer. It contains only a
manifest and launcher for the signed Afternote CLI, but organizations that require centrally
signed or administrator-distributed MCPB packages should not approve this connector in this alpha.

The vault contains note text, revisions, metadata, local embeddings, grants, and a redacted audit
ledger. Its random key is stored in the macOS data-protection Keychain and is available only to the
signed worker while the device is unlocked. Connector signing keys are generated in the Secure
Enclave. Exact locations and recovery artifacts are listed in
[DATA_AND_NETWORK.md](DATA_AND_NETWORK.md).

JSON and Markdown exports are plaintext. Time Machine and other filesystem backups can retain old
encrypted vaults and exports. SQLCipher detects invalid ciphertext, but it cannot prove an
authentic encrypted snapshot is the newest state.

## Network and AI-provider boundary

Exact search, date-aware search, vault storage, and local inference have no Afternote cloud
dependency. The installed runtime has no telemetry, account service, or sync endpoint. Official
builds fetch a signed update feed from GitHub once per day by default; the user can disable it.
The request does not include Sparkle's optional system profile. Downloads occur only after user
approval and must pass EdDSA archive and feed verification plus Apple code-signing validation.

The optional `afternote semantic install` action downloads a fixed, size-limited, SHA-256-pinned
model file set from `https://huggingface.co`. After installation, inference is local.

Recall returns selected note excerpts to the local Codex, Claude Code, or Claude Desktop process. That host may
send the excerpts to OpenAI or Anthropic under the organization's configuration and contract.
Afternote cannot enforce either provider's retention policy, and it cannot cryptographically prove
which natural-language instruction caused an authorized host to call Remember.

## Deployment, updates, and rollback

There is no MDM package or fleet console in this alpha. Deployment is per user. IT can allowlist
the Team ID and identifiers, distribute the notarized DMG, and verify its published SHA-256 before
installation. The installer uses versioned directories, refuses overwrite, verifies signed
components, switches the active version transactionally, and restores the previous version after
a failed health check. Rollback selects an already installed signed version. The native app can
check for a newer signed release, but it never downloads or installs one without user approval.

Public releases are built through one guarded command from a clean reviewed commit. The process
uses a fresh detached checkout and frozen dependency install, rejects ambient compiler inputs,
records source/dependency/toolchain digests, signs nested components, notarizes, mounts and checks
the final DMG, and publishes only local output files for a separate human release step. See
[RELEASING.md](RELEASING.md).

## Monitoring and incident response

The broker writes no note content to standard output or standard error. Its encrypted audit ledger
records bounded, redacted authorization and lifecycle events. Share-safe diagnostics expose coarse
status, schema, integrity, count, and size buckets after owner authentication; they omit notes and
queries.

An incident responder can revoke connector grants, lock Afternote, remove the Codex and Claude Code
connections, and uninstall the runtime. Screen lock, sleep, user-session resignation, manual lock,
broker restart, and revocation end live sessions. Uninstall now fails rather than reporting success
if launchd still reports the broker active. Claude Desktop extensions must be removed through
Claude before uninstall so Afternote does not mutate another application's private extension state.

## Uninstall and secure erasure

Ordinary uninstall removes the runtime, LaunchAgent, CLI link, and Afternote-owned host
configuration. It intentionally preserves `~/.afternote`, the encrypted vault key, and Secure
Enclave connector identity so an intentional reinstall recovers the same notes and identity.

That is not secure erase. Deleting `~/.afternote` does not remove Keychain items, and normal file
deletion is not a forensic-erasure guarantee on SSDs or backups. This alpha has no supported
one-click destructive wipe that proves removal of the vault, grants, connector keys, exports, and
backup copies. Where offboarding requires application-level cryptographic erasure, do not approve
this release. The defensible current control is destruction of the managed macOS account and its
Keychain, plus the organization's normal device and backup sanitization process.

## Known limits and assurance level

The threat model does not protect a macOS login already controlled by malware, a compromised
authorized Codex, Claude Code, or Claude Desktop host, malicious accessibility software, hardware attacks, or
vulnerabilities in macOS and third-party runtimes. Same-login replacement of an older authentic
vault can rewind vault-resident state. Known post-alpha hardening work also includes tighter
resource quotas and eliminating remaining same-login verify/use races around the connector signer
and optional model.

The evidence today is automated correctness/security testing, real launchd and Keychain boundary
testing, signed-artifact lifecycle testing, dependency and secret scanning, Apple notarization,
and internal adversarial review. It is not an independent penetration test, SOC 2 report, FIPS
validation, certification, or assurance that regulated data is appropriate.

Security fixes support the current `main` branch and latest signed alpha. No vulnerability-fix or
end-of-life SLA is promised. Report issues privately through [SECURITY.md](../SECURITY.md).
