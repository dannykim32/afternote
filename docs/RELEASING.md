# Release checklist

Public release is a separate operation from building or testing this repository.

1. Start from a clean standalone Git checkout and a reviewed commit.
2. Install dependencies with Bun 1.3.14 and `--frozen-lockfile`.
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
8. Verify every nested signature and the signed payload manifest.
9. Notarize, staple, verify Gatekeeper assessment, and re-verify a private extracted
   archive. Publish only the final DMG, never the portable build directory or archives.
10. Test fresh install, upgrade, rollback, uninstall, and reinstall on a clean macOS user.
11. Run real Codex and Claude Code Remember/Recall acceptance loops against that installed
    artifact.
12. Publish only the reviewed DMG and its checksum. The SBOM, notices, and provenance record
    are embedded in that signed application; do not distribute the unsigned portable bundle.

A failed gate stops the release. Do not repair or replace release credentials from build
automation, and do not treat a development package as a distributable artifact.
