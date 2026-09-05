# Data and network inventory

This inventory describes the first public candidate: one Apple Silicon Mac, one local
vault, and Codex and Claude Code connectors only.

## Local files

| Location | Contents | Uninstall behavior |
| --- | --- | --- |
| `~/.afternote/vault.db` | SQLCipher-encrypted notes, revisions, metadata, embeddings, grants, and audit records | Preserved so reinstall does not destroy notes |
| `~/.afternote/clients/` | Connector installation identifiers; no note text or private signing-key bytes | Preserved for reconnect after reinstall |
| `~/.afternote/models/` | Pinned local embedding model files downloaded only after explicit semantic installation | Preserved; may be deleted and downloaded again |
| `~/.afternote/.vault.db.afternote-telemetry.json` | Owner-only telemetry consent and a rotating installation identifier; no notes or queries | Preserved with the vault; deleted when telemetry is disabled |
| `~/.afternote/.vault.db.afternote.lock` | Transient lifecycle lock containing process coordination state, not note text | Removed when the broker exits normally; stale locks are recovered safely |
| `~/.afternote/vault.db.*migration*` and `vault.db.*restore*` | Owner-only transactional markers, encrypted candidates, rollback vaults, and integrity seals used only while migration or restore is incomplete | Cleaned after successful completion; retained after interruption so recovery can resume without guessing |
| `~/Library/Application Support/Afternote/` | Versioned runtime, native helpers, license inventory, and active-version link | Removed |
| `~/Library/LaunchAgents/dev.afternote.vault-broker.plist` | User-level broker launch configuration | Removed |
| `~/.local/bin/afternote` | Link to the active command | Removed when Afternote owns it |
| `~/.codex/config.toml` | One `mcp_servers.afternote` entry | Only the Afternote entry is removed |
| `~/.claude.json` | One Afternote MCP entry | Only the Afternote entry is removed |

Explicit JSON and Markdown exports are plaintext at the path the user selects. Diagnostics
contain coarse allowlisted status fields, not notes or queries. Migration can retain a
plaintext source only when the owner explicitly chooses Keep or Move; deletion is normal
filesystem unlinking, not a claim of forensic erasure on SSD storage or backups.

The data-protection Keychain stores the per-vault key under the worker's exact access group.
Secure Enclave-backed connector signing keys use tags beginning
`dev.afternote.mcp-client.codex` or `dev.afternote.mcp-client.claude`. They contain no note
content and remain across an ordinary uninstall so reinstall can recover the same local
identity. Deleting `~/.afternote` alone does not delete Keychain items.

Copies made by Time Machine or other filesystem backup tools are whole-vault snapshots, not
an append-only history. Replacing `vault.db` with an older valid encrypted copy can rewind
notes and vault-resident security state. Afternote does not detect that rollback when the
logged-in account performing it is already compromised; see the security model for the
remaining session and signing requirements.

The Uninstall action is therefore a runtime removal, not an identity or data wipe. It
removes the Codex and Claude Code configuration entries so those tools cannot invoke
Afternote, but preserves encrypted broker grants and their matching device-bound signing
keys for an intentional reinstall. A future destructive erase flow must separately revoke
those grants and delete both the vault and Keychain items.

## Permissions

Afternote installs in the current user's account. It does not request administrator access,
Full Disk Access, Accessibility, a kernel extension, or an MDM profile. Owner-only actions
use the native macOS authentication prompt. The worker's private Keychain item is available
only while the device is unlocked.

## Network behavior

The installed Afternote runtime has no telemetry transport and no Afternote account or sync
endpoint. Exact and date-aware search make no outbound request.

The only direct application download is an explicit `afternote semantic install`, which
fetches a fixed file set from `https://huggingface.co` at the pinned model revision. Every
file has a byte limit and SHA-256 digest and is verified before publication. The model and
inference remain local after installation.

Codex and Claude Code are separate products with their own network and retention behavior.
When one of those connectors calls Recall, Afternote returns the requested excerpts to that
local host process. What the host sends to its model provider is governed by that provider,
not by Afternote. Build and CI tooling separately queries `https://api.osv.dev` for dependency
advisories; that code is not part of the installed application path.
