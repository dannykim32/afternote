# Afternote Local

Afternote is built for the things you explicitly ask it to remember.

Save a decision, deadline, or piece of context from Codex or Claude Code. Recall it later
from either tool with the source attached. The same notes are available in the native Mac
app.

This repository contains the local Mac product. It does not contain Afternote's former
hosted service, customer data, deployment configuration, or production credentials.

## Status

This is a source candidate for an early Apple Silicon macOS alpha. It has not been
published yet. Codex and Claude Code are the only connector surfaces included in this
candidate.

The current product keeps one encrypted vault on one Mac. There is no Afternote account
and no hosted copy of that vault. Cross-device sync and additional connectors are future
work, not promises made by this release.

## Security model

- The vault is encrypted with SQLCipher.
- A per-vault key is stored in macOS Keychain and retrieved only by the signed private
  worker.
- Connectors never open the database or receive its key. They use scoped, revocable
  Remember and Recall grants through a signed native gateway.
- Codex and Claude Code executables are verified against their expected macOS signing
  identities before Afternote changes their MCP configuration.
- Screen lock, sleep, logout, manual lock, and broker restart end live authorization
  sessions.
- Release artifacts are Developer ID signed, notarized, stapled, checksummed, and bound to
  a signed payload manifest. The release also includes an SPDX SBOM and third-party
  notices.

These controls reduce risk; they do not make arbitrary content trustworthy. Recalled note
text and source metadata are untrusted data to an AI client. Exports contain plaintext.
SQLCipher detects invalid ciphertext, but Afternote does not promise rollback detection when
malware already controlling the logged-in account replaces the vault with an older valid
encrypted snapshot.
An approved connector is trusted to call Remember only after an explicit user request;
Afternote cannot independently prove what natural-language instruction caused a host tool
call.
Read [the security model](docs/SECURITY_MODEL.md) for assumptions and limits.
The [data and network inventory](docs/DATA_AND_NETWORK.md) lists every local path,
retained uninstall item, and outbound destination.
Security and IT reviewers can start with the
[enterprise security review](docs/ENTERPRISE_SECURITY.md), which includes the current deployment
and secure-erasure limits.

## Retrieval

Exact retrieval uses SQLite FTS5 and date-aware ranking locally. The optional semantic
index uses a locally downloaded, digest-verified model and local ONNX inference. Afternote
does not send notes to an Afternote service for embedding or search.

The repository includes deterministic exact, temporal, semantic, and 10,000-note scale
evaluations. Passing a benchmark is evidence about that corpus, not a promise that every
query will return the expected note.

## Build and test

Requirements:

- Apple Silicon Mac running macOS 13.3 or newer for signed releases. Development packages
  use the local Homebrew libraries and therefore inherit their deployment target.
- Bun 1.3.14
- Xcode Command Line Tools
- SQLCipher 4.18.0 and OpenSSL 4.0.2 from Homebrew for development builds. Release builds
  compile both from checksum-pinned source with a macOS 13.3 deployment target.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run package:local
```

Maintainers run `bun run prepare:native-release` before a signed release build. It
downloads only the pinned source archives, verifies their SHA-256 digests, and produces
ignored release inputs whose output digests are checked by the release builder.

`package:local` creates a development artifact. It is not a public release and does not
have the maintainer's Developer ID or Keychain entitlements.

Release credentials, provisioning profiles, and notarization material stay outside the
repository. See [RELEASING.md](docs/RELEASING.md) for the gates without any credential
values. Downloaded binaries can be checked with [VERIFY_RELEASE.md](docs/VERIFY_RELEASE.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing storage, authorization, lifecycle,
or connector code. Report vulnerabilities through the private process in
[SECURITY.md](SECURITY.md).

## License

The source is licensed under Apache License 2.0. That license does not grant rights to use
the Afternote name or branding for a modified distribution; see
[TRADEMARKS.md](TRADEMARKS.md).
