import {
  createHash,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  assertEmbeddedRuntimeMatchesPortable,
  assertOnlyAllowedPayloadChanges,
  collectPayloadEntries,
  payloadManifestPath,
  readPayloadManifestEntries,
  verifyApplicationPayloadManifest,
  verifyEmbeddedRuntimeManifest,
  verifyPayloadManifest,
  writePayloadManifest,
} from "./release-payload-manifest";
import {
  releaseCommandEnvironment,
  releaseEnvironmentSha256,
} from "./release-environment";
import { sha256DirectoryTree } from "./release-inputs";
import {
  appcastGenerationCommand,
  assertSparkleSigningIdentity,
  assertSignedUpdateAppcast,
  releaseAssetUrlPrefix,
  releaseNotesForVersion,
  signedUpdateSignature,
} from "./release-appcast";
import {
  releaseProvisioningProfileIdentity,
  releaseToolchainIdentity,
} from "./build-local-alpha";

if (process.versions.bun !== "1.3.14") {
  throw new Error(`Afternote release finalization requires Bun 1.3.14; found ${process.versions.bun ?? "unknown"}`);
}

type ArtifactReport = {
  version: string;
  marketingVersion: string;
  bundleVersion: string;
  platform: string;
  releaseFlavor: string;
  semanticRuntimeIncluded: boolean;
  signing: string;
  portableDirectory: string;
  binaryPath: string;
  brokerBinaryPath: string;
  brokerWorkerAppPath: string;
  brokerWorkerPath: string;
  clientSignerAppPath: string;
  clientSignerPath: string;
  sqlcipherAddonPath: string;
  sqlcipherLibraryPath: string;
  cryptoLibraryPath: string;
  onnxRuntimeBindingPath: string;
  onnxRuntimePath: string;
  ownerControlAppPath: string;
  sparkleFrameworkPath: string;
  sparkleAutoupdatePath: string;
  sparkleUpdaterAppPath: string;
  embeddedRuntimePath: string;
  sourceCommit: string;
  sourceTree: string;
  sourceTreeClean: boolean;
  dependencyLockSha256: string;
  dependencyTreeSha256: string | null;
  buildEnvironmentSha256: string | null;
  toolchainSha256: string | null;
  provisioningProfilesSha256: string | null;
  payloadManifestSha256: string | null;
  buildProvenanceSha256: string | null;
  nativeReleaseDependencyTreeSha256: string | null;
};

export type ReleaseFinalizationPaths = {
  portableDirectory: string;
  submissionArchive: string;
  applicationSubmissionArchive: string;
  submissionDmg: string;
  finalDmg: string;
  verificationArchive: string;
  checksums: string;
  appcast: string;
  report: string;
};

export function releaseFinalizationPaths(
  outputDirectory: string,
  version: string,
): ReleaseFinalizationPaths {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  const base = `afternote-local-${version}-darwin-arm64`;
  return {
    portableDirectory: join(outputDirectory, base),
    submissionArchive: join(outputDirectory, `${base}-notarization.zip`),
    applicationSubmissionArchive: join(outputDirectory, `${base}-application-notarization.zip`),
    submissionDmg: join(outputDirectory, `${base}-notarization.dmg`),
    finalDmg: join(outputDirectory, `${base}.dmg`),
    verificationArchive: join(outputDirectory, `.${base}-verification.zip`),
    checksums: join(outputDirectory, "SHA256SUMS"),
    appcast: join(outputDirectory, "appcast-alpha.xml"),
    report: join(outputDirectory, "release-finalization-report.json"),
  };
}

