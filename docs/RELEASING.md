# Release checklist

Public release is one guarded operation. Run `bun run release:public` from the reviewed,
clean commit on a dedicated release account or host with no untrusted same-login processes.
The command creates a detached temporary worktree, performs a fresh frozen install, runs every
gate below, finalizes the DMG, and copies only the DMG, checksum, and final report to
`build/public-release`.

1. Start from a clean standalone Git checkout and a reviewed commit. Do not build a public
   release from a normal interactive login that is running unrelated software.
2. Use Bun 1.3.14. The release command installs dependencies in its detached worktree with
   `--frozen-lockfile --ignore-scripts --no-cache`, then records and rechecks their tree digest.
3. Run type checking, the complete test suite, dependency audit, and package integration
   suite.
4. Run exact, temporal, semantic, and 10,000-note quality gates on the candidate artifact.
5. Run `bun run prepare:native-release` to compile the checksum-pinned SQLCipher and
   OpenSSL sources for macOS 13.3. Build only after their reproducible output digests,
   Bun, Node headers, and ONNX Runtime match `scripts/native-release-inputs.json`.
6. Confirm the SPDX SBOM, license inventory, and third-party notices cover every compiled
   component.
7. Sign with the existing Developer ID identity and the separate worker and client-signer
   provisioning profiles. Credentials remain outside the checkout.
8. Verify every nested signature and the signed payload manifest. The manifest covers the
   top-level portable payload plus the app resources and embedded runtime. The outer app's main
   Mach-O is covered by its Developer ID signature because signing changes its signature region.
9. Notarize, staple, verify Gatekeeper assessment, and re-verify a private extracted
   archive. Publish only the final DMG, never the portable build directory or archives.
10. Test fresh install, upgrade, rollback, uninstall, and reinstall on a clean macOS user.
11. Run real Codex and Claude Code Remember/Recall acceptance loops against that installed
    artifact.
12. Publish only the reviewed DMG and its checksum from `build/public-release`. The SBOM,
   notices, and provenance record are embedded in that signed application; do not distribute
   the unsigned portable bundle.

A failed gate stops the release. Do not repair or replace release credentials from build
automation, and do not treat a development package as a distributable artifact.

The script deliberately stops after producing local release files. Publishing remains a
separate human action.
