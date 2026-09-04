import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  assertReleaseArtifactHygiene,
  runTextOnlyTransformersCompile,
} from "../../../scripts/build-local-alpha";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("public release artifacts", () => {
  it("fails packaging when any release executable leaks its checkout path", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-release-hygiene-"));
    directories.push(directory);
    const clean = join(directory, "clean");
    const leaked = join(directory, "leaked");
    writeFileSync(clean, "release executable");
    writeFileSync(leaked, `release executable ${resolve(import.meta.dir, "../../..")}`);
    expect(() => assertReleaseArtifactHygiene({
      repositoryRoot: resolve(import.meta.dir, "../../.."),
      executables: [clean, leaked],
      clientPath: clean,
      workerPath: clean,
    })).toThrow("checkout-specific path");
  });

  it("contains no development-key provider or checkout-specific absolute path", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-public-worker-"));
    directories.push(directory);
    const output = join(directory, "afternote-vault-worker");
    const metafile = join(directory, "worker-metafile.json");
    const repositoryRoot = resolve(import.meta.dir, "../../..");
    runTextOnlyTransformersCompile([
      process.execPath,
      "build",
      "--compile",
      "--target=bun-darwin-arm64",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--minify",
      `--metafile=${metafile}`,
      '--define=AFTERNOTE_BUILD_VERSION="2.0.0-public-worker-test"',
      "--define=AFTERNOTE_STANDALONE=true",
      "--define=AFTERNOTE_RELEASE_BUILD=true",
      '--define=AFTERNOTE_OWNER_PRESENCE_MODE="required"',
      '--define=AFTERNOTE_GATEWAY_CODE_REQUIREMENT="identifier \\"dev.afternote.vault-broker\\""',
      '--define=AFTERNOTE_KEYCHAIN_ACCESS_GROUP="ABCDE12345.dev.afternote.vault-key"',
      join(import.meta.dir, "vault-broker-release-worker-main.ts"),
      `--outfile=${output}`,
    ]);

    const bytes = readFileSync(output);
    expect(bytes.includes(Buffer.from("development-vault.key"))).toBe(false);
    expect(bytes.includes(Buffer.from(repositoryRoot))).toBe(false);
    expect(bytes.includes(Buffer.from("getOrCreateDevelopmentVaultKey"))).toBe(false);
    expect(readFileSync(metafile, "utf8")).not.toContain("development-vault-key.ts");
  });

  it("keeps the public CLI free of development authority and checkout-specific paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-release-cli-artifact-"));
    directories.push(directory);
    const artifactPath = join(directory, "afternote");
    runTextOnlyTransformersCompile([
      process.execPath,
      "build",
      "--compile",
      "--target=bun-darwin-arm64",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--minify",
      '--define=AFTERNOTE_BUILD_VERSION="2.0.0-artifact-test"',
      "--define=AFTERNOTE_STANDALONE=true",
      '--define=AFTERNOTE_BROKER_CODE_REQUIREMENT="identifier \\"dev.afternote.vault-broker\\""',
      '--define=AFTERNOTE_BROKER_MACH_SERVICE="dev.afternote.vault-broker"',
      join(import.meta.dir, "main-release.ts"),
      `--outfile=${artifactPath}`,
    ]);

    const bytes = readFileSync(artifactPath);
    expect(bytes.includes(Buffer.from("development-vault.key"))).toBe(false);
    expect(bytes.includes(Buffer.from(resolve(import.meta.dir, "../../..")))).toBe(false);
    expect(bytes.includes(Buffer.from("semantic status|install"))).toBe(true);
    expect(bytes.includes(Buffer.from("onnxruntime_binding.node"))).toBe(true);
    expect(bytes.includes(Buffer.from("/$bunfs/root/onnxruntime_binding"))).toBe(false);
    expect(bytes.includes(Buffer.from("--admin-enroll-release-key"))).toBe(false);
    expect(bytes.includes(Buffer.from("xoxb-"))).toBe(false);
    expect(bytes.includes(Buffer.from("chat.postEphemeral"))).toBe(false);
    expect(bytes.includes(Buffer.from("nativeMessaging"))).toBe(false);
    expect(bytes.includes(Buffer.from("eval-organization"))).toBe(true);
  });
});
