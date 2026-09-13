# Verify a release

Afternote distributes one binary artifact: a notarized DMG. Portable build directories and
archives are not release artifacts.

For a first installation, download the DMG and checksum file from one tagged release.
Existing official installations with the updater can use **Settings > Updates > Check now**.
Very early alphas without an updater require a manual installation of the current release.

In the directory containing the DMG and its `SHA256SUMS`, run:

```bash
shasum -a 256 -c SHA256SUMS
hdiutil verify afternote-local-2.0.0-alpha.22-darwin-arm64.dmg
```

The filename above is an example for alpha.22: use the filename from the release you
downloaded. If the checksum names an older DMG, replace `SHA256SUMS` with the file from
the matching release. Do not rename a checksum entry to make verification pass.

Mount the DMG by opening it in Finder, then verify the application:

```bash
codesign --verify --deep --strict --verbose=4 /Volumes/Afternote/Afternote.app
codesign -dv --verbose=4 /Volumes/Afternote/Afternote.app 2>&1
spctl --assess --type execute --verbose=4 /Volumes/Afternote/Afternote.app
xcrun stapler validate /Volumes/Afternote/Afternote.app
```

Confirm the release identity recorded in the bundle:

```bash
/usr/libexec/PlistBuddy -c "Print :AfternotePackageVersion" \
  /Volumes/Afternote/Afternote.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  /Volumes/Afternote/Afternote.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" \
  /Volumes/Afternote/Afternote.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" \
  /Volumes/Afternote/Afternote.app/Contents/Info.plist
```

For alpha.22 these values are, in order, `2.0.0-alpha.22`, `2.0.0`, `22`, and `13.3`.
For a later alpha, the package and build versions must match that release.
The first value is Afternote's full package version. The next two are Apple's required numeric
marketing and build versions.

Official release bundles also contain the signed-update policy. Confirm its public key and
fail-closed settings:

```bash
/usr/libexec/PlistBuddy -c "Print :SUFeedURL" /Volumes/Afternote/Afternote.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :SUPublicEDKey" /Volumes/Afternote/Afternote.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :SURequireSignedFeed" /Volumes/Afternote/Afternote.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :SUVerifyUpdateBeforeExtraction" /Volumes/Afternote/Afternote.app/Contents/Info.plist
```

The feed URL must be the repository's HTTPS `appcast-alpha.xml`, the public key must be
`XvnOOnpqXBIE7Nq00NKD8cnMe3ZZHqLFbfykOD8tLOs=`, and both Boolean checks must print `true`.

The signature details must show Team Identifier `486B2A8N8A` and identifier
`dev.afternote.owner-control`. Gatekeeper and stapler validation must succeed. The signed app
contains the runtime, SPDX SBOM, third-party notices, license texts, and a manifest binding
both the reviewed portable payload and the runtime embedded in the application.

Complete the mounted-app checks above before ejecting the installer. To check an already
installed copy instead, replace `/Volumes/Afternote/Afternote.app` with
`/Applications/Afternote.app` in those commands.

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

Confirm that first launch activated the matching runtime:

```bash
/usr/libexec/PlistBuddy -c "Print :AfternotePackageVersion" /Applications/Afternote.app/Contents/Info.plist
"$HOME/.local/bin/afternote" version
readlink "$HOME/Library/Application Support/Afternote/current"
"$HOME/.local/bin/afternote" doctor
```

The first two versions must match; the runtime link should name that version under
`versions/`. Doctor should report a running runtime and valid vault integrity.
Then follow the [connector setup and first-note check](../README.md#remember-and-recall).

These checks authenticate the maintainer and Apple's notarization decision. They do not by
themselves prove that a binary was built from a particular source commit. The embedded
release record states the maintainer build commit, Git tree, dependency tree, restricted build
environment, toolchain, and native input digests. This is maintainer-signed provenance, not a
third-party reproducible-build attestation.

Confirm the two installation-bound Keychain roles did not cross during signing:

```bash
codesign -d --entitlements :- \
  /Applications/Afternote.app/Contents/Resources/AfternoteRuntime/AfternoteVaultWorker.app \
  2>/dev/null
codesign -d --entitlements :- \
  /Applications/Afternote.app/Contents/Resources/AfternoteRuntime/AfternoteClientSigner.app \
  2>/dev/null
```

The worker must contain only `486B2A8N8A.dev.afternote.vault-key`; the client signer must
contain only `486B2A8N8A.dev.afternote.client-key`.