export function assertPublicArtifactReport(
  report: ArtifactReport,
  expectedPortableDirectory: string,
): void {
  if (report.platform !== "darwin-arm64") {
    throw new Error("Release finalization requires a darwin-arm64 artifact");
  }
  if (!/^\d+\.\d+\.\d+$/.test(report.marketingVersion) ||
    !/^\d+(?:\.\d+){0,2}$/.test(report.bundleVersion)) {
    throw new Error("Release finalization requires valid Apple bundle version metadata");
  }
  if (report.releaseFlavor !== "public" || !report.semanticRuntimeIncluded) {
    throw new Error("Release finalization requires the public semantic-capable artifact");
  }
  if (!report.signing.startsWith("Developer ID hardened-runtime signature")) {
    throw new Error("Release finalization requires a Developer ID build");
  }
  if (!report.sourceTreeClean || !/^[0-9a-f]{40}$/.test(report.sourceCommit) ||
    !/^[0-9a-f]{40}$/.test(report.sourceTree)) {
    throw new Error("Release finalization requires clean build-time source provenance");
  }
  if (!/^[a-f0-9]{64}$/.test(report.dependencyLockSha256) ||
    typeof report.dependencyTreeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.dependencyTreeSha256) ||
    typeof report.buildEnvironmentSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.buildEnvironmentSha256) ||
    typeof report.toolchainSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.toolchainSha256) ||
    typeof report.provisioningProfilesSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.provisioningProfilesSha256) ||
    typeof report.payloadManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.payloadManifestSha256) ||
    typeof report.buildProvenanceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.buildProvenanceSha256) ||
    typeof report.nativeReleaseDependencyTreeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.nativeReleaseDependencyTreeSha256)) {
    throw new Error("Release finalization requires signed dependency and payload provenance");
  }
  if (resolve(report.portableDirectory) !== resolve(expectedPortableDirectory)) {
    throw new Error("Artifact report does not name the expected release directory");
  }
  const expectedRuntime = join(
    report.ownerControlAppPath,
    "Contents",
    "Resources",
    "AfternoteRuntime",
  );
  if (resolve(report.embeddedRuntimePath) !== resolve(expectedRuntime)) {
    throw new Error("Release finalization requires the self-contained desktop runtime");
  }
  const expectedFramework = join(
    report.ownerControlAppPath,
    "Contents",
    "Frameworks",
    "Sparkle.framework",
  );
  if (resolve(report.sparkleFrameworkPath) !== resolve(expectedFramework)) {
    throw new Error("Release finalization requires the embedded Sparkle framework");
  }
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (import.meta.main) finalizeLocalRelease();

