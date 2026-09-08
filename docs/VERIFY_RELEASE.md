# Verify a release

Afternote distributes one binary artifact: a notarized DMG. Portable build directories and
archives are not release artifacts.

After downloading the DMG and its `SHA256SUMS` from the same tagged release, run:

```bash
shasum -a 256 -c SHA256SUMS
hdiutil verify afternote-local-<version>-darwin-arm64.dmg
```

Mount the DMG, then verify the application:

```bash
codesign --verify --deep --strict --verbose=4 /Volumes/Afternote/Afternote.app
codesign -dv --verbose=4 /Volumes/Afternote/Afternote.app 2>&1
spctl --assess --type execute --verbose=4 /Volumes/Afternote/Afternote.app
xcrun stapler validate /Volumes/Afternote/Afternote.app
```

The signature details must show Team Identifier `486B2A8N8A` and identifier
`dev.afternote.owner-control`. Gatekeeper and stapler validation must succeed. The signed app
contains the runtime, SPDX SBOM, third-party notices, license texts, and a manifest binding
both the reviewed portable payload and the runtime embedded in the application.

After dragging Afternote into Applications, eject the installer and open the installed app once.
That first launch installs the private runtime and publishes its command at
`~/.local/bin/afternote`. Verify it directly:

```bash
test -x "$HOME/.local/bin/afternote"
"$HOME/.local/bin/afternote" help
```

If `command -v afternote` does not find it, add the command directory to the current shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add the same line to the shell's startup file only if you want the bare `afternote` command in
future terminal sessions. Afternote does not edit shell profiles automatically.

These checks authenticate the maintainer and Apple's notarization decision. They do not by
themselves prove that a binary was built from a particular source commit. The embedded
release record states the maintainer build commit, Git tree, dependency tree, restricted build
environment, toolchain, and native input digests. This is maintainer-signed provenance, not a
third-party reproducible-build attestation.
