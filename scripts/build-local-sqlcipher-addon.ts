import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  acceptanceBrokerMachService,
  developmentOwnerPresenceBypass as resolveDevelopmentOwnerPresenceBypass,
  resolvedPeerRequirement,
  signedRequirement,
} from "./release-policy";
import { releaseCommandEnvironment } from "./release-environment";

const repositoryRoot = resolve(process.cwd());
if (process.versions.bun !== "1.3.14") {
  throw new Error(`Afternote native builds require Bun 1.3.14; found ${process.versions.bun ?? "unknown"}`);
}
const releaseBuild = process.env.AFTERNOTE_RELEASE_BUILD === "1";
const outputRoot = join(repositoryRoot, "apps/local/native/build");
const addonPath = join(outputRoot, "afternote_sqlcipher.node");
const gatewayPath = join(outputRoot, "afternote-vault-broker-gateway");
const testGatewayPath = join(outputRoot, "afternote-vault-broker-gateway-test");
const sqlcipherPath = join(outputRoot, "libsqlcipher.3.dylib");
const cryptoPath = join(outputRoot, "libcrypto.4.dylib");
const releaseDependenciesRoot = join(repositoryRoot, "apps/local/native/release-deps");
const sqlcipherSource = join(releaseDependenciesRoot, "libsqlcipher.3.dylib");
const cryptoSource = join(releaseDependenciesRoot, "libcrypto.4.dylib");
const sqlcipherInclude = join(releaseDependenciesRoot, "include");
const acceptanceBuild = process.env.AFTERNOTE_ACCEPTANCE_BUILD === "1";
const developmentOwnerPresenceBypass = resolveDevelopmentOwnerPresenceBypass({
  configured: process.env.AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS,
  releaseBuild: process.env.AFTERNOTE_RELEASE_BUILD,
});
acceptanceBrokerMachService({
  acceptanceBuild: process.env.AFTERNOTE_ACCEPTANCE_BUILD,
  configuredService: process.env.AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE,
  releaseBuild: process.env.AFTERNOTE_RELEASE_BUILD,
});
const signingIdentity = releaseBuild
  ? requiredEnvironment("AFTERNOTE_SIGNING_IDENTITY")
  : "-";
const teamId = releaseBuild ? requiredTeamId() : undefined;
const expectedClientRequirement = teamId
  ? signedRequirement("dev.afternote.local", teamId)
  : 'identifier "dev.afternote.local"';
const expectedWorkerRequirement = teamId
  ? signedRequirement("dev.afternote.vault-broker.worker", teamId)
  : 'identifier "dev.afternote.vault-broker.worker"';
const expectedOwnerControlRequirement = teamId
  ? signedRequirement("dev.afternote.owner-control", teamId)
  : 'identifier "dev.afternote.owner-control"';
const clientRequirement = resolvedPeerRequirement({
  name: "AFTERNOTE_GATEWAY_CLIENT_CODE_REQUIREMENT",
  override: process.env.AFTERNOTE_GATEWAY_CLIENT_CODE_REQUIREMENT,
  expected: expectedClientRequirement,
  release: releaseBuild,
});
const workerRequirement = resolvedPeerRequirement({
  name: "AFTERNOTE_GATEWAY_WORKER_CODE_REQUIREMENT",
  override: process.env.AFTERNOTE_GATEWAY_WORKER_CODE_REQUIREMENT,
  expected: expectedWorkerRequirement,
  release: releaseBuild,
});
const ownerControlRequirement = resolvedPeerRequirement({
  name: "AFTERNOTE_GATEWAY_OWNER_CONTROL_CODE_REQUIREMENT",
  override: process.env.AFTERNOTE_GATEWAY_OWNER_CONTROL_CODE_REQUIREMENT,
  expected: expectedOwnerControlRequirement,
  release: releaseBuild,
});
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The SQLCipher addon build currently requires macOS arm64");
}
assertPreparedNativeDependencies();
if (releaseBuild) assertPinnedReleaseToolchainInputs();

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
run([
  "clang++",
  "-std=c++17",
  "-O2",
  "-mcpu=apple-m1",
  "-fPIC",
  "-fblocks",
  "-mmacosx-version-min=13.3",
  ...(releaseBuild ? ["-DAFTERNOTE_RELEASE_BUILD=1"] : []),
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-I/opt/homebrew/opt/node/include/node",
  `-I${sqlcipherInclude}`,
  sqlcipherSource,
  "-framework",
  "Security",
  "-framework",
  "CoreFoundation",
  join(repositoryRoot, "apps/local/native/sqlcipher_addon.cc"),
  "-o",
  addonPath,
]);
for (const [path, testing] of [[gatewayPath, false], [testGatewayPath, true]] as const) {
  run([
    "clang++",
    "-std=c++17",
    "-O2",
    "-fobjc-arc",
    "-fblocks",
    "-mmacosx-version-min=13.3",
    ...(testing ? ["-DAFTERNOTE_GATEWAY_TESTING=1"] : []),
    ...(!testing && acceptanceBuild ? ["-DAFTERNOTE_ACCEPTANCE_TRACE=1"] : []),
    ...(!testing && !releaseBuild ? ["-DAFTERNOTE_DEVELOPMENT_BUILD=1"] : []),
    ...(!testing && releaseBuild ? ["-DAFTERNOTE_RELEASE_BUILD=1"] : []),
    ...(!testing && developmentOwnerPresenceBypass
      ? ["-DAFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS=1"]
      : []),
    ...(!testing
      ? [
          cStringMacro("AFTERNOTE_CLIENT_CODE_REQUIREMENT", clientRequirement),
          cStringMacro(
            "AFTERNOTE_OWNER_CONTROL_CODE_REQUIREMENT",
            ownerControlRequirement,
          ),
          cStringMacro("AFTERNOTE_WORKER_CODE_REQUIREMENT", workerRequirement),
        ]
      : []),
    "-framework",
    "AppKit",
    "-framework",
    "Foundation",
    "-framework",
    "LocalAuthentication",
    "-framework",
    "Security",
    join(repositoryRoot, "apps/local/native/vault_broker_gateway.mm"),
    "-o",
    path,
  ]);
}
copyFileSync(sqlcipherSource, sqlcipherPath);
copyFileSync(cryptoSource, cryptoPath);
for (const path of [
  addonPath,
  gatewayPath,
  testGatewayPath,
  sqlcipherPath,
  cryptoPath,
]) chmodSync(path, 0o755);