function finalizeLocalRelease(): void {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Release finalization requires macOS arm64");
  }
  const repositoryRoot = resolve(process.cwd());
  releaseCommandEnvironment(process.env);
  const outputDirectory = join(repositoryRoot, "build/local-alpha");
  const artifactReportPath = join(outputDirectory, "artifact-report.json");
  const artifact = JSON.parse(readFileSync(artifactReportPath, "utf8")) as ArtifactReport;
  const paths = releaseFinalizationPaths(outputDirectory, artifact.version);
  assertPublicArtifactReport(artifact, paths.portableDirectory);
  requireCleanSource(repositoryRoot);
  const sourceCommit = run(["git", "rev-parse", "HEAD"], repositoryRoot).stdout.trim();
  if (artifact.sourceCommit !== sourceCommit) {
    throw new Error("Release artifact was not built from the current source commit");
  }
  const sourceTree = run(["git", "rev-parse", "HEAD^{tree}"], repositoryRoot).stdout.trim();
  if (artifact.sourceTree !== sourceTree) {
    throw new Error("Release artifact was not built from the current source tree");
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.dependencyLockSha256) ||
    sha256(join(repositoryRoot, "bun.lock")) !== artifact.dependencyLockSha256) {
    throw new Error("Release dependency lock changed after packaging");
  }
  if (sha256DirectoryTree(join(repositoryRoot, "node_modules")) !==
    artifact.dependencyTreeSha256 ||
    process.env.AFTERNOTE_RELEASE_DEPENDENCY_TREE_SHA256 !== artifact.dependencyTreeSha256) {
    throw new Error("Release dependency tree changed after packaging");
  }
  if (releaseEnvironmentSha256(releaseCommandEnvironment(process.env)) !==
    artifact.buildEnvironmentSha256) {
    throw new Error("Release build environment changed after packaging");
  }
  const toolchainSha256 = createHash("sha256")
    .update(JSON.stringify(releaseToolchainIdentity()))
    .digest("hex");
  if (toolchainSha256 !== artifact.toolchainSha256) {
    throw new Error("Release toolchain changed after packaging");
  }
  const provisioningProfilesSha256 = createHash("sha256")
    .update(JSON.stringify(releaseProvisioningProfileIdentity()))
    .digest("hex");
  if (provisioningProfilesSha256 !== artifact.provisioningProfilesSha256) {
    throw new Error("Release provisioning profiles changed after packaging");
  }
  if (sha256DirectoryTree(join(repositoryRoot, "apps/local/native/release-deps")) !==
    artifact.nativeReleaseDependencyTreeSha256) {
    throw new Error("Prepared native release dependencies changed after packaging");
  }

  const teamId = requiredEnvironment("AFTERNOTE_TEAM_ID");
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("AFTERNOTE_TEAM_ID must be a ten-character Apple Team ID");
  }
  const notaryProfile = requiredEnvironment("AFTERNOTE_NOTARY_KEYCHAIN_PROFILE");
  const signingIdentity = requiredEnvironment("AFTERNOTE_SIGNING_IDENTITY");
  const portableRoot = requireRegularDirectory(paths.portableDirectory);
  const initialPayloadManifestPath = payloadManifestPath(portableRoot);
  if (typeof artifact.payloadManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.payloadManifestSha256) ||
    sha256(initialPayloadManifestPath) !== artifact.payloadManifestSha256) {
    throw new Error("Signed payload manifest does not match the build report");
  }
  verifyPayloadManifest(portableRoot);
  const approvedPayloadEntries = readPayloadManifestEntries(portableRoot);
  verifyBuildProvenance(portableRoot, artifact, repositoryRoot);
  const embeddedRuntimePath = requireContainedPath(
    portableRoot,
    requireRegularDirectory(artifact.embeddedRuntimePath),
  );
  const signedPaths = [
    artifact.binaryPath,
    artifact.brokerBinaryPath,
    artifact.brokerWorkerPath,
    artifact.clientSignerPath,
    artifact.sqlcipherAddonPath,
    artifact.sqlcipherLibraryPath,
    artifact.cryptoLibraryPath,
    artifact.onnxRuntimeBindingPath,
    artifact.onnxRuntimePath,
    artifact.sparkleAutoupdatePath,
    artifact.sparkleUpdaterAppPath,
    artifact.sparkleFrameworkPath,
    artifact.ownerControlAppPath,
    artifact.brokerWorkerAppPath,
    artifact.clientSignerAppPath,
  ].map((path) => requireContainedPath(portableRoot, path));
  const appPaths = [
    artifact.ownerControlAppPath,
    artifact.brokerWorkerAppPath,
    artifact.clientSignerAppPath,
  ]
    .map((path) => requireContainedPath(portableRoot, path));

  verifySignatures(signedPaths, appPaths, teamId, false);
  for (const output of [
    paths.submissionArchive,
    paths.applicationSubmissionArchive,
    paths.submissionDmg,
    paths.finalDmg,
    paths.verificationArchive,
    paths.appcast,
    paths.report,
  ]) rmSync(output, { force: true });

  run(["ditto", "-c", "-k", "--keepParent", portableRoot, paths.submissionArchive]);
  const notary = JSON.parse(run([
    "xcrun",
    "notarytool",
    "submit",
    paths.submissionArchive,
    "--keychain-profile",
    notaryProfile,
    "--wait",
    "--output-format",
    "json",
  ]).stdout) as { id?: string; status?: string; message?: string };
  if (notary.status !== "Accepted" || !notary.id) {
    throw new Error(`Apple notarization was not accepted: ${notary.status ?? "unknown"}`);
  }

  const helperAppPaths = [artifact.brokerWorkerAppPath, artifact.clientSignerAppPath]
    .map((path) => requireContainedPath(portableRoot, path));
  for (const appPath of helperAppPaths) {
    run(["xcrun", "stapler", "staple", appPath]);
    run(["xcrun", "stapler", "validate", appPath]);
  }
  artifact.payloadManifestSha256 = resealDesktopApplication({
    portableRoot,
    ownerControlAppPath: artifact.ownerControlAppPath,
    embeddedRuntimePath,
    brokerWorkerAppPath: artifact.brokerWorkerAppPath,
    clientSignerAppPath: artifact.clientSignerAppPath,
    signingIdentity,
    approvedPayloadEntries,
  });
  verifyPayloadManifest(portableRoot);
  if (sha256(payloadManifestPath(portableRoot)) !== artifact.payloadManifestSha256) {
    throw new Error("Final payload manifest does not match the resealed application");
  }
  verifyBuildProvenance(portableRoot, artifact, repositoryRoot);
  run([
    "ditto", "-c", "-k", "--keepParent",
    artifact.ownerControlAppPath, paths.applicationSubmissionArchive,
  ]);
  const applicationNotary = JSON.parse(run([
    "xcrun",
    "notarytool",
    "submit",
    paths.applicationSubmissionArchive,
    "--keychain-profile",
    notaryProfile,
    "--wait",
    "--output-format",
    "json",
  ]).stdout) as { id?: string; status?: string; message?: string };
  if (applicationNotary.status !== "Accepted" || !applicationNotary.id) {
    throw new Error(
      `Apple application notarization was not accepted: ${applicationNotary.status ?? "unknown"}`,
    );
  }
  run(["xcrun", "stapler", "staple", artifact.ownerControlAppPath]);
  run(["xcrun", "stapler", "validate", artifact.ownerControlAppPath]);
  verifySignatures(signedPaths, appPaths, teamId, true);

  createDesktopDmg(paths.submissionDmg, artifact.ownerControlAppPath);
  const dmgNotary = JSON.parse(run([
    "xcrun",
    "notarytool",
    "submit",
    paths.submissionDmg,
    "--keychain-profile",
    notaryProfile,
    "--wait",
    "--output-format",
    "json",
  ]).stdout) as { id?: string; status?: string; message?: string };
  if (dmgNotary.status !== "Accepted" || !dmgNotary.id) {
    throw new Error(`Apple DMG notarization was not accepted: ${dmgNotary.status ?? "unknown"}`);
  }
  run(["xcrun", "stapler", "staple", paths.submissionDmg]);
  run(["xcrun", "stapler", "validate", paths.submissionDmg]);
  run(["hdiutil", "verify", paths.submissionDmg]);
  copyFileSync(paths.submissionDmg, paths.finalDmg);
  rmSync(paths.submissionDmg, { force: true });
  verifyDesktopDmg(paths.finalDmg, teamId, artifact.payloadManifestSha256);

  generateSignedAppcast({
    repositoryRoot,
    outputPath: paths.appcast,
    finalDmg: paths.finalDmg,
    version: artifact.version,
    bundleVersion: artifact.bundleVersion,
  });

  run(["ditto", "-c", "-k", "--keepParent", portableRoot, paths.verificationArchive]);
  verifyExtractedArchive(paths.verificationArchive, portableRoot, artifact, teamId);
  rmSync(paths.verificationArchive, { force: true });

  requireCleanSource(repositoryRoot);
  if (run(["git", "rev-parse", "HEAD"], repositoryRoot).stdout.trim() !== sourceCommit ||
    run(["git", "rev-parse", "HEAD^{tree}"], repositoryRoot).stdout.trim() !== sourceTree ||
    sha256(join(repositoryRoot, "bun.lock")) !== artifact.dependencyLockSha256 ||
    sha256DirectoryTree(join(repositoryRoot, "node_modules")) !== artifact.dependencyTreeSha256) {
    throw new Error("Release source inputs changed during finalization");
  }

  // SHA256SUMS accompanies the immutable GitHub Release asset. The signed
  // appcast is published separately at the repository root and authenticates
  // itself with Sparkle's EdDSA feed signature.
  const checksums = [paths.finalDmg]
    .map((path) => `${sha256(path)}  ${basename(path)}`);
  writeFileSync(paths.checksums, `${checksums.join("\n")}\n`, { mode: 0o644 });

  writeFileSync(paths.report, `${JSON.stringify({
    format: "afternote-local-release-finalization",
    version: 2,
    sourceCommit,
    artifactVersion: artifact.version,
    notarySubmissionId: notary.id,
    notarizationStatus: notary.status,
    applicationNotarySubmissionId: applicationNotary.id,
    dmgNotarySubmissionId: dmgNotary.id,
    finalDmg: paths.finalDmg,
    finalDmgSha256: sha256(paths.finalDmg),
    appcast: paths.appcast,
    appcastSha256: sha256(paths.appcast),
    checksums: paths.checksums,
    embeddedBuildProvenanceSha256: artifact.buildProvenanceSha256,
    finalPayloadManifestSha256: artifact.payloadManifestSha256,
  }, null, 2)}\n`, { mode: 0o644 });
  console.log(readFileSync(paths.report, "utf8"));
}

