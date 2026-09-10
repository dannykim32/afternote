import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { releaseCommandEnvironment } from "./release-environment";
import { sha256DirectoryTree } from "./release-inputs";

const repositoryRoot = resolve(process.cwd());
const configurationPath = join(repositoryRoot, "scripts/native-release-inputs.json");
const outputRoot = join(repositoryRoot, "apps/local/native/release-deps");
const minimumMacosVersion = "13.3";
// OpenSSL records its build time in libcrypto. A fixed epoch makes clean builds
// byte-for-byte reproducible instead of pinning a one-off timestamp.
const sourceDateEpoch = "0";

type SourceInput = { version: string; url: string; sha256: string; maximumBytes: number };
type NativeToolchain = {
  commandLineToolsVersion: string;
  macosSdkVersion: string;
  clangVersion: string;
  linkerVersion: string;
};
type Configuration = {
  schemaVersion: number;
  platform: string;
  minimumMacosVersion: string;
  releaseToolchain: NativeToolchain;
  opensslSource: SourceInput;
  sqlcipherSource: SourceInput;
  sparkleDistribution: SourceInput;
  sparkleVersion: string;
  sparklePublicEdKey: string;
  sparkleFeedUrl: string;
  sparkleSigningAccount: string;
  opensslLibrarySha256?: string;
  sqlcipherLibrarySha256?: string;
  sqlcipherHeaderSha256?: string;
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Native release dependencies require Apple Silicon macOS");
}
if (process.versions.bun !== "1.3.14") {
  throw new Error(`Native release dependencies require Bun 1.3.14; found ${process.versions.bun}`);
}

