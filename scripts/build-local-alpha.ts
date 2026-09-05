import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import {
  CLIENT_SIGNER_APP_NAME,
  CLIENT_SIGNER_EXECUTABLE_NAME,
  CLIENT_SIGNER_IDENTIFIER,
  OWNER_CONTROL_IDENTIFIER,
  OWNER_CONTROL_MACH_SERVICE,
  VAULT_BROKER_IDENTIFIER,
  clientSignerAccessGroup,
} from "../apps/local/src/vault-broker-metadata";
import { writeReleaseSupplyChainArtifacts } from "./release-supply-chain";
import {
  assertEmbeddedRuntimeMatchesPortable,
  writePayloadManifest,
} from "./release-payload-manifest";
import {
  releaseCommandEnvironment,
  releaseEnvironmentSha256,
} from "./release-environment";
import { sha256DirectoryTree } from "./release-inputs";

const repositoryRoot = resolve(process.cwd());
const packagingRoot = join(repositoryRoot, "apps/local/packaging");
assertPinnedBun();

export type LocalAlphaArtifacts = {
  version: string;
  platform: "darwin-arm64";
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
  embeddedRuntimePath: string;
  portableArchivePath: string;
  checksumsPath: string;
  sbomPath: string;
  noticesPath: string;
  portableDirectory: string;
  brokerMachService: string;
  ownerPresenceMode: "required" | "development-bypass";
  releaseFlavor: "development" | "public";
  semanticRuntimeIncluded: boolean;
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
};

function assertPinnedBun(): void {
  if (process.versions.bun !== "1.3.14") {
    throw new Error(`Afternote release tooling requires Bun 1.3.14; found ${process.versions.bun ?? "unknown"}`);
  }
}

