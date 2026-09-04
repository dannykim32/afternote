import { describe, expect, it } from "bun:test";
import {
  assertPublicArtifactReport,
  releaseFinalizationPaths,
} from "../../../scripts/finalize-local-release";

const outputDirectory = "/tmp/afternote-release";
const version = "2.0.0-alpha.3";
const paths = releaseFinalizationPaths(outputDirectory, version);
const publicReport = {
  version,
  platform: "darwin-arm64",
  releaseFlavor: "public",
  semanticRuntimeIncluded: true,
  signing: "Developer ID hardened-runtime signature; notarization remains a separate release gate",
  portableDirectory: paths.portableDirectory,
  binaryPath: `${paths.portableDirectory}/afternote`,
  brokerBinaryPath: `${paths.portableDirectory}/afternote-vault-broker`,
  brokerWorkerAppPath: `${paths.portableDirectory}/AfternoteVaultWorker.app`,
  brokerWorkerPath: `${paths.portableDirectory}/AfternoteVaultWorker.app/Contents/MacOS/afternote-vault-worker`,
  clientSignerAppPath: `${paths.portableDirectory}/AfternoteClientSigner.app`,
  clientSignerPath: `${paths.portableDirectory}/AfternoteClientSigner.app/Contents/MacOS/afternote-client-signer`,
  sqlcipherAddonPath: `${paths.portableDirectory}/afternote_sqlcipher.node`,
  sqlcipherLibraryPath: `${paths.portableDirectory}/libsqlcipher.3.dylib`,
  cryptoLibraryPath: `${paths.portableDirectory}/libcrypto.4.dylib`,
  onnxRuntimePath: `${paths.portableDirectory}/libonnxruntime.1.21.0.dylib`,
  ownerControlAppPath: `${paths.portableDirectory}/Afternote.app`,
  embeddedRuntimePath: `${paths.portableDirectory}/Afternote.app/Contents/Resources/AfternoteRuntime`,
  sourceCommit: "0123456789abcdef0123456789abcdef01234567",
  sourceTreeClean: true,
  dependencyLockSha256: "a".repeat(64),
  payloadManifestSha256: "b".repeat(64),
  buildProvenanceSha256: "c".repeat(64),
};

describe("release finalization gates", () => {
  it("exposes only the post-notarization DMG for distribution", () => {
    expect(paths.submissionArchive).toEndWith("-notarization.zip");
    expect(paths.applicationSubmissionArchive).toEndWith("-application-notarization.zip");
    expect(paths.submissionDmg).toEndWith("-notarization.dmg");
    expect(paths.finalDmg).toEndWith(".dmg");
    expect(paths.verificationArchive).toContain("/.afternote-local-");
    expect(paths.verificationArchive).toEndWith("-verification.zip");
    expect(paths.checksums).toEndWith("/SHA256SUMS");
  });

  it("accepts only the exact public Developer ID artifact", () => {
    expect(() => assertPublicArtifactReport(publicReport, paths.portableDirectory))
      .not.toThrow();
    expect(() => assertPublicArtifactReport(
      { ...publicReport, releaseFlavor: "development" },
      paths.portableDirectory,
    )).toThrow("public semantic-capable artifact");
    expect(() => assertPublicArtifactReport(
      { ...publicReport, signing: "ad-hoc development signature" },
      paths.portableDirectory,
    )).toThrow("requires a Developer ID build");
    expect(() => assertPublicArtifactReport(
      { ...publicReport, portableDirectory: "/tmp/other" },
      paths.portableDirectory,
    )).toThrow("expected release directory");
    expect(() => assertPublicArtifactReport(
      { ...publicReport, sourceTreeClean: false },
      paths.portableDirectory,
    )).toThrow("build-time source provenance");
    expect(() => assertPublicArtifactReport(
      { ...publicReport, embeddedRuntimePath: "/tmp/other-runtime" },
      paths.portableDirectory,
    )).toThrow("self-contained desktop runtime");
    expect(() => assertPublicArtifactReport(
      { ...publicReport, buildProvenanceSha256: null },
      paths.portableDirectory,
    )).toThrow("signed dependency and payload provenance");
    expect(() => assertPublicArtifactReport(
      { ...publicReport, semanticRuntimeIncluded: false },
      paths.portableDirectory,
    )).toThrow("semantic-capable");
  });
});
