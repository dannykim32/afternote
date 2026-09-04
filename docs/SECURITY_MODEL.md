# Security model

## Protected assets

Afternote protects note content, note metadata, the SQLCipher key, connector grants, and
the integrity of installed release components. The primary boundary is the signed native
gateway and its private worker. MCP clients do not receive the vault key or a database
handle.

## Trust boundaries

- macOS Keychain protects the random vault key according to its access-control list.
- SQLCipher receives that 256-bit random secret through its passphrase API. Afternote pins
  the SQLCipher 4 page size, KDF iteration count, HMAC/KDF algorithms, and zero-byte
  plaintext header so a future library default cannot silently redefine existing vaults.
- The gateway authenticates connecting code using Apple code-signing requirements and
  assigns a fixed role. Request data cannot choose its own role.
- The worker authorizes every operation against the authenticated client, live grant,
  scope, session, signature, nonce, request digest, and deadline.
- Owner-only operations require the signed native app and fresh operating-system owner
  presence.
- The installer and finalizer verify signed code and a manifest covering non-app payloads.

## Session lifecycle

Connector authorization has idle and absolute deadlines. Manual lock, screen lock, system
sleep, user-session resignation, broker restart, identity rotation, and revocation end live
authority. Durable pairing never substitutes for a current session.

## Retrieval and untrusted content

FTS5, temporal parsing, embeddings, and ranking operate locally. Recall has bounded query,
candidate, annotation, and execution limits. Notes and source metadata can still contain
hostile instructions. MCP descriptions and results identify recalled content as untrusted;
clients must not interpret it as system or developer instructions.

## Exports and restore

JSON exports and Markdown exports are plaintext. The JSON checksum is for corruption
detection, not origin authentication. Restore is a deliberate owner action into a clean
vault. It uses bounded stable-file reads, strict schema validation, duplicate-key rejection,
transactional import, SQLCipher integrity checks, and an authenticated recovery marker.
Do not restore a file whose provenance you do not trust.

## Threats outside the guarantee

- Malware already running as the logged-in user can observe the screen, change tool
  configuration, or invoke actions the user can invoke. Code signing prevents that process
  from impersonating an authorized Afternote peer; it cannot make a compromised account
  safe.
- A compromised Codex or Claude Code process can misuse the Remember/Recall scopes granted
  to that connector during a live session.
- The MCP contract tells connectors to call Remember only for an explicit user request, but
  the broker cannot independently prove which natural-language instruction caused a signed
  host process to make a valid tool call.
- Device compromise while the vault is unlocked, malicious accessibility software,
  hardware attacks, and vulnerabilities in macOS or third-party runtimes are outside this
  application boundary.
- Source availability does not prove that a downloaded binary was built from a particular
  commit. Release provenance, signatures, notarization, checksums, SBOMs, and reproducible
  input pins provide separate evidence.

## Security status

This is alpha software. It has automated security tests and internal adversarial review,
but it is not represented as independently audited, appropriate for regulated data, or
free of vulnerabilities. Use [SECURITY.md](../SECURITY.md) for private reporting.