export async function buildLocalAlpha(options?: {
  outputDirectory?: string;
  version?: string;
  developmentOwnerPresenceBypass?: boolean;
}): Promise<LocalAlphaArtifacts> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Afternote Local packaging currently supports macOS arm64 only");
  }
  const signing = signingConfiguration();
  const minimumMacosVersion = signing.release ? "13.3" : "26.0";
  const dependencyLockPath = join(repositoryRoot, "bun.lock");
  if (!existsSync(dependencyLockPath) || !lstatSync(dependencyLockPath).isFile() ||
    lstatSync(dependencyLockPath).isSymbolicLink()) {
    throw new Error("Packaging requires a committed regular bun.lock file");
  }
  const dependencyLockSha256 = sha256(dependencyLockPath);
  const source = sourceRevision();
  const sourceCommit = source.commit;
  const sourceTree = source.tree;
  const sourceTreeClean = source.clean;
  if (signing.release && !sourceTreeClean) {
    throw new Error("Release packaging requires a clean source tree");
  }
  const dependencyTreeSha256 = signing.release
    ? requiredReleaseDigest("AFTERNOTE_RELEASE_DEPENDENCY_TREE_SHA256")
    : null;
  if (signing.release &&
    sha256DirectoryTree(join(repositoryRoot, "node_modules")) !== dependencyTreeSha256) {
    throw new Error("Installed release dependency tree does not match the fresh-install snapshot");
  }
  const releaseEnvironment = signing.release
    ? releaseCommandEnvironment(process.env)
    : null;
  const buildEnvironmentSha256 = releaseEnvironment
    ? releaseEnvironmentSha256(releaseEnvironment)
    : null;
  const toolchain = signing.release ? releaseToolchainIdentity() : null;
  const toolchainSha256 = toolchain
    ? createHash("sha256").update(JSON.stringify(toolchain)).digest("hex")
    : null;
  const provisioningProfiles = signing.release ? releaseProvisioningProfileIdentity() : null;
  const provisioningProfilesSha256 = provisioningProfiles
    ? createHash("sha256").update(JSON.stringify(provisioningProfiles)).digest("hex")
    : null;
  const workerEntrypoint = releaseWorkerEntrypoint({
    releaseBuild: process.env.AFTERNOTE_RELEASE_BUILD,
  });
  const includeSemanticRuntime = true;
  const ownerPresenceBypass = developmentOwnerPresenceBypass({
    requested: options?.developmentOwnerPresenceBypass,
    configured: process.env.AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS,
    releaseBuild: process.env.AFTERNOTE_RELEASE_BUILD,
  });
  const acceptanceBuild = process.env.AFTERNOTE_ACCEPTANCE_BUILD === "1";
  const brokerMachService = acceptanceBrokerMachService({
    acceptanceBuild: process.env.AFTERNOTE_ACCEPTANCE_BUILD,
    configuredService: process.env.AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE,
    releaseBuild: process.env.AFTERNOTE_RELEASE_BUILD,
  });
  const ownerControlMachService = brokerMachService === VAULT_BROKER_IDENTIFIER
    ? OWNER_CONTROL_MACH_SERVICE
    : `${brokerMachService}.owner-control`;
  const workerGatewayMachService = `${brokerMachService}.private-worker`;
  if (ownerControlMachService.length > 255 || workerGatewayMachService.length > 255) {
    throw new Error("Derived private Mach service exceeds the platform limit");
  }

  const rootPackage = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ) as { version: string };
  const version = options?.version ??
    process.env.AFTERNOTE_PACKAGE_VERSION ?? rootPackage.version;
  if (!isPackageVersion(version)) {
    throw new Error(`Invalid Afternote package version: ${version}`);
  }
  const outputDirectory = resolve(
    options?.outputDirectory ?? join(repositoryRoot, "build/local-alpha"),
  );
  const portableDirectory = join(
    outputDirectory,
    `afternote-local-${version}-darwin-arm64`,
  );
  const binaryPath = join(portableDirectory, "afternote");
  const brokerBinaryPath = join(portableDirectory, "afternote-vault-broker");
  const brokerWorkerIdentifier = `${VAULT_BROKER_IDENTIFIER}.worker`;
  const brokerWorkerAppPath = join(portableDirectory, "AfternoteVaultWorker.app");
  const brokerWorkerContents = join(brokerWorkerAppPath, "Contents");
  const brokerWorkerExecutableDirectory = join(brokerWorkerContents, "MacOS");
  const brokerWorkerPath = join(
    brokerWorkerExecutableDirectory,
    "afternote-vault-worker",
  );
  const clientSignerAppPath = join(portableDirectory, CLIENT_SIGNER_APP_NAME);
  const clientSignerContents = join(clientSignerAppPath, "Contents");
  const clientSignerPath = join(
    clientSignerContents,
    "MacOS",
    CLIENT_SIGNER_EXECUTABLE_NAME,
  );
  const ownerControlAppPath = join(portableDirectory, "Afternote.app");
  const ownerControlContents = join(ownerControlAppPath, "Contents");
  const ownerControlBinaryPath = join(
    ownerControlContents,
    "MacOS",
    "Afternote",
  );
  const embeddedRuntimePath = join(
    ownerControlContents,
    "Resources",
    "AfternoteRuntime",
  );
  const onnxRuntimeLibraryName = "libonnxruntime.1.21.0.dylib";
  const onnxRuntimeLibraryPath = join(portableDirectory, onnxRuntimeLibraryName);
  const onnxRuntimeBindingName = "onnxruntime_binding.node";
  const onnxRuntimeBindingPath = join(portableDirectory, onnxRuntimeBindingName);
  const sqlcipherAddonName = "afternote_sqlcipher.node";
  const sqlcipherLibraryName = "libsqlcipher.3.dylib";
  const cryptoLibraryName = "libcrypto.4.dylib";
  const sqlcipherAddonPath = join(portableDirectory, sqlcipherAddonName);
  const sqlcipherLibraryPath = join(portableDirectory, sqlcipherLibraryName);
  const cryptoLibraryPath = join(portableDirectory, cryptoLibraryName);
  const portableArchivePath = `${portableDirectory}.tar.gz`;
  const checksumsPath = join(outputDirectory, "SHA256SUMS");
  const clientMetafilePath = join(outputDirectory, ".afternote-client-meta.json");
  const workerMetafilePath = join(outputDirectory, ".afternote-worker-meta.json");
  const metafilePaths = [
    clientMetafilePath,
    workerMetafilePath,
  ];

  mkdirSync(outputDirectory, { recursive: true });
  for (const generatedPath of [
    portableDirectory,
    portableArchivePath,
    checksumsPath,
    ...metafilePaths,
  ]) {
    rmSync(generatedPath, { recursive: true, force: true });
  }
  mkdirSync(portableDirectory, { recursive: false });
  mkdirSync(brokerWorkerExecutableDirectory, {
    recursive: true,
    mode: 0o755,
  });
  mkdirSync(join(ownerControlContents, "MacOS"), { recursive: true, mode: 0o755 });
  mkdirSync(join(ownerControlContents, "Resources"), { recursive: true, mode: 0o755 });
  mkdirSync(join(clientSignerContents, "MacOS"), {
    recursive: true,
    mode: 0o755,
  });
  writeFileSync(join(ownerControlContents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>Afternote</string>
<key>CFBundleExecutable</key><string>Afternote</string>
<key>CFBundleIdentifier</key><string>${OWNER_CONTROL_IDENTIFIER}</string>
<key>CFBundleIconFile</key><string>Afternote</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Afternote</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>${minimumMacosVersion}</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`, { mode: 0o644 });
  writeFileSync(join(brokerWorkerContents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>Afternote Vault Worker</string>
<key>CFBundleExecutable</key><string>afternote-vault-worker</string>
<key>CFBundleIdentifier</key><string>${brokerWorkerIdentifier}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Afternote Vault Worker</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSBackgroundOnly</key><true/>
<key>LSMinimumSystemVersion</key><string>${minimumMacosVersion}</string>
</dict></plist>
`, { mode: 0o644 });
  writeFileSync(join(clientSignerContents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>Afternote Client Signer</string>
<key>CFBundleExecutable</key><string>${CLIENT_SIGNER_EXECUTABLE_NAME}</string>
<key>CFBundleIdentifier</key><string>${CLIENT_SIGNER_IDENTIFIER}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>Afternote Client Signer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSBackgroundOnly</key><true/>
<key>LSMinimumSystemVersion</key><string>${minimumMacosVersion}</string>
</dict></plist>
`, { mode: 0o644 });
  if (signing.release) {
    const profilePath = resolve(requiredReleaseEnvironment(
      "AFTERNOTE_PROVISIONING_PROFILE",
    ));
    const profile = readProvisioningProfile(profilePath, outputDirectory);
    assertReleaseProvisioningProfile(profile, {
      teamId: signing.teamId!,
      identifier: brokerWorkerIdentifier,
      accessGroup: signing.accessGroup!,
    });
    copyFileSync(
      profilePath,
      join(brokerWorkerContents, "embedded.provisionprofile"),
    );
    const clientSignerProfilePath = resolve(requiredReleaseEnvironment(
      "AFTERNOTE_CLIENT_SIGNER_PROVISIONING_PROFILE",
    ));
    const clientSignerProfile = readProvisioningProfile(
      clientSignerProfilePath,
      outputDirectory,
    );
    assertReleaseProvisioningProfile(clientSignerProfile, {
      teamId: signing.teamId!,
      identifier: CLIENT_SIGNER_IDENTIFIER,
      accessGroup: signing.clientAccessGroup!,
    });
    copyFileSync(
      clientSignerProfilePath,
      join(clientSignerContents, "embedded.provisionprofile"),
    );
  }
  buildApplicationIcon(
    join(repositoryRoot, "apps/local/assets/AfternoteIcon-1024.png"),
    join(ownerControlContents, "Resources", "Afternote.icns"),
    outputDirectory,
  );
  runPackagingCommand([
    "clang++",
    "-std=c++17",
    "-O2",
    "-fobjc-arc",
    "-fblocks",
    ...(signing.release ? ["-mmacosx-version-min=13.3"] : []),
    ...(acceptanceBuild ? ["-DAFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING=1"] : []),
    ...(!signing.release ? ["-DAFTERNOTE_DEVELOPMENT_BUILD=1"] : []),
    ...(signing.release ? ["-DAFTERNOTE_RELEASE_BUILD=1"] : []),
    ...(ownerPresenceBypass
      ? ["-DAFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS=1"]
      : []),
    `-DAFTERNOTE_OWNER_CONTROL_MACH_SERVICE=${JSON.stringify(ownerControlMachService)}`,
    `-DAFTERNOTE_BROKER_CODE_REQUIREMENT=${JSON.stringify(signing.gatewayRequirement)}`,
    ...(signing.release
      ? [`-DAFTERNOTE_APPLICATION_CODE_REQUIREMENT=${JSON.stringify(
          signedRequirement(OWNER_CONTROL_IDENTIFIER, signing.teamId!),
        )}`,
        `-DAFTERNOTE_CLI_CODE_REQUIREMENT=${JSON.stringify(
          signedRequirement("dev.afternote.local", signing.teamId!),
        )}`]
      : []),
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    join(repositoryRoot, "apps/local/native/connector_presentation.mm"),
    join(repositoryRoot, "apps/local/native/broker_recovery_state.mm"),
    join(repositoryRoot, "apps/local/native/note_editor_state.mm"),
    join(repositoryRoot, "apps/local/native/setup_guide_state.mm"),
    join(repositoryRoot, "apps/local/native/plain_text_list_formatting.mm"),
    join(repositoryRoot, "apps/local/native/application_installation.mm"),
    join(repositoryRoot, "apps/local/native/owner_control_app.mm"),
    "-o",
    ownerControlBinaryPath,
  ]);
  chmodSync(ownerControlBinaryPath, 0o755);
  runPackagingCommand([
    "codesign",
    "--force",
    "--sign",
    signing.identity,
    ...(signing.release ? ["--options", "runtime", "--timestamp"] : []),
    "--identifier",
    OWNER_CONTROL_IDENTIFIER,
    ownerControlAppPath,
  ]);
  const ownerControlRequirement = signing.release
    ? signedRequirement(OWNER_CONTROL_IDENTIFIER, signing.teamId!)
    : exactCodeRequirement(ownerControlAppPath);
  runPackagingCommand([
    process.execPath,
    "run",
    join(repositoryRoot, "scripts/build-local-sqlcipher-addon.ts"),
  ], repositoryRoot, {
    AFTERNOTE_GATEWAY_OWNER_CONTROL_CODE_REQUIREMENT: ownerControlRequirement,
    AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS: ownerPresenceBypass ? "1" : "0",
  });
  const builtGatewayPath = join(
    repositoryRoot,
    "apps/local/native/build/afternote-vault-broker-gateway",
  );
  const gatewayRequirement = signing.release
    ? signing.gatewayRequirement
    : designatedRequirement(builtGatewayPath);
  const clientSignerRequirement = signing.release
    ? signedRequirement(CLIENT_SIGNER_IDENTIFIER, signing.teamId!)
    : `identifier "${CLIENT_SIGNER_IDENTIFIER}"`;
  const clientCompile = [
    process.execPath,
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--minify",
    `--metafile=${clientMetafilePath}`,
    `--define=AFTERNOTE_BUILD_VERSION=${JSON.stringify(version)}`,
    "--define=AFTERNOTE_STANDALONE=true",
    `--define=AFTERNOTE_RELEASE_BUILD=${process.env.AFTERNOTE_RELEASE_BUILD === "1"}`,
    `--define=AFTERNOTE_ACCEPTANCE_TRACE=${acceptanceBuild}`,
    `--define=AFTERNOTE_BROKER_CODE_REQUIREMENT=${JSON.stringify(gatewayRequirement)}`,
    `--define=AFTERNOTE_BROKER_MACH_SERVICE=${JSON.stringify(brokerMachService)}`,
    `--define=AFTERNOTE_CLIENT_SIGNER_CODE_REQUIREMENT=${JSON.stringify(clientSignerRequirement)}`,
    ...(process.env.AFTERNOTE_KEYCHAIN_ACCESS_GROUP
      ? [
          `--define=AFTERNOTE_KEYCHAIN_ACCESS_GROUP=${JSON.stringify(process.env.AFTERNOTE_KEYCHAIN_ACCESS_GROUP)}`,
        ]
      : []),
    join(
      repositoryRoot,
      "apps/local/src",
      signing.release ? "main-release.ts" : "main.ts",
    ),
    `--outfile=${binaryPath}`,
  ];
  if (includeSemanticRuntime) {
    runTextOnlyTransformersCompile(clientCompile);
  } else {
    runPackagingCommand(clientCompile);
  }
  chmodSync(binaryPath, 0o755);
  runPackagingCommand([
    "codesign",
    "--force",
    "--sign",
    signing.identity,
    ...(signing.release ? ["--options", "runtime", "--timestamp"] : []),
    "--identifier",
    "dev.afternote.local",
    ...(signing.release
      ? ["--entitlements", writeSigningEntitlements(
          outputDirectory,
          "client",
          signing,
          "dev.afternote.local",
        )]
      : []),
    binaryPath,
  ]);
  const localCliRequirement = signing.release
    ? signedRequirement("dev.afternote.local", signing.teamId!)
    : exactCodeRequirement(binaryPath);
  copyFileSync(
    join(
      repositoryRoot,
      "apps/local/native/build/afternote-vault-broker-gateway",
    ),
    brokerBinaryPath,
  );
  chmodSync(brokerBinaryPath, 0o755);
  const workerCompile = [
    process.execPath,
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--minify",
    `--metafile=${workerMetafilePath}`,
    `--define=AFTERNOTE_BUILD_VERSION=${JSON.stringify(version)}`,
    "--define=AFTERNOTE_STANDALONE=true",
    `--define=AFTERNOTE_OWNER_PRESENCE_MODE=${JSON.stringify(
      ownerPresenceBypass ? "development-bypass" : "required",
    )}`,
    `--define=AFTERNOTE_RELEASE_BUILD=${process.env.AFTERNOTE_RELEASE_BUILD === "1"}`,
    `--define=AFTERNOTE_BROKER_TESTING=${acceptanceBuild}`,
    `--define=AFTERNOTE_GATEWAY_CODE_REQUIREMENT=${JSON.stringify(gatewayRequirement)}`,
    `--define=AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE=${JSON.stringify(workerGatewayMachService)}`,
    `--define=AFTERNOTE_ACCEPTANCE_TRACE=${acceptanceBuild}`,
    ...(process.env.AFTERNOTE_KEYCHAIN_ACCESS_GROUP
      ? [
          `--define=AFTERNOTE_KEYCHAIN_ACCESS_GROUP=${JSON.stringify(process.env.AFTERNOTE_KEYCHAIN_ACCESS_GROUP)}`,
        ]
      : []),
    join(repositoryRoot, "apps/local/src", workerEntrypoint),
    `--outfile=${brokerWorkerPath}`,
  ];
  if (includeSemanticRuntime) {
    runTextOnlyTransformersCompile(workerCompile);
  } else {
    runPackagingCommand(workerCompile);
  }
  chmodSync(brokerWorkerPath, 0o755);
  const allowedSignerParents = signing.release
    ? signedRequirement("dev.afternote.local", signing.teamId!)
    : exactCodeRequirement(binaryPath);
  runPackagingCommand([
    "clang++",
    "-std=c++17",
    "-O2",
    "-fobjc-arc",
    ...(signing.release ? ["-mmacosx-version-min=13.3"] : []),
    `-DAFTERNOTE_ALLOWED_PARENT_CODE_REQUIREMENT=${JSON.stringify(allowedSignerParents)}`,
    `-DAFTERNOTE_CLIENT_KEYCHAIN_ACCESS_GROUP=${JSON.stringify(
      signing.clientAccessGroup ?? "development-unavailable",
    )}`,
    "-framework",
    "Foundation",
    "-framework",
    "Security",
    join(repositoryRoot, "apps/local/native/client_signer.mm"),
    "-o",
    clientSignerPath,
  ]);
  chmodSync(clientSignerPath, 0o755);
  runPackagingCommand([
    "codesign",
    "--force",
    "--sign",
    signing.identity,
    ...(signing.release ? ["--options", "runtime", "--timestamp"] : []),
    "--identifier",
    CLIENT_SIGNER_IDENTIFIER,
    ...(signing.release
      ? ["--entitlements", writeSigningEntitlements(
          outputDirectory,
          "client-signer",
          signing,
          CLIENT_SIGNER_IDENTIFIER,
        )]
      : []),
    clientSignerAppPath,
  ]);
  if (includeSemanticRuntime) {
    for (const [name, destination] of [
      [onnxRuntimeLibraryName, onnxRuntimeLibraryPath],
      [onnxRuntimeBindingName, onnxRuntimeBindingPath],
    ] as const) {
      copyFileSync(
        join(
          repositoryRoot,
          "node_modules/.bun/onnxruntime-node@1.21.0/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64",
          name,
        ),
        destination,
      );
      chmodSync(destination, 0o755);
    }
  }
  for (const filename of [
    sqlcipherAddonName,
    sqlcipherLibraryName,
    cryptoLibraryName,
  ]) {
    const destination = join(portableDirectory, filename);
    copyFileSync(join(repositoryRoot, "apps/local/native/build", filename), destination);
    chmodSync(destination, 0o755);
    runPackagingCommand(["codesign", "--verify", "--strict", "--verbose=4", destination]);
  }
  if (includeSemanticRuntime) {
    for (const [identifier, path] of [
      ["dev.afternote.local.onnxruntime", onnxRuntimeLibraryPath],
      ["dev.afternote.local.onnxruntime-binding", onnxRuntimeBindingPath],
    ] as const) {
      runPackagingCommand([
        "codesign",
        "--force",
        "--sign",
        signing.identity,
        ...(signing.release ? ["--options", "runtime", "--timestamp"] : []),
        "--identifier", identifier,
        path,
      ]);
    }
  }
  for (const filename of [
    sqlcipherAddonName,
    sqlcipherLibraryName,
    cryptoLibraryName,
    ...(includeSemanticRuntime ? [onnxRuntimeLibraryName] : []),
    ...(includeSemanticRuntime ? [onnxRuntimeBindingName] : []),
  ]) {
    copyFileSync(
      join(portableDirectory, filename),
      join(brokerWorkerExecutableDirectory, filename),
    );
  }
  runPackagingCommand([
    "codesign",
    "--force",
    "--sign",
    signing.identity,
    ...(signing.release ? ["--options", "runtime", "--timestamp"] : []),
    ...(signing.release
      ? ["--entitlements", writeSigningEntitlements(
          outputDirectory,
          "worker",
          signing,
          brokerWorkerIdentifier,
        )]
      : []),
    brokerWorkerAppPath,
  ]);
  if (signing.release) {
    assertReleaseArtifactHygiene({
      repositoryRoot,
      executables: [
        binaryPath,
        brokerBinaryPath,
        brokerWorkerPath,
        clientSignerPath,
        ownerControlBinaryPath,
        join(portableDirectory, sqlcipherAddonName),
        join(portableDirectory, sqlcipherLibraryName),
        join(portableDirectory, cryptoLibraryName),
        ...(includeSemanticRuntime
          ? [onnxRuntimeLibraryPath, onnxRuntimeBindingPath]
          : []),
      ],
      clientPath: binaryPath,
      workerPath: brokerWorkerPath,
    });
  }
  runPackagingCommand(["codesign", "--verify", "--verbose=4", binaryPath]);
  runPackagingCommand(["codesign", "--verify", "--verbose=4", brokerBinaryPath]);
  runPackagingCommand([
    "codesign",
    "--verify",
    "--strict",
    `-R=${gatewayRequirement}`,
    brokerBinaryPath,
  ]);
  runPackagingCommand(["codesign", "--verify", "--verbose=4", brokerWorkerPath]);
  runPackagingCommand([
    "codesign",
    "--verify",
    "--strict",
    "--verbose=4",
    brokerWorkerAppPath,
  ]);
  runPackagingCommand([
    "codesign",
    "--verify",
    "--strict",
    "--verbose=4",
    clientSignerAppPath,
  ]);
  runPackagingCommand([
    "codesign",
    "--verify",
    "--strict",
    "--verbose=4",
    ownerControlAppPath,
  ]);
  if (signing.release) {
    verifySigningTeam(binaryPath, signing.teamId!);
    verifySigningTeam(brokerBinaryPath, signing.teamId!);
    verifySigningTeam(brokerWorkerPath, signing.teamId!);
    verifySigningTeam(brokerWorkerAppPath, signing.teamId!);
    verifySigningTeam(clientSignerAppPath, signing.teamId!);
    verifySigningTeam(ownerControlAppPath, signing.teamId!);
    rmSync(join(outputDirectory, ".afternote-client-entitlements.plist"), {
      force: true,
    });
    rmSync(join(outputDirectory, ".afternote-worker-entitlements.plist"), {
      force: true,
    });
    rmSync(join(outputDirectory, ".afternote-client-signer-entitlements.plist"), {
      force: true,
    });
  }

  for (const filename of [
    "install.sh",
    "rollback.sh",
    "uninstall.sh",
    "broker-lifecycle.sh",
    "launch-agent.plist",
    "README.md",
  ]) {
    const source = join(packagingRoot, filename);
    const destination = join(portableDirectory, filename);
    const contents = renderPackagingText(
      readFileSync(source, "utf8"),
      {
        includeSemanticRuntime,
        release: signing.release,
      },
    )
      .replaceAll("__AFTERNOTE_VERSION__", version)
      .replaceAll("__AFTERNOTE_BROKER_IDENTIFIER__", brokerMachService);
    const renderedContents = contents.replaceAll(
      "__AFTERNOTE_OWNER_CONTROL_SERVICE__",
      ownerControlMachService,
    ).replaceAll(
      "__AFTERNOTE_WORKER_GATEWAY_SERVICE__",
      workerGatewayMachService,
    ).replaceAll(
      "__AFTERNOTE_RELEASE_ARTIFACT__",
      signing.release ? "1" : "0",
    ).replaceAll(
      "__AFTERNOTE_TEAM_ID__",
      signing.teamId ?? "DEVELOPMENT",
    );
    writeFileSync(destination, renderedContents, {
      mode: filename.endsWith(".sh") ? 0o755 : 0o644,
    });
  }
  const supplyChain = writeReleaseSupplyChainArtifacts({
    repositoryRoot,
    portableDirectory,
    metafilePaths,
    version,
    release: signing.release,
    semanticRuntimeIncluded: includeSemanticRuntime,
  });
  for (const metafilePath of metafilePaths) rmSync(metafilePath, { force: true });

  let payloadManifestSha256: string | null = null;
  let buildProvenanceSha256: string | null = null;
  if (signing.release) {
    const nativeInputsPath = join(repositoryRoot, "scripts/native-release-inputs.json");
    const buildProvenancePath = join(
      ownerControlAppPath,
      "Contents/Resources/AFTERNOTE_BUILD_PROVENANCE.json",
    );
    writeFileSync(buildProvenancePath, `${JSON.stringify({
      format: "afternote-signed-build-provenance",
      version: 1,
      sourceCommit,
      sourceTree,
      dependencyLockSha256,
      dependencyTreeSha256,
      buildEnvironmentSha256,
      toolchainSha256,
      toolchain,
      provisioningProfilesSha256,
      provisioningProfiles,
      nativeReleaseInputsManifestSha256: sha256(nativeInputsPath),
      nativeReleaseInputs: JSON.parse(readFileSync(nativeInputsPath, "utf8")),
    }, null, 2)}\n`, { mode: 0o644 });
    buildProvenanceSha256 = sha256(buildProvenancePath);
    embedDesktopRuntime(portableDirectory, embeddedRuntimePath, includeSemanticRuntime);
    assertEmbeddedRuntimeMatchesPortable(portableDirectory);
    const payloadManifestPath = writePayloadManifest(portableDirectory);
    payloadManifestSha256 = sha256(payloadManifestPath);
    runPackagingCommand([
      "codesign",
      "--force",
      "--sign",
      signing.identity,
      "--options",
      "runtime",
      "--timestamp",
      "--identifier",
      OWNER_CONTROL_IDENTIFIER,
      ownerControlAppPath,
    ]);
    runPackagingCommand([
      "codesign",
      "--verify",
      "--deep",
      "--strict",
      "--verbose=4",
      ownerControlAppPath,
    ]);
    verifySigningTeam(ownerControlAppPath, signing.teamId!);
    assertReleaseInputsUnchanged({
      sourceCommit,
      sourceTree,
      dependencyTreeSha256: dependencyTreeSha256!,
    });
  }

  runPackagingCommand([
    "tar",
    "-czf",
    portableArchivePath,
    "-C",
    portableDirectory,
    ".",
  ]);

  const checksumLines = [portableArchivePath].map(
    (artifactPath) =>
      `${sha256(artifactPath)}  ${artifactPath.slice(outputDirectory.length + 1)}`,
  );
  writeFileSync(checksumsPath, `${checksumLines.join("\n")}\n`, { mode: 0o644 });

  return {
    version,
    platform: "darwin-arm64",
    binaryPath,
    brokerBinaryPath,
    brokerWorkerAppPath,
    brokerWorkerPath,
    clientSignerAppPath,
    clientSignerPath,
    sqlcipherAddonPath,
    sqlcipherLibraryPath,
    cryptoLibraryPath,
    onnxRuntimeBindingPath,
    onnxRuntimePath: onnxRuntimeLibraryPath,
    ownerControlAppPath,
    embeddedRuntimePath,
    portableArchivePath,
    checksumsPath,
    sbomPath: supplyChain.sbomPath,
    noticesPath: supplyChain.noticesPath,
    portableDirectory,
    brokerMachService,
    ownerPresenceMode: ownerPresenceBypass ? "development-bypass" : "required",
    releaseFlavor: signing.release ? "public" : "development",
    semanticRuntimeIncluded: includeSemanticRuntime,
    sourceCommit,
    sourceTree,
    sourceTreeClean,
    dependencyLockSha256,
    dependencyTreeSha256,
    buildEnvironmentSha256,
    toolchainSha256,
    provisioningProfilesSha256,
    payloadManifestSha256,
    buildProvenanceSha256,
  };
}

export function desktopRuntimeEntries(includeSemanticRuntime: boolean): string[] {
  return [
    "afternote",
    "afternote-vault-broker",
    "AfternoteVaultWorker.app",
    "AfternoteClientSigner.app",
    "afternote_sqlcipher.node",
    "libsqlcipher.3.dylib",
    "libcrypto.4.dylib",
    ...(includeSemanticRuntime ? ["libonnxruntime.1.21.0.dylib"] : []),
    ...(includeSemanticRuntime ? ["onnxruntime_binding.node"] : []),
    "install.sh",
    "rollback.sh",
    "uninstall.sh",
    "broker-lifecycle.sh",
    "launch-agent.plist",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "SBOM.spdx.json",
    "LICENSES",
  ];
}

function embedDesktopRuntime(
  portableDirectory: string,
  destination: string,
  includeSemanticRuntime: boolean,
): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: false, mode: 0o755 });
  for (const entry of desktopRuntimeEntries(includeSemanticRuntime)) {
    const source = join(portableDirectory, entry);
    const target = join(destination, entry);
    const info = lstatSync(source);
    if (info.isSymbolicLink()) {
      throw new Error(`Desktop runtime refuses a symlinked payload: ${entry}`);
    }
    if (info.isDirectory()) {
      cpSync(source, target, { recursive: true, dereference: false });
    } else if (info.isFile()) {
      copyFileSync(source, target);
      chmodSync(target, info.mode & 0o777);
    } else {
      throw new Error(`Desktop runtime payload is not a regular path: ${entry}`);
    }
  }
}

function gitOutput(args: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], {
    cwd: repositoryRoot,
    env: subprocessEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Could not inspect release source revision: ${args[0]}`);
  }
  return result.stdout.toString().trim();
}