run(["install_name_tool", "-id", "@loader_path/libcrypto.4.dylib", cryptoPath]);
run(["install_name_tool", "-id", "@loader_path/libsqlcipher.3.dylib", sqlcipherPath]);
assertDeploymentTarget(cryptoPath);
assertDeploymentTarget(sqlcipherPath);
for (const [identifier, path] of [
  ["dev.afternote.sqlcipher.crypto", cryptoPath],
  ["dev.afternote.sqlcipher.library", sqlcipherPath],
  ["dev.afternote.sqlcipher.addon", addonPath],
  ["dev.afternote.vault-broker", gatewayPath],
  ["dev.afternote.vault-broker.test", testGatewayPath],
] as const) {
  run([
    "codesign",
    "--force",
    "--sign",
    signingIdentity,
    ...(releaseBuild ? ["--options", "runtime", "--timestamp"] : []),
    "--identifier",
    identifier,
    path,
  ]);
  run(["codesign", "--verify", "--strict", "--verbose=4", path]);
}
assertSqlcipherRuntimeCapabilities();

function cStringMacro(name: string, value: string): string {
  return `-D${name}=${JSON.stringify(value)}`;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || value === "-") {
    throw new Error(`Release native build requires ${name}`);
  }
  return value;
}

function requiredTeamId(): string {
  const value = requiredEnvironment("AFTERNOTE_TEAM_ID");
  if (!/^[A-Z0-9]{10}$/.test(value)) {
    throw new Error("AFTERNOTE_TEAM_ID must be a ten-character Apple Team ID");
  }
  return value;
}

function assertPreparedNativeDependencies(): void {
  const manifest = JSON.parse(readFileSync(
    join(repositoryRoot, "scripts/native-release-inputs.json"),
    "utf8",
  )) as Record<string, unknown>;
  const expectations: Array<[string, string]> = [
    [sqlcipherSource, requiredDigest(manifest.sqlcipherLibrarySha256, "SQLCipher library")],
    [cryptoSource, requiredDigest(manifest.opensslLibrarySha256, "OpenSSL library")],
    [
      join(releaseDependenciesRoot, "include/sqlite3.h"),
      requiredDigest(manifest.sqlcipherHeaderSha256, "SQLCipher header"),
    ],
  ];
  for (const [path, expected] of expectations) {
    if (sha256File(path) !== expected) {
      throw new Error(`Native release input changed without review: ${path}`);
    }
  }
  const buildManifest = JSON.parse(readFileSync(
    join(releaseDependenciesRoot, "BUILD_MANIFEST.json"),
    "utf8",
  )) as Record<string, unknown>;
  for (const key of [
    "minimumMacosVersion",
    "opensslLibrarySha256",
    "sqlcipherLibrarySha256",
    "sqlcipherHeaderSha256",
  ] as const) {
    if (buildManifest[key] !== manifest[key]) {
      throw new Error(`Prepared native dependency manifest disagrees with reviewed input: ${key}`);
    }
  }
  if (
    buildManifest.opensslSourceSha256 !== (manifest.opensslSource as Record<string, unknown>)?.sha256 ||
    buildManifest.sqlcipherSourceSha256 !== (manifest.sqlcipherSource as Record<string, unknown>)?.sha256
  ) {
    throw new Error("Prepared native dependency sources disagree with reviewed inputs");
  }
}

