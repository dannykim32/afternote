# macOS packaging

The portable development bundle contains the CLI, native gateway, private worker app,
client signer app, owner-control app, native libraries, lifecycle scripts, licenses, SPDX
SBOM, and third-party notices. It contains no signing credentials or provisioning profiles.

`install.sh` publishes a versioned directory under the user's Application Support directory
and refuses to overwrite an existing version. It switches the `current` link, installs a
user LaunchAgent, and verifies broker health. A failed switch restores the prior links and
LaunchAgent. `rollback.sh` selects an already installed version. `uninstall.sh` removes
Afternote-owned runtime files after stopping the broker; user vaults and explicit exports are
handled separately and are never silently deleted.

All lifecycle scripts use a per-user lock outside the install tree. They reject unsafe,
symlinked, or unowned paths. A stale lock is reclaimed only when its recorded process no
longer exists.

## Development package

```bash
bun run package:local
```

This verifies the expected local toolchain, compiles the native boundary, generates supply
chain material, and builds an unsigned archive for testing. It is not suitable for public
distribution.

Exact search remains the release default. A user can explicitly run
`afternote semantic install` to fetch the pinned, digest-verified local model after reviewing
the additional disk and runtime requirements.

## Public release

Run `bun run release:public` from a clean reviewed commit on the dedicated release account or
host. The release command builds in a detached temporary worktree, performs a fresh frozen
dependency install, rejects ambient compiler configuration, and rechecks source and dependency
digests. The finalizer verifies the signed payload manifest against both the portable files and
the runtime embedded in the app, submits artifacts to Apple, staples tickets, re-verifies a
private extracted archive, and writes a checksum for the only distributable binary artifact:
the notarized DMG. Portable archives are development and verification inputs, not public release
artifacts.

Credential files must remain outside the repository. Never place their contents, signing
identities, secrets, or notarization credentials in documentation, logs, fixtures, or
artifacts.

The full release checklist is in [RELEASING.md](../../../docs/RELEASING.md).