function sourceRevision(): { commit: string; tree: string; clean: boolean } {
  if (!existsSync(join(repositoryRoot, ".git"))) {
    if (process.env.AFTERNOTE_RELEASE_BUILD === "1") {
      throw new Error(
        "Release packaging requires this standalone source tree to have its own Git history",
      );
    }
    return { commit: "uncommitted-source", tree: "uncommitted-source", clean: false };
  }
  return {
    commit: gitOutput(["rev-parse", "HEAD"]),
    tree: gitOutput(["rev-parse", "HEAD^{tree}"]),
    clean: gitOutput([
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]).length === 0,
  };
}

function requiredReleaseDigest(name: string): string {
  const value = requiredReleaseEnvironment(name);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Release packaging requires a SHA-256 value in ${name}`);
  }
  return value;
}

function assertReleaseInputsUnchanged(expected: {
  sourceCommit: string;
  sourceTree: string;
  dependencyTreeSha256: string;
}): void {
  const current = sourceRevision();
  if (!current.clean || current.commit !== expected.sourceCommit || current.tree !== expected.sourceTree) {
    throw new Error("Release source changed while packaging");
  }
  if (sha256DirectoryTree(join(repositoryRoot, "node_modules")) !== expected.dependencyTreeSha256) {
    throw new Error("Installed release dependencies changed while packaging");
  }
}

export function releaseToolchainIdentity(): Record<string, string> {
  const tryCapture = (command: string[]): string | null => {
    const result = Bun.spawnSync(command, {
      cwd: repositoryRoot,
      env: releaseCommandEnvironment(process.env),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return null;
    return `${result.stdout.toString()}${result.stderr.toString()}`.trim() || null;
  };
  const capture = (command: string[]): string => {
    const value = tryCapture(command);
    if (value === null) {
      throw new Error(`Could not identify release toolchain: ${command[0]}`);
    }
    return value;
  };
  const sdkPath = capture(["/usr/bin/xcrun", "--show-sdk-path"]);
  const developerDirectory = capture(["/usr/bin/xcode-select", "-p"]);
  const developerTools = tryCapture(["/usr/bin/xcodebuild", "-version"]) ??
    tryCapture([
      "/usr/sbin/pkgutil",
      "--pkg-info=com.apple.pkg.CLTools_Executables",
    ]);
  if (developerTools === null) {
    throw new Error("Could not identify Xcode or Command Line Tools");
  }
  return {
    bunExecutableSha256: sha256(process.execPath),
    bunVersion: process.versions.bun ?? "unknown",
    clang: capture(["/usr/bin/clang++", "--version"]),
    developerDirectory,
    developerTools,
    sdkPath,
    sdkSettingsSha256: sha256(join(sdkPath, "SDKSettings.json")),
  };
}

export function releaseProvisioningProfileIdentity(): Record<string, string> {
  const profiles: Record<string, string> = {};
  for (const name of [
    "AFTERNOTE_PROVISIONING_PROFILE",
    "AFTERNOTE_CLIENT_SIGNER_PROVISIONING_PROFILE",
  ]) {
    const path = requiredReleaseEnvironment(name);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Release provisioning profile must be a regular file: ${name}`);
    }
    profiles[name] = sha256(path);
  }
  return profiles;
}