function assertPinnedReleaseToolchainInputs(): void {
  const manifest = JSON.parse(readFileSync(
    join(repositoryRoot, "scripts/native-release-inputs.json"),
    "utf8",
  )) as Record<string, unknown>;
  const expectations: Array<[string, string]> = [
    [process.execPath, requiredDigest(manifest.bunExecutableSha256, "Bun executable")],
    [
      join(
        repositoryRoot,
        "node_modules/.bun/onnxruntime-node@1.21.0/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/libonnxruntime.1.21.0.dylib",
      ),
      requiredDigest(manifest.onnxRuntimeLibrarySha256, "ONNX Runtime library"),
    ],
    [
      join(
        repositoryRoot,
        "node_modules/.bun/onnxruntime-node@1.21.0/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node",
      ),
      requiredDigest(manifest.onnxRuntimeBindingSha256, "ONNX Runtime binding"),
    ],
  ];
  for (const [path, expected] of expectations) {
    if (sha256File(path) !== expected) {
      throw new Error(`Native release input changed without review: ${path}`);
    }
  }
  const nodeHeaders = "/opt/homebrew/opt/node/include/node";
  if (sha256Directory(nodeHeaders) !==
    requiredDigest(manifest.nodeHeadersSha256, "Node headers")) {
    throw new Error(`Native release headers changed without review: ${nodeHeaders}`);
  }
}

function assertDeploymentTarget(path: string): void {
  const output = run(["vtool", "-show-build", path]);
  const versions = [...output.matchAll(/\bminos\s+(\d+\.\d+)/g)]
    .map((match) => match[1]);
  if (versions.length === 0 || versions.some((version) => version !== "13.3")) {
    throw new Error(`Native dependency has an unexpected macOS deployment target: ${path}`);
  }
}

function requiredDigest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Pinned ${name} digest is invalid`);
  }
  return value;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Directory(path: string): string {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const child = join(directory, name);
      const info = lstatSync(child);
      if (info.isSymbolicLink()) throw new Error(`Native release input contains a symlink: ${child}`);
      if (info.isDirectory()) visit(child);
      else if (info.isFile()) files.push(child);
      else throw new Error(`Native release input is not regular: ${child}`);
    }
  };
  visit(path);
  const inventory = files.sort().map(
    (file) => `${sha256File(file)}  ${file}\n`,
  ).join("");
  return createHash("sha256").update(inventory).digest("hex");
}

function assertSqlcipherRuntimeCapabilities(): void {
  const addon = createRequire(import.meta.url)(addonPath) as {
    open(path: string, key: Uint8Array, readonly: boolean): object;
    exec(database: object, sql: string): void;
    close(database: object): void;
  };
  const directory = mkdtempSync(join(tmpdir(), "afternote-native-smoke-"));
  const databasePath = join(directory, "encrypted.db");
  let database: object | undefined;
  try {
    database = addon.open(databasePath, new Uint8Array(32).fill(0x5a), false);
    addon.exec(database, "CREATE VIRTUAL TABLE release_fts USING fts5(content)");
    addon.exec(database, "INSERT INTO release_fts(content) VALUES ('afternote-native-canary')");
    addon.close(database);
    database = undefined;
    const bytes = readFileSync(databasePath);
    if (
      bytes.includes(Buffer.from("SQLite format 3")) ||
      bytes.includes(Buffer.from("afternote-native-canary"))
    ) {
      throw new Error("Native SQLCipher smoke database contains plaintext");
    }
  } finally {
    if (database) addon.close(database);
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      addonPath,
      gatewayPath,
      testGatewayPath,
      sqlcipherPath,
      cryptoPath,
    },
    null,
    2,
  ),
);

function run(command: string[]): string {
  const [tool, ...args] = command;
  if (!tool) throw new Error("Native build command is empty");
  const tools: Readonly<Record<string, string>> = {
    "clang++": "/usr/bin/clang++",
    codesign: "/usr/bin/codesign",
    install_name_tool: "/usr/bin/install_name_tool",
    vtool: "/usr/bin/vtool",
  };
  const resolvedTool = tool.startsWith("/") ? tool : tools[tool];
  if (!resolvedTool) throw new Error(`Native build tool is not pinned: ${tool}`);
  const resolvedCommand = [resolvedTool, ...args];
  const result = Bun.spawnSync(resolvedCommand, {
    cwd: repositoryRoot,
    env: releaseBuild
      ? releaseCommandEnvironment(process.env)
      : process.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${resolvedCommand.join(" ")}): ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}
