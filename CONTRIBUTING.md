# Contributing to Afternote

Afternote's useful surface is small, but its trust boundary is not. Focused changes are
easier to review than broad rewrites, especially around the vault, Keychain, connector
identity, installation, and recovery.

## Development flow

1. Open an issue or short proposal before changing the storage or authorization model.
2. Create a branch from `main`.
3. Add a failing test for the behavior being changed.
4. Implement the smallest coherent fix.
5. Run `bun run prepare:native-release` once to build the checksum-pinned SQLCipher and
   OpenSSL dependencies for macOS 13.3.
6. Run `bun run typecheck` and `bun run test`.
7. Explain the privacy and security impact in the pull request.

The GitHub workflow runs the same macOS test suite, including compiled native smoke tests.
Launchd, Keychain, notarization, and clean-user acceptance still belong to the release-host
checklist; a green hosted workflow does not replace those gates.

Use the terms in [CONTEXT.md](CONTEXT.md) when naming public interfaces and modules. Keep
canonical note mutations and their synchronous derived projections in one database transaction.
Keep platform and connector behavior behind adapters rather than branching inside domain code.

Do not commit credentials, provisioning profiles, private notes, vault files, exported
archives, signing material, `.env` files, or screenshots containing user data.

## Pull requests

Include the problem, behavior before and after, verification evidence, and any compatibility
impact. Native UI changes should include a screenshot with synthetic data. Storage migrations
must preserve existing vaults or provide an explicit tested recovery path.

Security vulnerabilities follow [SECURITY.md](SECURITY.md), not the public issue tracker.