const configuration = JSON.parse(readFileSync(configurationPath, "utf8")) as Configuration;
assertConfiguration(configuration);
const releaseBuild = process.env.AFTERNOTE_RELEASE_BUILD === "1";
const toolchain = nativeToolchain();
if (releaseBuild && JSON.stringify(toolchain) !== JSON.stringify(configuration.releaseToolchain)) {
  throw new Error("Native release build requires the reviewed Apple toolchain");
}
const temporaryRoot = mkdtempSync(join(tmpdir(), "afternote-native-release-"));
const stagedRoot = `${outputRoot}.staging-${process.pid}`;
try {
  const opensslArchive = await downloadSource(configuration.opensslSource, temporaryRoot);
  const sqlcipherArchive = await downloadSource(configuration.sqlcipherSource, temporaryRoot);
  const sparkleArchive = await downloadSource(configuration.sparkleDistribution, temporaryRoot);
  run(["tar", "-xzf", opensslArchive, "-C", temporaryRoot]);
  run(["tar", "-xzf", sqlcipherArchive, "-C", temporaryRoot]);
  const sparkleSource = join(temporaryRoot, "sparkle");
  mkdirSync(sparkleSource, { mode: 0o700 });
  run(["ditto", "-x", "-k", sparkleArchive, sparkleSource]);

  const opensslSource = join(temporaryRoot, `openssl-${configuration.opensslSource.version}`);
  const sqlcipherSource = join(temporaryRoot, `sqlcipher-${configuration.sqlcipherSource.version}`);
  const deploymentEnvironment = {
    MACOSX_DEPLOYMENT_TARGET: minimumMacosVersion,
    SOURCE_DATE_EPOCH: sourceDateEpoch,
    CFLAGS: `-mmacosx-version-min=${minimumMacosVersion}`,
    LDFLAGS: `-mmacosx-version-min=${minimumMacosVersion}`,
  };
  run([
    "perl", "./Configure", "darwin64-arm64-cc", "shared", "no-tests",
    "--prefix=/AfternoteNative", "--openssldir=/AfternoteNative/ssl",
  ], opensslSource, deploymentEnvironment);
  run(["make", "-j8", "build_sw"], opensslSource, deploymentEnvironment);

  const sqlcipherCflags = [
    "-DSQLITE_HAS_CODEC",
    "-DSQLCIPHER_CRYPTO_OPENSSL",
    "-DSQLITE_ENABLE_FTS5",
    "-DSQLITE_EXTRA_INIT=sqlcipher_extra_init",
    "-DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown",
    `-mmacosx-version-min=${minimumMacosVersion}`,
  ].join(" ");
  run([
    "./configure",
    "--prefix=/AfternoteNative",
    "--disable-static",
    "--with-tempstore=yes",
    "--disable-tcl",
    "--disable-readline",
  ], sqlcipherSource, {
    MACOSX_DEPLOYMENT_TARGET: minimumMacosVersion,
    CFLAGS: sqlcipherCflags,
    CPPFLAGS: `-I${join(opensslSource, "include")}`,
    LDFLAGS: `-L${opensslSource} -mmacosx-version-min=${minimumMacosVersion} -lcrypto`,
  });
  run(["make", "-j8"], sqlcipherSource, deploymentEnvironment);

  rmSync(stagedRoot, { recursive: true, force: true });
  mkdirSync(join(stagedRoot, "include"), { recursive: true, mode: 0o700 });
  const cryptoPath = join(stagedRoot, "libcrypto.4.dylib");
  const sqlcipherPath = join(stagedRoot, "libsqlcipher.3.dylib");
  const headerPath = join(stagedRoot, "include/sqlite3.h");
  copyFileSync(join(opensslSource, "libcrypto.4.dylib"), cryptoPath);
  copyFileSync(join(sqlcipherSource, "libsqlite3.dylib"), sqlcipherPath);
  copyFileSync(join(sqlcipherSource, "sqlite3.h"), headerPath);
  copyFileSync(join(opensslSource, "LICENSE.txt"), join(stagedRoot, "OPENSSL_LICENSE.txt"));
  copyFileSync(join(sqlcipherSource, "LICENSE.txt"), join(stagedRoot, "SQLCIPHER_LICENSE.txt"));
  const sparkleFrameworkSource = join(
    sparkleSource,
    "Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework",
  );
  const sparkleFrameworkPath = join(stagedRoot, "Sparkle.framework");
  run(["ditto", sparkleFrameworkSource, sparkleFrameworkPath]);
  // Afternote is not sandboxed. These XPC adapters are unnecessary and would
  // expand both the signed payload and its privileged execution surface.
  rmSync(join(sparkleFrameworkPath, "Versions/B/XPCServices"), {
    recursive: true,
    force: true,
  });
  rmSync(join(sparkleFrameworkPath, "XPCServices"), { force: true });
  copyFileSync(join(sparkleSource, "LICENSE"), join(stagedRoot, "SPARKLE_LICENSE.txt"));
  const generateKeysPath = join(stagedRoot, "generate_keys");
  copyFileSync(join(sparkleSource, "bin/generate_keys"), generateKeysPath);
  chmodSync(generateKeysPath, 0o755);
  const generateAppcastPath = join(stagedRoot, "generate_appcast");
  copyFileSync(join(sparkleSource, "bin/generate_appcast"), generateAppcastPath);
  chmodSync(generateAppcastPath, 0o755);
  const signUpdatePath = join(stagedRoot, "sign_update");
  copyFileSync(join(sparkleSource, "bin/sign_update"), signUpdatePath);
  chmodSync(signUpdatePath, 0o755);
  chmodSync(cryptoPath, 0o755);
  chmodSync(sqlcipherPath, 0o755);
  run(["install_name_tool", "-id", "@loader_path/libcrypto.4.dylib", cryptoPath]);
  run([
    "install_name_tool", "-id", "@loader_path/libsqlcipher.3.dylib",
    "-change", "/AfternoteNative/lib/libcrypto.4.dylib",
    "@loader_path/libcrypto.4.dylib", sqlcipherPath,
  ]);
  assertDeploymentTarget(cryptoPath);
  assertDeploymentTarget(sqlcipherPath);
  assertNoBuildPath(cryptoPath, temporaryRoot);
  assertNoBuildPath(sqlcipherPath, temporaryRoot);

  const generated = {
    format: "afternote-native-release-dependencies",
    version: 1,
    platform: configuration.platform,
    minimumMacosVersion,
    toolchain,
    opensslSourceSha256: configuration.opensslSource.sha256,
    sqlcipherSourceSha256: configuration.sqlcipherSource.sha256,
    sparkleDistributionSha256: configuration.sparkleDistribution.sha256,
    sparkleVersion: configuration.sparkleVersion,
    sparkleFrameworkSha256: sha256DirectoryTree(sparkleFrameworkPath),
    sparkleGenerateKeysSha256: sha256(generateKeysPath),
    sparkleGenerateAppcastSha256: sha256(generateAppcastPath),
    sparkleSignUpdateSha256: sha256(signUpdatePath),
    opensslLibrarySha256: sha256(cryptoPath),
    sqlcipherLibrarySha256: sha256(sqlcipherPath),
    sqlcipherHeaderSha256: sha256(headerPath),
  };
  if (releaseBuild) {
    assertPinnedOutput("OpenSSL library", configuration.opensslLibrarySha256, generated.opensslLibrarySha256);
    assertPinnedOutput("SQLCipher library", configuration.sqlcipherLibrarySha256, generated.sqlcipherLibrarySha256);
    assertPinnedOutput("SQLCipher header", configuration.sqlcipherHeaderSha256, generated.sqlcipherHeaderSha256);
  }
  writeFileSync(
    join(stagedRoot, "BUILD_MANIFEST.json"),
    `${JSON.stringify(generated, null, 2)}\n`,
    { mode: 0o600 },
  );
  rmSync(outputRoot, { recursive: true, force: true });
  renameSync(stagedRoot, outputRoot);
  console.log(JSON.stringify(generated, null, 2));
} finally {
  rmSync(stagedRoot, { recursive: true, force: true });
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function assertConfiguration(value: Configuration): void {
  if (value.schemaVersion !== 4 || value.platform !== "darwin-arm64" ||
    value.minimumMacosVersion !== minimumMacosVersion) {
    throw new Error("Native release input configuration is incompatible");
  }
  for (const input of [
    value.opensslSource,
    value.sqlcipherSource,
    value.sparkleDistribution,
  ]) {
    if (!input || !/^https:\/\//.test(input.url) || !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0) {
      throw new Error("Native release source configuration is invalid");
    }
  }
  if (value.sparkleVersion !== value.sparkleDistribution.version ||
    !/^https:\/\//.test(value.sparkleFeedUrl) ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value.sparklePublicEdKey) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.sparkleSigningAccount)) {
    throw new Error("Sparkle update configuration is invalid");
  }
  for (const key of [
    "commandLineToolsVersion",
    "macosSdkVersion",
    "clangVersion",
    "linkerVersion",
  ] as const) {
    if (!value.releaseToolchain || typeof value.releaseToolchain[key] !== "string" ||
      value.releaseToolchain[key].length === 0) {
      throw new Error("Native release toolchain configuration is invalid");
    }
  }
}

async function downloadSource(input: SourceInput, directory: string): Promise<string> {
  const path = join(directory, basename(new URL(input.url).pathname));
  const result = Bun.spawnSync([
    "/usr/bin/curl",
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--http1.1",
    "--proto", "=https",
    "--proto-redir", "=https",
    "--continue-at", "-",
    "--retry", "8",
    "--retry-all-errors",
    "--retry-delay", "1",
    "--connect-timeout", "30",
    "--max-time", "300",
    "--retry-max-time", "900",
    "--max-filesize", String(input.maximumBytes),
    "--output", path,
    input.url,
  ], {
    cwd: directory,
    env: releaseCommandEnvironment(process.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Native source download failed: ${result.stderr.toString().slice(-2_000) || `curl exit ${result.exitCode}`}`,
    );
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > input.maximumBytes) {
    throw new Error("Native source download exceeds its size or file-type limit");
  }
  if (sha256(path) !== input.sha256) throw new Error("Native source archive failed verification");
  return path;
}

function assertPinnedOutput(label: string, expected: string | undefined, actual: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new Error(`${label} does not match its reviewed release digest`);
  }
}

function nativeToolchain(): NativeToolchain {
  const packageInfo = run([
    "pkgutil",
    "--pkg-info=com.apple.pkg.CLTools_Executables",
  ]);
  const commandLineToolsVersion = /^version:\s*(.+)$/m.exec(packageInfo)?.[1]?.trim();
  const macosSdkVersion = run(["xcrun", "--sdk", "macosx", "--show-sdk-version"]).trim();
  const clangVersion = run(["clang", "--version"]).split("\n")[0]?.trim();
  const linkerVersion = run(["ld", "-v"]).split("\n")[0]?.trim();
  if (!commandLineToolsVersion || !macosSdkVersion || !clangVersion || !linkerVersion) {
    throw new Error("Could not identify the native Apple toolchain");
  }
  return { commandLineToolsVersion, macosSdkVersion, clangVersion, linkerVersion };
}

function assertDeploymentTarget(path: string): void {
  const output = run(["otool", "-l", path]);
  const versions = [...output.matchAll(/\bminos\s+(\d+\.\d+)/g)].map((match) => match[1]);
  if (versions.length === 0 || versions.some((version) => version !== minimumMacosVersion)) {
    throw new Error(`Native dependency has an unexpected macOS deployment target: ${path}`);
  }
}

function assertNoBuildPath(path: string, temporaryRoot: string): void {
  if (readFileSync(path).includes(Buffer.from(temporaryRoot))) {
    throw new Error(`Native dependency contains its temporary build path: ${path}`);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(
  command: string[],
  cwd = repositoryRoot,
  environment: Record<string, string> = {},
): string {
  const [tool, ...args] = command;
  const tools: Readonly<Record<string, string>> = {
    "./configure": "./configure",
    clang: "/usr/bin/clang",
    ditto: "/usr/bin/ditto",
    install_name_tool: "/usr/bin/install_name_tool",
    ld: "/usr/bin/ld",
    make: "/usr/bin/make",
    otool: "/usr/bin/otool",
    perl: "/usr/bin/perl",
    pkgutil: "/usr/sbin/pkgutil",
    tar: "/usr/bin/tar",
    xcrun: "/usr/bin/xcrun",
  };
  const executable = tool?.startsWith("/") ? tool : tool ? tools[tool] : undefined;
  if (!executable) throw new Error(`Native source build tool is not pinned: ${tool ?? "missing"}`);
  const result = Bun.spawnSync([executable, ...args], {
    cwd,
    env: releaseCommandEnvironment(process.env, environment),
    stdout: tool === "make" ? "ignore" : "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Native source build failed (${tool}): ${result.stderr.toString().slice(-8_000) || result.stdout?.toString().slice(-8_000) || "no output"}`,
    );
  }
  return `${result.stdout?.toString() ?? ""}${result.stderr.toString()}`;
}