export function assertReleaseArtifactHygiene(options: {
  repositoryRoot: string;
  executables: string[];
  clientPath: string;
  workerPath: string;
}): void {
  const checkoutPath = Buffer.from(options.repositoryRoot);
  for (const path of options.executables) {
    if (readFileSync(path).includes(checkoutPath)) {
      throw new Error(`Release executable contains a checkout-specific path: ${path}`);
    }
  }
  const client = readFileSync(options.clientPath);
  if (client.includes(Buffer.from("--admin-enroll-release-key"))) {
    throw new Error("Public release client contains a removed migration command");
  }
  const worker = readFileSync(options.workerPath);
  for (const prohibited of [
    "development-vault.key",
    "getOrCreateDevelopmentVaultKey",
  ]) {
    if (worker.includes(Buffer.from(prohibited))) {
      throw new Error(`Public release worker contains prohibited material: ${prohibited}`);
    }
  }
}

export function renderPackagingText(
  contents: string,
  options: {
    includeSemanticRuntime: boolean;
    release: boolean;
  },
): string {
  let rendered = contents.replaceAll(
    "__AFTERNOTE_RELEASE_CHANNEL__",
    options.release ? "public-alpha" : "development-alpha",
  );
  if (!options.includeSemanticRuntime) {
    rendered = rendered.replace(
      /<!-- BEGIN:semantic-runtime -->[\s\S]*?<!-- END:semantic-runtime -->\n?/g,
      "",
    );
  } else {
    rendered = rendered
      .replaceAll("<!-- BEGIN:semantic-runtime -->", "")
      .replaceAll("<!-- END:semantic-runtime -->", "");
  }
  if (options.release) {
    rendered = rendered.replace(
      /<!-- BEGIN:development-key -->[\s\S]*?<!-- END:development-key -->\n?/g,
      "",
    );
  } else {
    rendered = rendered
      .replaceAll("<!-- BEGIN:development-key -->", "")
      .replaceAll("<!-- END:development-key -->", "");
  }
  return rendered;
}

