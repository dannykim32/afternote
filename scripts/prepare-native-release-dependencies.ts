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

const repositoryRoot = resolve(process.cwd());
const configurationPath = join(repositoryRoot, "scripts/native-release-inputs.json");
const outputRoot = join(repositoryRoot, "apps/local/native/release-deps");
const minimumMacosVersion = "13.3";
// OpenSSL records its build time in libcrypto. A fixed epoch makes clean builds
// byte-for-byte reproducible instead of pinning a one-off timestamp.
const sourceDateEpoch = "0";

type SourceInput = { version: string; url: string; sha256: string; maximumBytes: number };
type Configuration = {
  schemaVersion: number;
  platform: string;
  minimumMacosVersion: string;
  opensslSource: SourceInput;
  sqlcipherSource: SourceInput;
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
const temporaryRoot = mkdtempSync(join(tmpdir(), "afternote-native-release-"));
const stagedRoot = `${outputRoot}.staging-${process.pid}`;
try {
  const opensslArchive = await downloadSource(configuration.opensslSource, temporaryRoot);
  const sqlcipherArchive = await downloadSource(configuration.sqlcipherSource, temporaryRoot);
  run(["tar", "-xzf", opensslArchive, "-C", temporaryRoot]);
  run(["tar", "-xzf", sqlcipherArchive, "-C", temporaryRoot]);

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
    opensslSourceSha256: configuration.opensslSource.sha256,
    sqlcipherSourceSha256: configuration.sqlcipherSource.sha256,
    opensslLibrarySha256: sha256(cryptoPath),
    sqlcipherLibrarySha256: sha256(sqlcipherPath),
    sqlcipherHeaderSha256: sha256(headerPath),
  };
  assertPinnedOutput("OpenSSL library", configuration.opensslLibrarySha256, generated.opensslLibrarySha256);
  assertPinnedOutput("SQLCipher library", configuration.sqlcipherLibrarySha256, generated.sqlcipherLibrarySha256);
  assertPinnedOutput("SQLCipher header", configuration.sqlcipherHeaderSha256, generated.sqlcipherHeaderSha256);
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
  if (value.schemaVersion !== 2 || value.platform !== "darwin-arm64" ||
    value.minimumMacosVersion !== minimumMacosVersion) {
    throw new Error("Native release input configuration is incompatible");
  }
  for (const input of [value.opensslSource, value.sqlcipherSource]) {
    if (!input || !/^https:\/\//.test(input.url) || !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0) {
      throw new Error("Native release source configuration is invalid");
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
    "--proto", "=https",
    "--proto-redir", "=https",
    "--retry", "2",
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
    install_name_tool: "/usr/bin/install_name_tool",
    make: "/usr/bin/make",
    otool: "/usr/bin/otool",
    perl: "/usr/bin/perl",
    tar: "/usr/bin/tar",
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
  return result.stdout?.toString() ?? "";
}