function generateSignedAppcast(options: {
  repositoryRoot: string;
  outputPath: string;
  finalDmg: string;
  version: string;
  bundleVersion: string;
}): void {
  const inputs = JSON.parse(readFileSync(
    join(options.repositoryRoot, "scripts/native-release-inputs.json"),
    "utf8",
  )) as { sparklePublicEdKey?: unknown; sparkleSigningAccount?: unknown };
  if (typeof inputs.sparkleSigningAccount !== "string" ||
    typeof inputs.sparklePublicEdKey !== "string") {
    throw new Error("Native release inputs are missing the Sparkle signing identity");
  }
  const generateKeysTool = join(
    options.repositoryRoot,
    "apps/local/native/release-deps/generate_keys",
  );
  assertSparkleSigningIdentity(
    run([generateKeysTool, "--account", inputs.sparkleSigningAccount, "-p"]).stdout,
    inputs.sparklePublicEdKey,
  );
  const stage = mkdtempSync(join(tmpdir(), "afternote-appcast-"));
  try {
    const artifactFilename = basename(options.finalDmg);
    const stagedDmg = join(stage, artifactFilename);
    copyFileSync(options.finalDmg, stagedDmg);
    writeFileSync(
      join(stage, `${artifactFilename.slice(0, -4)}.md`),
      releaseNotesForVersion(
        readFileSync(join(options.repositoryRoot, "CHANGELOG.md"), "utf8"),
        options.version,
      ),
      { mode: 0o644 },
    );
    const previousAppcast = join(options.repositoryRoot, "appcast-alpha.xml");
    const stagedAppcast = join(stage, "appcast-alpha.xml");
    if (existsSync(previousAppcast)) copyFileSync(previousAppcast, stagedAppcast);
    const downloadUrlPrefix = releaseAssetUrlPrefix(options.version);
    run(appcastGenerationCommand({
      toolPath: join(
        options.repositoryRoot,
        "apps/local/native/release-deps/generate_appcast",
      ),
      account: inputs.sparkleSigningAccount,
      outputPath: stagedAppcast,
      archiveDirectory: stage,
      downloadUrlPrefix,
    }), options.repositoryRoot);
    const appcast = readFileSync(stagedAppcast, "utf8");
    assertSignedUpdateAppcast(appcast, {
      artifactFilename,
      artifactBytes: lstatSync(stagedDmg).size,
      bundleVersion: options.bundleVersion,
      downloadUrlPrefix,
    });
    const signUpdateTool = join(
      options.repositoryRoot,
      "apps/local/native/release-deps/sign_update",
    );
    run([signUpdateTool, "--account", inputs.sparkleSigningAccount, "--verify", stagedAppcast]);
    run([
      signUpdateTool,
      "--account",
      inputs.sparkleSigningAccount,
      "--verify",
      stagedDmg,
      signedUpdateSignature(
        appcast,
        `${downloadUrlPrefix}${encodeURIComponent(artifactFilename)}`,
      ),
    ]);
    copyFileSync(stagedAppcast, options.outputPath);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function resealDesktopApplication(options: {
  portableRoot: string;
  ownerControlAppPath: string;
  embeddedRuntimePath: string;
  brokerWorkerAppPath: string;
  clientSignerAppPath: string;
  signingIdentity: string;
  approvedPayloadEntries: ReturnType<typeof collectPayloadEntries>;
}): string {
  for (const [source, name] of [
    [options.brokerWorkerAppPath, "AfternoteVaultWorker.app"],
    [options.clientSignerAppPath, "AfternoteClientSigner.app"],
  ] as const) {
    const destination = join(options.embeddedRuntimePath, name);
    rmSync(destination, { recursive: true, force: true });
    run(["ditto", source, destination]);
    run(["xcrun", "stapler", "validate", destination]);
  }
  assertOnlyAllowedPayloadChanges(
    options.approvedPayloadEntries,
    collectPayloadEntries(options.portableRoot),
    [
      "AfternoteVaultWorker.app",
      "AfternoteClientSigner.app",
      "Afternote.app/Contents/Resources/AfternoteRuntime/AfternoteVaultWorker.app",
      "Afternote.app/Contents/Resources/AfternoteRuntime/AfternoteClientSigner.app",
    ],
  );
  assertEmbeddedRuntimeMatchesPortable(options.portableRoot);
  const manifestPath = writePayloadManifest(options.portableRoot);
  verifyPayloadManifest(options.portableRoot);
  run([
    "codesign",
    "--force",
    "--sign",
    options.signingIdentity,
    "--options",
    "runtime",
    "--timestamp",
    "--identifier",
    "dev.afternote.owner-control",
    options.ownerControlAppPath,
  ]);
  run([
    "codesign", "--verify", "--deep", "--strict", "--verbose=4",
    options.ownerControlAppPath,
  ]);
  return sha256(manifestPath);
}

export function createDesktopDmg(destination: string, applicationPath: string): void {
  const stage = mkdtempSync(join(tmpdir(), "afternote-dmg-stage-"));
  const payload = join(stage, "payload");
  const mountPoint = join(stage, "mount");
  const readWriteDmg = join(stage, "afternote-layout.dmg");
  let mounted = false;
  try {
    mkdirSync(payload, { mode: 0o700 });
    mkdirSync(mountPoint, { mode: 0o700 });
    const stagedApplication = join(payload, "Afternote.app");
    run(["ditto", applicationPath, stagedApplication]);
    run(["ln", "-s", "/Applications", join(payload, "Applications")]);
    run([
      "hdiutil",
      "create",
      "-volname",
      "Afternote",
      "-srcfolder",
      payload,
      "-ov",
      "-format",
      "UDRW",
      readWriteDmg,
    ]);
    run([
      "hdiutil", "attach", "-readwrite", "-noverify", "-nobrowse",
      "-mountpoint", mountPoint, readWriteDmg,
    ]);
    mounted = true;
    try {
      run(["/bin/sleep", "1"]);
      const layout = desktopDmgFinderLayout();
      run([
        "/usr/bin/osascript",
        "-e",
        `tell application "Finder"
          set mountedVolume to POSIX file "${mountPoint}" as alias
          open mountedVolume
          set volumeWindow to container window of mountedVolume
          set current view of volumeWindow to icon view
          set toolbar visible of volumeWindow to false
          set statusbar visible of volumeWindow to false
          set bounds of volumeWindow to {${layout.windowBounds.join(", ")}}
          set arrangement of icon view options of volumeWindow to not arranged
          set icon size of icon view options of volumeWindow to ${layout.iconSize}
          set text size of icon view options of volumeWindow to ${layout.textSize}
          set position of item "Afternote.app" of mountedVolume to {${layout.appPosition.join(", ")}}
          set position of item "Applications" of mountedVolume to {${layout.applicationsPosition.join(", ")}}
          update mountedVolume without registering applications
          delay 1
          close volumeWindow
        end tell`,
      ]);
      const finderMetadata = join(mountPoint, ".DS_Store");
      const metadata = lstatSync(finderMetadata);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("Finder did not create regular DMG layout metadata");
      }
      run(["/usr/bin/SetFile", "-a", "V", finderMetadata]);
      for (const transientMetadata of [".fseventsd", ".Spotlight-V100", ".Trashes"]) {
        rmSync(join(mountPoint, transientMetadata), { recursive: true, force: true });
      }
      run(["/bin/sync"]);
    } finally {
      detachDesktopDmg(mountPoint);
      mounted = false;
    }
    run([
      "hdiutil", "convert", readWriteDmg, "-ov", "-format", "UDZO",
      "-imagekey", "zlib-level=9", "-o", destination,
    ]);
  } finally {
    if (mounted) {
      detachDesktopDmg(mountPoint);
      mounted = false;
    }
    if (!mounted) rmSync(stage, { recursive: true, force: true });
  }
}

function detachDesktopDmg(mountPoint: string): void {
  try {
    run(["hdiutil", "detach", mountPoint]);
  } catch {
    run(["hdiutil", "detach", "-force", mountPoint]);
  }
}

export function desktopDmgFinderLayout(): {
  windowBounds: [number, number, number, number];
  iconSize: number;
  textSize: number;
  appPosition: [number, number];
  applicationsPosition: [number, number];
} {
  return {
    windowBounds: [100, 100, 620, 440],
    iconSize: 112,
    textSize: 14,
    appPosition: [150, 160],
    applicationsPosition: [370, 160],
  };
}

function verifyDesktopDmg(
  dmgPath: string,
  teamId: string,
  payloadManifestSha256: string,
): void {
  const mountRoot = mkdtempSync(join(tmpdir(), "afternote-dmg-verify-"));
  const mountPoint = join(mountRoot, "Afternote");
  mkdirSync(mountPoint, { mode: 0o700 });
  let mounted = false;
  try {
    run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath]);
    mounted = true;
    const appPath = requireRegularDirectory(join(mountPoint, "Afternote.app"));
    const applicationsLink = join(mountPoint, "Applications");
    const linkInfo = lstatSync(applicationsLink);
    if (!linkInfo.isSymbolicLink() || readlinkSync(applicationsLink) !== "/Applications") {
      throw new Error("DMG does not contain the expected Applications shortcut");
    }
    const finderMetadata = lstatSync(join(mountPoint, ".DS_Store"));
    if (!finderMetadata.isFile() || finderMetadata.isSymbolicLink() || finderMetadata.size === 0) {
      throw new Error("DMG does not contain valid Finder layout metadata");
    }
    for (const transientMetadata of [".fseventsd", ".Spotlight-V100", ".Trashes"]) {
      if (existsSync(join(mountPoint, transientMetadata))) {
        throw new Error(`DMG contains transient macOS metadata: ${transientMetadata}`);
      }
    }
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=4", appPath]);
    const details = run(["codesign", "-dv", "--verbose=4", appPath]).stderr;
    if (!details.includes(`TeamIdentifier=${teamId}`)) {
      throw new Error("DMG application signing identity mismatch");
    }
    run(["xcrun", "stapler", "validate", appPath]);
    run(["spctl", "--assess", "--type", "execute", "--verbose=4", appPath]);
    verifyEmbeddedRuntimeManifest(appPath);
    verifyApplicationPayloadManifest(appPath);
    if (sha256(join(
      appPath,
      "Contents/Resources/AFTERNOTE_PAYLOAD_MANIFEST.json",
    )) !== payloadManifestSha256) {
      throw new Error("DMG payload manifest differs from the finalized release manifest");
    }
  } finally {
    if (mounted) run(["hdiutil", "detach", mountPoint]);
    rmSync(mountRoot, { recursive: true, force: true });
  }
}