export function developmentOwnerPresenceBypass(options: {
  requested?: boolean;
  configured?: string;
  releaseBuild?: string;
}): boolean {
  if (options.configured !== undefined &&
      options.configured !== "0" && options.configured !== "1") {
    throw new Error(
      "AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS must be 0 or 1",
    );
  }
  const enabled = options.requested ?? options.configured === "1";
  if (enabled && options.releaseBuild === "1") {
    throw new Error("Release packaging cannot bypass owner presence");
  }
  return enabled;
}

export function releaseWorkerEntrypoint(options: {
  releaseBuild?: string;
}): string {
  if (options.releaseBuild !== "1") return "vault-broker-worker-main.ts";
  return "vault-broker-release-worker-main.ts";
}

export function acceptanceBrokerMachService(options: {
  acceptanceBuild?: string;
  configuredService?: string;
  releaseBuild?: string;
}): string {
  const configured = options.configuredService?.trim();
  if (options.acceptanceBuild === "1" && !configured) {
    throw new Error(
      "AFTERNOTE_ACCEPTANCE_BUILD=1 requires AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE",
    );
  }
  if (!configured) return VAULT_BROKER_IDENTIFIER;
  if (options.acceptanceBuild !== "1") {
    throw new Error(
      "AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE requires AFTERNOTE_ACCEPTANCE_BUILD=1",
    );
  }
  if (options.releaseBuild === "1") {
    throw new Error("Release packaging cannot use an acceptance broker Mach service");
  }
  if (
    configured.length > 255 ||
    !/^dev\.afternote\.vault-broker\.acceptance\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(
      configured,
    )
  ) {
    throw new Error(
      "Acceptance broker Mach service must use dev.afternote.vault-broker.acceptance.<unique-suffix>",
    );
  }
  return configured;
}

