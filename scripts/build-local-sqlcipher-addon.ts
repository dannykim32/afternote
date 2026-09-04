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
  resolvedPeerRequirement,
  signedRequirement,
} from "./build-local-alpha";

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
const sqlcipherSource = releaseBuild
  ? join(releaseDependenciesRoot, "libsqlcipher.3.dylib")
  : "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib";
const cryptoSource = releaseBuild
  ? join(releaseDependenciesRoot, "libcrypto.4.dylib")
  : "/opt/homebrew/opt/openssl@4/lib/libcrypto.4.dylib";
const sqlcipherInclude = releaseBuild
  ? join(releaseDependenciesRoot, "include")
  : "/opt/homebrew/opt/sqlcipher/include/sqlcipher";
const acceptanceBuild = process.env.AFTERNOTE_ACCEPTANCE_BUILD === "1";
const developmentOwnerPresenceBypass =
  process.env.AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS === "1";
if (developmentOwnerPresenceBypass && releaseBuild) {
  throw new Error("Release native build cannot bypass owner presence");
}
if (acceptanceBuild && releaseBuild) {
  throw new Error("Release native build cannot enable acceptance tracing");
}
if (
  acceptanceBuild &&
  !/^dev\.afternote\.vault-broker\.acceptance\.[A-Za-z0-9][A-Za-z0-9.-]*$/.test(
    process.env.AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE ?? "",
  )
) {
  throw new Error(
    "Acceptance native build requires a namespaced AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE",
  );
}
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
if (releaseBuild) assertPinnedNativeReleaseInputs();

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
run([
  "clang++",
  "-std=c++17",
  "-O2",
  "-fPIC",
  "-fblocks",
  ...(releaseBuild ? ["-mmacosx-version-min=13.3"] : []),
  ...(releaseBuild ? ["-DAFTERNOTE_RELEASE_BUILD=1"] : []),
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-I/opt/homebrew/opt/node/include/node",
  `-I${sqlcipherInclude}`,
  ...(releaseBuild
    ? [sqlcipherSource]
    : ["-L/opt/homebrew/opt/sqlcipher/lib", "-lsqlcipher"]),
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
    ...(releaseBuild ? ["-mmacosx-version-min=13.3"] : []),
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
if (releaseBuild) {
  run(["install_name_tool", "-id", "@loader_path/libsqlcipher.3.dylib", sqlcipherPath]);
} else {
  run([
    "install_name_tool",
    "-id",
    "@loader_path/libsqlcipher.3.dylib",
    "-change",
    cryptoSource,
    "@loader_path/libcrypto.4.dylib",
    sqlcipherPath,
  ]);
  run([
    "install_name_tool",
    "-change",
    "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib",
    "@loader_path/libsqlcipher.3.dylib",
    addonPath,
  ]);
}
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

function assertPinnedNativeReleaseInputs(): void {
  const manifest = JSON.parse(readFileSync(
    join(repositoryRoot, "scripts/native-release-inputs.json"),
    "utf8",
  )) as Record<string, unknown>;
  const expectations: Array<[string, string]> = [
    [process.execPath, requiredDigest(manifest.bunExecutableSha256, "Bun executable")],
    [sqlcipherSource, requiredDigest(manifest.sqlcipherLibrarySha256, "SQLCipher library")],
    [cryptoSource, requiredDigest(manifest.opensslLibrarySha256, "OpenSSL library")],
    [
      join(releaseDependenciesRoot, "include/sqlite3.h"),
      requiredDigest(manifest.sqlcipherHeaderSha256, "SQLCipher header"),
    ],
    [
      join(
        repositoryRoot,
        "node_modules/.bun/onnxruntime-node@1.21.0/node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/libonnxruntime.1.21.0.dylib",
      ),
      requiredDigest(manifest.onnxRuntimeLibrarySha256, "ONNX Runtime library"),
    ],
  ];
  for (const [path, expected] of expectations) {
    if (sha256File(path) !== expected) {
      throw new Error(`Native release input changed without review: ${path}`);
    }
  }
  const headerExpectations: Array<[string, string]> = [[
    "/opt/homebrew/opt/node/include/node",
    requiredDigest(manifest.nodeHeadersSha256, "Node headers"),
  ]];
  for (const [path, expected] of headerExpectations) {
    if (sha256Directory(path) !== expected) {
      throw new Error(`Native release headers changed without review: ${path}`);
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

function run(command: string[]): void {
  const [tool, ...args] = command;
  if (!tool) throw new Error("Native build command is empty");
  const tools: Readonly<Record<string, string>> = {
    "clang++": "/usr/bin/clang++",
    codesign: "/usr/bin/codesign",
    install_name_tool: "/usr/bin/install_name_tool",
  };
  const resolvedTool = tool.startsWith("/") ? tool : tools[tool];
  if (!resolvedTool) throw new Error(`Native build tool is not pinned: ${tool}`);
  const resolvedCommand = [resolvedTool, ...args];
  const result = Bun.spawnSync(resolvedCommand, {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (${resolvedCommand.join(" ")}): ${result.stderr.toString()}`);
  }
}
