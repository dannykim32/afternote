# macOS packaging

The portable development bundle contains the CLI, native gateway, private worker app,
client signer app, owner-control app, native libraries, lifecycle scripts, licenses, SPDX
SBOM, and third-party notices. It contains no signing credentials or provisioning profiles.

`install.sh` publishes a versioned directory under the user's Application Support directory
and refuses to overwrite an existing version. It publishes the active command at
`~/.local/bin/afternote`, switches the `current` link, installs a user LaunchAgent, and verifies
broker health. Reopening the app repairs that command link when the active private runtime is
still valid. A failed switch restores the prior links and LaunchAgent. `rollback.sh` selects an
already installed version. `uninstall.sh` removes Afternote-owned runtime files after stopping
the broker; user vaults and explicit exports are handled separately and are never silently
deleted.

Afternote does not edit shell profiles. When `~/.local/bin` is not already on `PATH`, use the full
command path or add `export PATH="$HOME/.local/bin:$PATH"` to the shell configuration.

All lifecycle scripts use a per-user lock outside the install tree. They reject unsafe,
symlinked, or unowned paths. A stale lock is reclaimed only when its recorded process no
longer exists.

## Development package

```bash
bun run package:local
```

This verifies the expected local toolchain, compiles the native boundary, generates supply
chain material, and builds an unsigned archive for testing. It is not suitable for public
distribution. A development archive deliberately refuses to replace an existing Developer ID
installation because the two builds cannot share the release Keychain trust domain. Test it in
a separate macOS account, or use the signed and notarized DMG when validating an upgrade.

Exact search remains the release default. A user can explicitly run
`afternote semantic install` to fetch the pinned, digest-verified local model after reviewing
the additional disk and runtime requirements.

## Public release

Run `bun run release:public` from a clean reviewed commit on the dedicated release account or
host. The release command builds in a detached temporary worktree, performs a fresh frozen
dependency install, rejects ambient compiler configuration, and rechecks source and dependency
digests. The finalizer verifies the signed payload manifest against both the portable files and
the runtime embedded in the app, submits artifacts to Apple, staples tickets, re-verifies a
private extracted archive, signs and verifies the Sparkle feed and DMG with the dedicated EdDSA
key, and writes checksums for the notarized DMG and appcast. Portable archives are development
and verification inputs, not public release artifacts.

Credential files must remain outside the repository. Never place their contents, signing
identities, secrets, or notarization credentials in documentation, logs, fixtures, or
artifacts.

The full release checklist is in [RELEASING.md](../../../docs/RELEASING.md).
