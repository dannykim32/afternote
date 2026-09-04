import {
  createHash,
} from "node:crypto";
import {
  copyFileSync,
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
  payloadManifestPath,
  verifyPayloadManifest,
  writePayloadManifest,
} from "./release-payload-manifest";

if (process.versions.bun !== "1.3.14") {
  throw new Error(`Afternote release finalization requires Bun 1.3.14; found ${process.versions.bun ?? "unknown"}`);
}

type ArtifactReport = {
  version: string;
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
  onnxRuntimePath: string;
  ownerControlAppPath: string;
  embeddedRuntimePath: string;
  sourceCommit: string;
  sourceTreeClean: boolean;
  dependencyLockSha256: string;
  payloadManifestSha256: string | null;
  buildProvenanceSha256: string | null;
};

export type ReleaseFinalizationPaths = {
  portableDirectory: string;
  submissionArchive: string;
  applicationSubmissionArchive: string;
  submissionDmg: string;
  finalDmg: string;
  verificationArchive: string;
  checksums: string;
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
  if (report.releaseFlavor !== "public" || !report.semanticRuntimeIncluded) {
    throw new Error("Release finalization requires the public semantic-capable artifact");
  }
  if (!report.signing.startsWith("Developer ID hardened-runtime signature")) {
    throw new Error("Release finalization requires a Developer ID build");
  }
  if (!report.sourceTreeClean || !/^[0-9a-f]{40}$/.test(report.sourceCommit)) {
    throw new Error("Release finalization requires clean build-time source provenance");
  }
  if (!/^[a-f0-9]{64}$/.test(report.dependencyLockSha256) ||
    typeof report.payloadManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.payloadManifestSha256) ||
    typeof report.buildProvenanceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(report.buildProvenanceSha256)) {
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
  if (!/^[a-f0-9]{64}$/.test(artifact.dependencyLockSha256) ||
    sha256(join(repositoryRoot, "bun.lock")) !== artifact.dependencyLockSha256) {
    throw new Error("Release dependency lock changed after packaging");
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
    artifact.onnxRuntimePath,
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
  resealDesktopApplication({
    portableRoot,
    ownerControlAppPath: artifact.ownerControlAppPath,
    embeddedRuntimePath,
    brokerWorkerAppPath: artifact.brokerWorkerAppPath,
    clientSignerAppPath: artifact.clientSignerAppPath,
    signingIdentity,
  });
  verifyPayloadManifest(portableRoot);
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
  verifyDesktopDmg(paths.finalDmg, teamId);

  run(["ditto", "-c", "-k", "--keepParent", portableRoot, paths.verificationArchive]);
  verifyExtractedArchive(paths.verificationArchive, portableRoot, artifact, teamId);
  rmSync(paths.verificationArchive, { force: true });

  const checksums = [`${sha256(paths.finalDmg)}  ${basename(paths.finalDmg)}`];
  writeFileSync(paths.checksums, `${checksums.join("\n")}\n`, { mode: 0o644 });

  writeFileSync(paths.report, `${JSON.stringify({
    format: "afternote-local-release-finalization",
    version: 1,
    sourceCommit,
    artifactVersion: artifact.version,
    notarySubmissionId: notary.id,
    notarizationStatus: notary.status,
    applicationNotarySubmissionId: applicationNotary.id,
    dmgNotarySubmissionId: dmgNotary.id,
    finalDmg: paths.finalDmg,
    finalDmgSha256: sha256(paths.finalDmg),
    checksums: paths.checksums,
    embeddedBuildProvenanceSha256: artifact.buildProvenanceSha256,
  }, null, 2)}\n`, { mode: 0o644 });
  console.log(readFileSync(paths.report, "utf8"));
}

function resealDesktopApplication(options: {
  portableRoot: string;
  ownerControlAppPath: string;
  embeddedRuntimePath: string;
  brokerWorkerAppPath: string;
  clientSignerAppPath: string;
  signingIdentity: string;
}): void {
  for (const [source, name] of [
    [options.brokerWorkerAppPath, "AfternoteVaultWorker.app"],
    [options.clientSignerAppPath, "AfternoteClientSigner.app"],
  ] as const) {
    const destination = join(options.embeddedRuntimePath, name);
    rmSync(destination, { recursive: true, force: true });
    run(["ditto", source, destination]);
    run(["xcrun", "stapler", "validate", destination]);
  }
  writePayloadManifest(options.portableRoot);
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
}

function createDesktopDmg(destination: string, applicationPath: string): void {
  const stage = mkdtempSync(join(tmpdir(), "afternote-dmg-stage-"));
  try {
    const stagedApplication = join(stage, "Afternote.app");
    run(["ditto", applicationPath, stagedApplication]);
    run(["ln", "-s", "/Applications", join(stage, "Applications")]);
    run([
      "hdiutil",
      "create",
      "-volname",
      "Afternote",
      "-srcfolder",
      stage,
      "-ov",
      "-format",
      "UDZO",
      destination,
    ]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function verifyDesktopDmg(dmgPath: string, teamId: string): void {
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
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=4", appPath]);
    const details = run(["codesign", "-dv", "--verbose=4", appPath]).stderr;
    if (!details.includes(`TeamIdentifier=${teamId}`)) {
      throw new Error("DMG application signing identity mismatch");
    }
    run(["xcrun", "stapler", "validate", appPath]);
    run(["spctl", "--assess", "--type", "execute", "--verbose=4", appPath]);
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
      artifact.onnxRuntimePath,
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
  if (parsed.format !== "afternote-signed-build-provenance" || parsed.version !== 1 ||
    parsed.sourceCommit !== artifact.sourceCommit ||
    parsed.dependencyLockSha256 !== artifact.dependencyLockSha256) {
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
  const result = Bun.spawnSync(resolvedCommand, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${resolvedCommand.join(" ")}): ${stderr || stdout}`);
  }
  return { stdout, stderr };
}
