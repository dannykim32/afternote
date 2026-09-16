# Release checklist

Public release is one guarded operation. Run `bun run release:public` from the reviewed,
clean commit on a dedicated release account or host with no untrusted same-login processes.
The command creates a detached temporary worktree, performs a fresh frozen install, runs every
gate below, finalizes the DMG, signs its Sparkle appcast, and copies only the DMG, appcast,
checksum, and final report to
`build/public-release`.

1. Move the reviewed changes from `Unreleased` into a dated version section, increment the
   numeric `afternote.bundleVersion` in the root `package.json`, and confirm every workspace
   package version matches. Start from that clean standalone Git commit. Do not build a public
   release from a normal interactive login that is running unrelated software.
2. Use Bun 1.3.14. The release command installs dependencies in its detached worktree with
   `--frozen-lockfile --ignore-scripts --no-cache`, then records and rechecks their tree digest.
3. Run `bun run prepare:native-release` to compile the checksum-pinned SQLCipher and
   OpenSSL sources and stage the checksum-pinned Sparkle framework for macOS 13.3. Build
   only after their reproducible output digests,
   Apple toolchain, Bun, Node headers, and ONNX Runtime match
   `scripts/native-release-inputs.json`. Development and CI builds record their actual Apple
   toolchain and validate the pinned sources and deployment target, but only the public release
   host must reproduce the reviewed native output digests exactly.
4. Run type checking, the complete test suite, dependency audit, and package integration
   suite.
5. Run exact, temporal, semantic, and 10,000-note quality gates on the candidate artifact. The
   10,000-note performance gate runs in a fresh process, takes three samples, and requires the
   median p95 to remain under the release limit.
6. Confirm the SPDX SBOM, license inventory, and third-party notices cover every compiled
   component, including Sparkle.
7. Sign with the existing Developer ID identity and the separate worker and client-signer
   provisioning profiles. The vault and client-signing Keychain groups are derived from the
   Team ID and signed role; release-operator overrides are rejected. Credentials remain outside
   the checkout.
8. Verify every nested signature, the worker's exact `dev.afternote.vault-key` Keychain group,
   the client signer's exact `dev.afternote.client-key` group, and the signed payload manifest.
   The manifest covers the
   top-level portable payload plus the app resources and embedded runtime. The outer app's main
   Mach-O is covered by its Developer ID signature because signing changes its signature region.
9. Notarize, staple, verify Gatekeeper assessment, and re-verify a private extracted
   archive. Sign the final DMG and appcast with the dedicated `afternote-updates` EdDSA key.
   The release stops if the feed does not name the exact versioned HTTPS asset.
10. Test fresh install, upgrade, rollback, uninstall, and reinstall on a clean macOS user.
11. Run real Codex, Claude Code, and Claude Desktop Remember/Recall acceptance loops against that
    installed artifact. For Claude Desktop, approve the MCPB in Claude, return to Afternote and
    verify **Check again** reports healthy, then test lock, unlock, disable, re-enable, and removal.
12. Create the exact GitHub Release tag `v<version>` (for example,
   `v2.0.0-alpha.12`) and upload the reviewed DMG and `SHA256SUMS`. Before publishing the
   feed, confirm the exact enclosure URL succeeds:

   ```bash
   curl --fail --silent --show-error --location --head \
     "https://github.com/dannykim32/afternote/releases/download/v<version>/afternote-local-<version>-darwin-arm64.dmg"
   ```

   Then publish the generated `appcast-alpha.xml` at the repository root. The appcast must not
   go live before its DMG URL does. The SBOM, notices, and provenance record are embedded in
   the signed application; do not distribute the unsigned portable bundle.

A failed gate stops the release. Do not repair or replace release credentials from build
automation, and do not treat a development package as a distributable artifact.

The script deliberately stops after producing local release files. Publishing the GitHub
Release and committing the generated appcast remain separate human actions.

## Semantic-search beta acceptance

The current learned-model candidate is accepted for beta subject to the bounded ordinary-use
and security checks in [BETA_READINESS.md](BETA_READINESS.md). Its separate experimental recall
and latency reports retain their original failures; they are not the deterministic fixture
checks run by `test:quality`. This decision does not change or bypass any command in the guarded
release pipeline above. Signed artifact and clean-user acceptance are still required.

## Signed-update bootstrap

Alpha 11 and earlier do not contain the signed updater, so they cannot discover or install
Alpha 12. Alpha 12 is the one-time manual bootstrap release: existing testers must download
and install its notarized DMG directly. The first end-to-end in-app update acceptance test is
Alpha 12 to Alpha 13. On a clean test account:

1. Install and open Alpha 12 manually. Disable automatic checks, relaunch, and confirm the
   preference remains disabled; enable it again and repeat the persistence check.
2. Create a note with at least two revisions, connect one supported tool, and quit Afternote.
3. Publish the notarized Alpha 13 DMG as the GitHub Release asset named by the generated
   appcast enclosure, then publish the signed appcast.
4. Open Alpha 12 and choose **Check for Updates…**. Confirm it presents Alpha 13 but neither
   downloads nor installs it without explicit approval.
5. Approve the update, relaunch, and confirm the app, CLI, and runtime all report Alpha 13.
6. Confirm the note, both revisions, connector state, export, and Remember/Recall still work.

Do not claim the updater is production-verified until that transition has passed.

## Beta 1 included search assets

The guarded build runs `prepare:semantic-release` in its fresh checkout. It fetches only
source-pinned model files, verifies byte counts and SHA-256 digests, and stages them under
`build/semantic-model`. Packaging re-verifies the allowlist and copies it into both the
portable runtime and the app's sealed runtime, with model terms and notices. The signed
payload manifest covers these files, and the SBOM identifies both models and their licenses.

`test:semantic-release` then compiles the production text-only inference runtime and exercises
immediate paraphrase retrieval through a temporary encrypted broker using those exact staged
models. Its synthetic owner-presence protocol is a test fixture, not production Touch ID
acceptance. Ordinary unit/package tests do not download models.

For independent artifact verification, mount the final DMG read-only and run its embedded
`afternote semantic catalog` and `afternote semantic check` with `AFTERNOTE_VAULT_PATH` pointing
to an empty temporary directory. The catalog must say enabled/bundled/ready without creating
a model cache; the check loads both local runtimes without opening a vault. Verify off/on
preference persistence too. Run with network denied to demonstrate offline operation.
