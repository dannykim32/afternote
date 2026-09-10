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
- The private worker opens a post-exec XPC channel back to the gateway. Both sides enforce
  code-signing requirements, and the gateway also binds the connection to the exact worker
  PID it launched; inherited standard streams are not an authorization channel.
- The worker authorizes every operation against the authenticated client, live grant,
  scope, session, signature, nonce, request digest, and deadline.
- Owner-only operations require the signed native app and fresh operating-system owner
  presence.
- The finalizer verifies signed code and a manifest covering both the portable payload and
  the embedded runtime. The installer verifies the signed application before running its
  lifecycle code, and the lifecycle flow verifies installed executable signatures.
- Official updates require three independent checks: HTTPS transport, a signed appcast and
  archive under Afternote's EdDSA key, and the existing Apple Developer ID requirement. The
  updater does not accept an unsigned fallback. Release tooling verifies those signatures
  before it publishes the feed candidate.

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
- A process with the logged-in user's filesystem authority can replace the vault with an
  older, previously valid encrypted snapshot. SQLCipher rejects forged ciphertext; it does
  not prove that authentic ciphertext is the newest vault state. Afternote therefore makes
  no rollback-freshness guarantee against account compromise. A replay can rewind notes,
  audit history, lock state, grants, and connector-reconnect state. It cannot revive a live
  session from an earlier broker boot, and using a restored grant still requires the matching
  connector signing identity and a new owner-authorized work session.
- A compromised Codex or Claude Code process can misuse the Remember/Recall scopes granted
  to that connector during a live session.
- The MCP contract tells connectors to call Remember only for an explicit user request, but
  the broker cannot independently prove which natural-language instruction caused a signed
  host process to make a valid tool call.
- Device compromise while the vault is unlocked, malicious accessibility software,
  hardware attacks, and vulnerabilities in macOS or third-party runtimes are outside this
  application boundary.
- Source availability does not prove that a downloaded binary was built from a particular
  commit. Public releases are built from a fresh detached checkout with a frozen dependency
  install, a restricted build environment, pre/post input digests, and signed provenance.
  Those controls provide evidence; they are not a third-party reproducible-build attestation.
- The public release process requires a dedicated release account or host with no untrusted
  same-login processes. A compromised account that can change the release tooling while also
  using its signing and notarization credentials can sign malicious bytes; in-repository checks
  cannot make that account safe.
- Loss of the EdDSA private key would stop the fail-closed update feed. Recovery requires a
  deliberate Developer ID-backed key rotation; the application will not silently accept an
  unsigned feed.

## Security status

This is alpha software. It has automated security tests and internal adversarial review,
but it is not represented as independently audited, appropriate for regulated data, or
free of vulnerabilities. Use [SECURITY.md](../SECURITY.md) for private reporting.