function buildApplicationIcon(
  source: string,
  destination: string,
  outputDirectory: string,
): void {
  const iconset = join(outputDirectory, "Afternote.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: false });
  const renditions: Array<[string, number, string]> = [
    ["icon_16x16.png", 16, "icp4"],
    ["icon_16x16@2x.png", 32, "ic11"],
    ["icon_32x32.png", 32, "icp5"],
    ["icon_32x32@2x.png", 64, "ic12"],
    ["icon_128x128.png", 128, "ic07"],
    ["icon_128x128@2x.png", 256, "ic13"],
    ["icon_256x256.png", 256, "ic08"],
    ["icon_256x256@2x.png", 512, "ic14"],
    ["icon_512x512.png", 512, "ic09"],
    ["icon_512x512@2x.png", 1024, "ic10"],
  ];
  try {
    for (const [filename, size] of renditions) {
      runPackagingCommand([
        "/usr/bin/sips",
        "--setProperty",
        "format",
        "png",
        "--resampleHeightWidth",
        String(size),
        String(size),
        source,
        "--out",
        join(iconset, filename),
      ]);
    }
    const chunks = renditions.map(([filename, , type]) => {
      const png = readFileSync(join(iconset, filename));
      const chunk = Buffer.allocUnsafe(8 + png.length);
      chunk.write(type, 0, 4, "ascii");
      chunk.writeUInt32BE(chunk.length, 4);
      png.copy(chunk, 8);
      return chunk;
    });
    const totalLength = 8 + chunks.reduce((total, chunk) => total + chunk.length, 0);
    const header = Buffer.allocUnsafe(8);
    header.write("icns", 0, 4, "ascii");
    header.writeUInt32BE(totalLength, 4);
    writeFileSync(destination, Buffer.concat([header, ...chunks], totalLength), {
      mode: 0o644,
    });
  } finally {
    rmSync(iconset, { recursive: true, force: true });
  }
}

function runPackagingCommand(
  command: string[],
  cwd = repositoryRoot,
  environment: Record<string, string> = {},
): void {
  const resolvedCommand = resolveHostTool(command);
  const result = Bun.spawnSync(resolvedCommand, {
    cwd,
    env: subprocessEnvironment(environment),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${resolvedCommand.join(" ")}): ${result.stderr.toString()}`,
    );
  }
}

function subprocessEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return process.env.AFTERNOTE_RELEASE_BUILD === "1"
    ? releaseCommandEnvironment(process.env, overrides)
    : { ...process.env, ...overrides } as Record<string, string>;
}

const HOST_TOOLS: Readonly<Record<string, string>> = {
  "clang++": "/usr/bin/clang++",
  codesign: "/usr/bin/codesign",
  git: "/usr/bin/git",
  tar: "/usr/bin/tar",
};

function resolveHostTool(command: string[]): string[] {
  const [tool, ...args] = command;
  if (!tool) throw new Error("Release command is empty");
  if (tool.startsWith("/")) return command;
  const resolved = HOST_TOOLS[tool];
  if (!resolved) throw new Error(`Release tool is not pinned to an absolute path: ${tool}`);
  return [resolved, ...args];
}

export function runTextOnlyTransformersCompile(command: string[]): void {
  const transformersPath = Bun.resolveSync(
    "@huggingface/transformers",
    join(repositoryRoot, "apps/local"),
  );
  const onnxBindingModulePath = join(
    dirname(Bun.resolveSync("onnxruntime-node", dirname(transformersPath))),
    "binding.js",
  );
  const original = readFileSync(transformersPath, "utf8");
  const originalOnnxBindingModule = readFileSync(onnxBindingModulePath, "utf8");
  const sharpImport = 'import * as __WEBPACK_EXTERNAL_MODULE_sharp__ from "sharp";';
  if (!original.includes(sharpImport)) {
    throw new Error("Pinned Transformers.js Sharp import changed; review the text-only build shim");
  }
  let textOnly = original.replace(
    sharpImport,
    "const __WEBPACK_EXTERNAL_MODULE_sharp__ = { default: () => { throw new Error(\"Image processing is unavailable in Afternote Local search\"); } };",
  );
  const absoluteModuleDirectory = /let dirname__ = '\.\/';[\s\S]*?\n}\n\n\/\/ Only used for environments with access to file system/;
  if (!absoluteModuleDirectory.test(textOnly)) {
    throw new Error(
      "Pinned Transformers.js module-directory initialization changed; review the release path scrub",
    );
  }
  textOnly = textOnly.replace(
    absoluteModuleDirectory,
    'let dirname__ = ".";\n\n// Only used for environments with access to file system',
  );
  const bundledNativeBinding =
    'require(`../bin/napi-v3/${process.platform}/${process.arch}/onnxruntime_binding.node`);';
  if (!originalOnnxBindingModule.includes(bundledNativeBinding)) {
    throw new Error(
      "Pinned ONNX Runtime binding loader changed; review the external native binding shim",
    );
  }
  const externalOnnxBindingModule = originalOnnxBindingModule.replace(
    bundledNativeBinding,
    'require(require("node:path").join(require("node:path").dirname(process.execPath), "onnxruntime_binding.node"));',
  );
  writeFileSync(transformersPath, textOnly);
  writeFileSync(onnxBindingModulePath, externalOnnxBindingModule);
  try {
    runPackagingCommand(command);
  } finally {
    writeFileSync(onnxBindingModulePath, originalOnnxBindingModule);
    writeFileSync(transformersPath, original);
  }
}

function isPackageVersion(value: string): boolean {
  return (
    value.length <= 128 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      value,
    )
  );
}

function sha256(path: string): string {
  const hash = createHash("sha256");
  const file = readFileSync(path);
  hash.update(file);
  return hash.digest("hex");
}

if (import.meta.main) {
  const artifacts = await buildLocalAlpha();
  const reportPath = join(dirname(artifacts.checksumsPath), "artifact-report.json");
  const report = {
    ...artifacts,
    binaryBytes: Bun.file(artifacts.binaryPath).size,
    userInstalledRuntimeDependencies: [],
    signing: process.env.AFTERNOTE_RELEASE_BUILD === "1"
      ? "Developer ID hardened-runtime signature; notarization remains a separate release gate"
      : "ad-hoc development signature; Developer ID signing and notarization remain release gates",
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o644,
  });
  console.log(JSON.stringify(report, null, 2));
}

type SigningConfiguration = {
  release: boolean;
  identity: string;
  teamId?: string;
  accessGroup?: string;
  clientAccessGroup?: string;
  gatewayRequirement: string;
};

function signingConfiguration(): SigningConfiguration {
  if (process.env.AFTERNOTE_RELEASE_BUILD !== "1") {
    return {
      release: false,
      identity: "-",
      gatewayRequirement: `identifier "${VAULT_BROKER_IDENTIFIER}"`,
    };
  }
  const identity = requiredReleaseEnvironment("AFTERNOTE_SIGNING_IDENTITY");
  const teamId = requiredReleaseEnvironment("AFTERNOTE_TEAM_ID");
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("AFTERNOTE_TEAM_ID must be a ten-character Apple Team ID");
  }
  const accessGroup = requiredReleaseEnvironment("AFTERNOTE_KEYCHAIN_ACCESS_GROUP");
  if (
    !accessGroup.startsWith(`${teamId}.`) ||
    !/^[A-Z0-9][A-Za-z0-9.-]{1,254}$/.test(accessGroup)
  ) {
    throw new Error("AFTERNOTE_KEYCHAIN_ACCESS_GROUP must belong to AFTERNOTE_TEAM_ID");
  }
  return {
    release: true,
    identity,
    teamId,
    accessGroup,
    clientAccessGroup: clientSignerAccessGroup(teamId),
    gatewayRequirement: signedRequirement(VAULT_BROKER_IDENTIFIER, teamId),
  };
}

function requiredReleaseEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value === "-") throw new Error(`Release packaging requires ${name}`);
  return value;
}

function readProvisioningProfile(
  profilePath: string,
  outputDirectory: string,
): unknown {
  if (!existsSync(profilePath)) {
    throw new Error(`Release provisioning profile does not exist: ${profilePath}`);
  }
  const profileInfo = lstatSync(profilePath);
  if (!profileInfo.isFile() || profileInfo.isSymbolicLink()) {
    throw new Error("Release provisioning profile must be a regular file");
  }
  const decodedPath = join(outputDirectory, ".afternote-provisioning-profile.plist");
  rmSync(decodedPath, { force: true });
  try {
    const decode = Bun.spawnSync([
      "/usr/bin/openssl",
      "smime",
      "-inform",
      "der",
      "-verify",
      "-noverify",
      "-in",
      profilePath,
      "-out",
      decodedPath,
    ], {
      cwd: repositoryRoot,
      env: subprocessEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (decode.exitCode !== 0) {
      throw new Error("Release provisioning profile could not be decoded");
    }
    const teamId = readPlistBuddyValue(decodedPath, ":TeamIdentifier:0");
    const expirationDate = readPlistBuddyValue(decodedPath, ":ExpirationDate");
    const applicationIdentifier = readPlistBuddyValue(
      decodedPath,
      ":Entitlements:com.apple.application-identifier",
    );
    const accessGroups = readPlistBuddyArray(
      decodedPath,
      ":Entitlements:keychain-access-groups",
    );
    const getTaskAllow = readPlistBuddyValue(
      decodedPath,
      ":Entitlements:get-task-allow",
      false,
    );
    const provisionsAllDevices = readPlistBuddyValue(
      decodedPath,
      ":ProvisionsAllDevices",
      false,
    );
    const provisionedDevices = readPlistBuddyValue(
      decodedPath,
      ":ProvisionedDevices",
      false,
    );
    const platforms = readPlistBuddyArray(decodedPath, ":Platform");
    const certificateBase64 = readPlutilData(
      decodedPath,
      "DeveloperCertificates.0",
    );
    const certificatePath = join(
      outputDirectory,
      ".afternote-provisioning-certificate.der",
    );
    const certificate = Buffer.from(certificateBase64!, "base64");
    if (
      certificate.byteLength === 0 ||
      certificate.toString("base64") !== certificateBase64
    ) {
      throw new Error("Release provisioning profile has an invalid signing certificate");
    }
    writeFileSync(certificatePath, certificate, { mode: 0o600 });
    const certificateDetails = Bun.spawnSync([
      "/usr/bin/openssl",
      "x509",
      "-inform",
      "der",
      "-in",
      certificatePath,
      "-noout",
      "-subject",
      "-text",
    ], {
      cwd: repositoryRoot,
      env: subprocessEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(certificatePath, { force: true });
    if (certificateDetails.exitCode !== 0) {
      throw new Error("Release provisioning profile has an invalid signing certificate");
    }
    const certificateText = certificateDetails.stdout.toString();
    return {
      TeamIdentifier: [teamId],
      ExpirationDate: expirationDate,
      Platform: platforms,
      ProvisionsAllDevices: provisionsAllDevices === "true",
      ...(provisionedDevices === undefined ? {} : { ProvisionedDevices: true }),
      DeveloperCertificateType:
        certificateText.includes("CN=Developer ID Application:") &&
          certificateText.includes("1.2.840.113635.100.6.1.13")
          ? "developer-id-application"
          : "other",
      Entitlements: {
        "com.apple.application-identifier": applicationIdentifier,
        "keychain-access-groups": accessGroups,
        ...(getTaskAllow === undefined
          ? {}
          : { "get-task-allow": getTaskAllow === "true" }),
      },
    };
  } finally {
    rmSync(decodedPath, { force: true });
  }
}

function readPlistBuddyValue(
  path: string,
  key: string,
  required = true,
): string | undefined {
  const result = Bun.spawnSync([
    "/usr/libexec/PlistBuddy",
    "-c",
    `Print ${key}`,
    path,
  ], {
    cwd: repositoryRoot,
    env: subprocessEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    if (!required) return undefined;
    throw new Error(`Release provisioning profile is missing ${key}`);
  }
  const value = result.stdout.toString().trim();
  if (!value && required) {
    throw new Error(`Release provisioning profile is missing ${key}`);
  }
  return value || undefined;
}

function readPlistBuddyArray(path: string, key: string): string[] {
  const value = readPlistBuddyValue(path, key);
  const lines = value?.split("\n").map((line) => line.trim()) ?? [];
  if (lines[0] !== "Array {" || lines.at(-1) !== "}") {
    throw new Error(`Release provisioning profile has invalid ${key}`);
  }
  return lines.slice(1, -1).filter(Boolean);
}

function readPlutilData(path: string, keyPath: string): string {
  const result = Bun.spawnSync([
    "/usr/bin/plutil",
    "-extract",
    keyPath,
    "raw",
    "-o",
    "-",
    path,
  ], {
    cwd: repositoryRoot,
    env: subprocessEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const value = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !value) {
    throw new Error(`Release provisioning profile is missing ${keyPath}`);
  }
  return value;
}

export function assertReleaseProvisioningProfile(
  profile: unknown,
  options: {
    teamId: string;
    identifier: string;
    accessGroup: string;
    now?: Date;
  },
): void {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Release provisioning profile payload is invalid");
  }
  const value = profile as Record<string, unknown>;
  const teams = value.TeamIdentifier;
  if (!Array.isArray(teams) || !teams.includes(options.teamId)) {
    throw new Error("Release provisioning profile does not belong to AFTERNOTE_TEAM_ID");
  }
  if (
    value.ProvisionsAllDevices !== true ||
    "ProvisionedDevices" in value ||
    !Array.isArray(value.Platform) ||
    !value.Platform.includes("OSX") ||
    value.DeveloperCertificateType !== "developer-id-application"
  ) {
    throw new Error(
      "Release provisioning profile is not a Developer ID Application distribution profile",
    );
  }
  const expiration = typeof value.ExpirationDate === "string"
    ? new Date(value.ExpirationDate)
    : undefined;
  if (!expiration || Number.isNaN(expiration.getTime()) ||
      expiration.getTime() <= (options.now ?? new Date()).getTime()) {
    throw new Error("Release provisioning profile is expired or has no valid expiration");
  }
  const entitlements = value.Entitlements;
  if (!entitlements || typeof entitlements !== "object" ||
      Array.isArray(entitlements)) {
    throw new Error("Release provisioning profile has no entitlements");
  }
  const entitlementMap = entitlements as Record<string, unknown>;
  const expectedApplicationIdentifier =
    `${options.teamId}.${options.identifier}`;
  if (
    entitlementMap["com.apple.application-identifier"] !==
      expectedApplicationIdentifier
  ) {
    throw new Error("Release provisioning profile does not authorize the expected App ID");
  }
  if (entitlementMap["get-task-allow"] === true) {
    throw new Error("Release provisioning profile enables development debugging");
  }
  const accessGroups = entitlementMap["keychain-access-groups"];
  if (!Array.isArray(accessGroups) || !accessGroups.some((candidate) =>
    typeof candidate === "string" && provisioningPatternAllows(
      candidate,
      options.accessGroup,
    )
  )) {
    throw new Error(
      `Release provisioning profile does not authorize ${options.accessGroup}`,
    );
  }
}

function provisioningPatternAllows(pattern: string, value: string): boolean {
  if (!pattern.endsWith("*")) return pattern === value;
  return value.startsWith(pattern.slice(0, -1));
}

export function signedRequirement(identifier: string, teamId: string): string {
  return `anchor apple generic and identifier "${identifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${teamId}"`;
}

export function resolvedPeerRequirement(options: {
  name: string;
  override: string | undefined;
  expected: string;
  release: boolean;
}): string {
  const override = options.override?.trim();
  if (options.override !== undefined && !override) {
    throw new Error(`${options.name} cannot be empty`);
  }
  if (options.release && override !== undefined && override !== options.expected) {
    throw new Error(`${options.name} cannot weaken the release code requirement`);
  }
  return override ?? options.expected;
}

function writeSigningEntitlements(
  outputDirectory: string,
  kind: "client" | "worker" | "client-signer",
  signing: SigningConfiguration,
  identifier: string,
): string {
  const path = join(outputDirectory, `.afternote-${kind}-entitlements.plist`);
  writeFileSync(path, releaseEntitlements(kind, {
    teamId: signing.teamId!,
    accessGroup: kind === "client-signer"
      ? signing.clientAccessGroup!
      : signing.accessGroup!,
    identifier,
  }), { mode: 0o600 });
  return path;
}

export function releaseEntitlements(
  kind: "client" | "worker" | "client-signer",
  options: { teamId: string; accessGroup: string; identifier: string },
): string {
  const keychainGroups = kind === "worker" || kind === "client-signer"
    ? `\n<key>keychain-access-groups</key><array><string>${options.accessGroup}</string></array>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>${options.teamId}.${options.identifier}</string>${keychainGroups}
</dict></plist>
`;
}

function verifySigningTeam(path: string, teamId: string): void {
  const result = Bun.spawnSync(["/usr/bin/codesign", "-d", "--verbose=4", path], {
    cwd: repositoryRoot,
    env: subprocessEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || !result.stderr.toString().includes(`TeamIdentifier=${teamId}`)) {
    throw new Error(`Signed artifact does not belong to AFTERNOTE_TEAM_ID: ${path}`);
  }
}

function designatedRequirement(path: string): string {
  const result = Bun.spawnSync(["/usr/bin/codesign", "-d", "-r-", path], {
    cwd: repositoryRoot,
    env: subprocessEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const requirement = `${result.stdout.toString()}\n${result.stderr.toString()}`
    .match(/(?:# )?designated => (.+)/)?.[1]
    ?.trim();
  if (result.exitCode !== 0 || !requirement) {
    throw new Error("Could not derive the development gateway code requirement");
  }
  return requirement;
}

export function exactCodeRequirement(path: string): string {
  const designated = designatedRequirement(path);
  if (/\bcdhash H"[a-f0-9]{40,64}"/i.test(designated)) return designated;
  const result = Bun.spawnSync(["/usr/bin/codesign", "-d", "--verbose=4", path], {
    cwd: repositoryRoot,
    env: subprocessEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const cdHash = `${result.stdout.toString()}\n${result.stderr.toString()}`
    .match(/(?:^|\n)CDHash=([a-f0-9]{40,64})(?:\n|$)/i)?.[1]
    ?.toLowerCase();
  if (result.exitCode !== 0 || !cdHash) {
    throw new Error("Could not derive the exact development code requirement");
  }
  return `${designated} and cdhash H"${cdHash}"`;
}