function verifyExtractedArchive(
  archive: string,
  originalPortableRoot: string,
  artifact: ArtifactReport,
  teamId: string,
): void {
  const directory = mkdtempSync(join(tmpdir(), "afternote-notarized-verify-"));
  try {
    run(["ditto", "-x", "-k", archive, directory]);
    const extractedRoot = requireRegularDirectory(join(directory, basename(originalPortableRoot)));
    verifyPayloadManifest(extractedRoot);
    if (sha256(payloadManifestPath(extractedRoot)) !== artifact.payloadManifestSha256) {
      throw new Error("Extracted release payload manifest differs from finalization");
    }
    verifyBuildProvenance(extractedRoot, artifact);
    const translate = (path: string) =>
      requireContainedPath(extractedRoot, join(extractedRoot, relative(originalPortableRoot, path)));
    const signedPaths = [
      artifact.binaryPath,
      artifact.brokerBinaryPath,
      artifact.brokerWorkerPath,
      artifact.clientSignerPath,
      artifact.sqlcipherAddonPath,
      artifact.sqlcipherLibraryPath,
      artifact.cryptoLibraryPath,
      artifact.onnxRuntimeBindingPath,
      artifact.onnxRuntimePath,
      artifact.sparkleAutoupdatePath,
      artifact.sparkleUpdaterAppPath,
      artifact.sparkleFrameworkPath,
      artifact.ownerControlAppPath,
      artifact.brokerWorkerAppPath,
      artifact.clientSignerAppPath,
    ].map(translate);
    const appPaths = [
      artifact.ownerControlAppPath,
      artifact.brokerWorkerAppPath,
      artifact.clientSignerAppPath,
    ].map(translate);
    verifySignatures(signedPaths, appPaths, teamId, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyBuildProvenance(
  portableRoot: string,
  artifact: ArtifactReport,
  repositoryRoot?: string,
): void {
  const provenancePath = join(
    portableRoot,
    "Afternote.app/Contents/Resources/AFTERNOTE_BUILD_PROVENANCE.json",
  );
  if (typeof artifact.buildProvenanceSha256 !== "string" ||
    sha256(provenancePath) !== artifact.buildProvenanceSha256) {
    throw new Error("Signed build provenance does not match the build report");
  }
  const parsed = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
  if (parsed.format !== "afternote-signed-build-provenance" || parsed.version !== 2 ||
    parsed.sourceCommit !== artifact.sourceCommit ||
    parsed.sourceTree !== artifact.sourceTree ||
    parsed.dependencyLockSha256 !== artifact.dependencyLockSha256 ||
    parsed.dependencyTreeSha256 !== artifact.dependencyTreeSha256 ||
    parsed.buildEnvironmentSha256 !== artifact.buildEnvironmentSha256 ||
    parsed.toolchainSha256 !== artifact.toolchainSha256 ||
    parsed.provisioningProfilesSha256 !== artifact.provisioningProfilesSha256 ||
    parsed.nativeReleaseDependencyTreeSha256 !== artifact.nativeReleaseDependencyTreeSha256) {
    throw new Error("Signed build provenance contents are invalid");
  }
  if (repositoryRoot) {
    const nativeInputsPath = join(repositoryRoot, "scripts/native-release-inputs.json");
    if (parsed.nativeReleaseInputsManifestSha256 !== sha256(nativeInputsPath) ||
      JSON.stringify(parsed.nativeReleaseInputs) !==
        JSON.stringify(JSON.parse(readFileSync(nativeInputsPath, "utf8")))) {
      throw new Error("Signed native-input provenance does not match the source manifest");
    }
  }
}

function verifySignatures(
  signedPaths: string[],
  appPaths: string[],
  teamId: string,
  notarized: boolean,
): void {
  for (const path of signedPaths) {
    const info = lstatSync(path);
    if ((!info.isFile() && !info.isDirectory()) || info.isSymbolicLink()) {
      throw new Error(`Release signing target is not a regular path: ${path}`);
    }
    run(["codesign", "--verify", "--strict", "--verbose=4", path]);
    const details = run(["codesign", "-dv", "--verbose=4", path]).stderr;
    if (!details.includes(`TeamIdentifier=${teamId}`) || details.includes("flags=0x2(adhoc)")) {
      throw new Error(`Release signing identity mismatch: ${path}`);
    }
  }
  if (!notarized) return;
  for (const path of appPaths) {
    run(["xcrun", "stapler", "validate", path]);
    run(["spctl", "--assess", "--type", "execute", "--verbose=4", path]);
  }
}

function requireCleanSource(repositoryRoot: string): void {
  const status = run(["git", "status", "--porcelain", "--untracked-files=all"], repositoryRoot)
    .stdout.trim();
  if (status) throw new Error("Release finalization requires a clean tracked working tree");
}

function requireRegularDirectory(path: string): string {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Release directory is not a regular directory: ${path}`);
  }
  return realpathSync(path);
}

function requireContainedPath(root: string, path: string): string {
  const resolved = realpathSync(path);
  const fromRoot = relative(root, resolved);
  if (fromRoot === "" || fromRoot.startsWith("..") || resolve(root, fromRoot) !== resolved) {
    throw new Error(`Release path escapes its artifact directory: ${path}`);
  }
  return resolved;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Release finalization requires ${name}`);
  return value;
}

function run(command: string[], cwd = process.cwd()): { stdout: string; stderr: string } {
  const [tool, ...args] = command;
  if (!tool) throw new Error("Release finalization command is empty");
  const tools: Readonly<Record<string, string>> = {
    codesign: "/usr/bin/codesign",
    ditto: "/usr/bin/ditto",
    git: "/usr/bin/git",
    hdiutil: "/usr/bin/hdiutil",
    ln: "/bin/ln",
    spctl: "/usr/sbin/spctl",
    xcrun: "/usr/bin/xcrun",
  };
  const resolvedTool = tool.startsWith("/") ? tool : tools[tool];
  if (!resolvedTool) throw new Error(`Release finalization tool is not pinned: ${tool}`);
  const resolvedCommand = [resolvedTool, ...args];
  const result = Bun.spawnSync(resolvedCommand, {
    cwd,
    env: releaseCommandEnvironment(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${resolvedCommand.join(" ")}): ${stderr || stdout}`);
  }
  return { stdout, stderr };
}
