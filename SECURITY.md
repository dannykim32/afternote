# Security policy

## Report a vulnerability privately

Email `hello@afternote.dev` with `Security` in the subject. Include the affected component,
reproduction steps, impact, and proof-of-concept material that is safe to share.

Please do not open a public issue, access another person's data, run denial-of-service tests,
or retain data encountered while verifying a report. We aim to acknowledge reports within
five business days. Coordinated disclosure is welcome after a fix is available.

## Supported versions

Security fixes apply to the current `main` branch and the latest signed alpha release. Older
alpha builds and modified third-party distributions are not supported.

## High-value areas

- Reading or modifying the encrypted vault without owner-authorized broker access
- Obtaining the vault key outside the signed worker's Keychain boundary
- Forging, escalating, or retaining connector authority
- Bypassing owner-presence, revocation, lock, uninstall, or recovery controls
- Plaintext notes, keys, or credentials escaping through files, logs, diagnostics, or exports
- Replacing signed helpers or crossing the expected code-signing identity boundary

The [security model](docs/SECURITY_MODEL.md) documents known assumptions and
limits. Afternote is not represented as independently audited or suitable for regulated data.
