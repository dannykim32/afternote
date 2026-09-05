import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertEmbeddedRuntimeMatchesPortable,
  assertOnlyAllowedPayloadChanges,
  collectPayloadEntries,
  verifyApplicationPayloadManifest,
  verifyEmbeddedRuntimeManifest,
  verifyPayloadManifest,
  writePayloadManifest,
} from "../../../scripts/release-payload-manifest";
import {
  assertSafeReleaseEnvironment,
  releaseCommandEnvironment,
} from "../../../scripts/release-environment";
import { sha256DirectoryTree } from "../../../scripts/release-inputs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("public release input controls", () => {
  it("rejects ambient compiler and Bun configuration inputs", () => {
    expect(() => assertSafeReleaseEnvironment({ CPATH: "/tmp/inject" }))
      .toThrow("CPATH");
    expect(() => assertSafeReleaseEnvironment({ BUN_CONFIG_REGISTRY: "https://example.invalid" }))
      .toThrow("BUN_CONFIG_REGISTRY");
  });

  it("passes only the reviewed release environment", () => {
    const environment = releaseCommandEnvironment({
      AFTERNOTE_RELEASE_BUILD: "1",
      AFTERNOTE_TEAM_ID: "486B2A8N8A",
      HOME: "/Users/release",
      SECRET_NOT_FOR_CHILDREN: "no",
    });
    expect(environment.AFTERNOTE_RELEASE_BUILD).toBe("1");
    expect(environment.AFTERNOTE_TEAM_ID).toBe("486B2A8N8A");
    expect(environment.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(environment.SECRET_NOT_FOR_CHILDREN).toBeUndefined();
  });

  it("changes the dependency snapshot digest when installed bytes change", () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, "dependency.js"), "export const value = 1;\n");
    const before = sha256DirectoryTree(root);
    writeFileSync(join(root, "dependency.js"), "export const value = 2;\n");
    expect(sha256DirectoryTree(root)).not.toBe(before);
  });
});

describe("signed release payload manifest", () => {
  it("binds the embedded runtime and detects divergence from the portable payload", () => {
    const root = temporaryDirectory();
    const application = join(root, "Afternote.app");
    const resources = join(application, "Contents/Resources");
    const embedded = join(resources, "AfternoteRuntime");
    mkdirSync(embedded, { recursive: true });
    writeFileSync(join(root, "install.sh"), "echo reviewed\n", { mode: 0o755 });
    writeFileSync(join(embedded, "install.sh"), "echo reviewed\n", { mode: 0o755 });

    assertEmbeddedRuntimeMatchesPortable(root);
    writePayloadManifest(root);
    verifyPayloadManifest(root);
    verifyEmbeddedRuntimeManifest(application);
    verifyApplicationPayloadManifest(application);

    writeFileSync(join(embedded, "install.sh"), "echo changed\n", { mode: 0o755 });
    expect(() => verifyPayloadManifest(root)).toThrow("does not match");
    expect(() => verifyEmbeddedRuntimeManifest(application)).toThrow("does not match");
    expect(() => verifyApplicationPayloadManifest(application)).toThrow("does not match");
    expect(() => assertEmbeddedRuntimeMatchesPortable(root)).toThrow("differs");
  });

  it("allows only declared finalizer mutations outside Apple's outer-app signature", () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "AfternoteVaultWorker.app"), { recursive: true });
    mkdirSync(join(root, "Afternote.app/Contents/Resources/AfternoteRuntime"), { recursive: true });
    mkdirSync(join(root, "Afternote.app/Contents/MacOS"), { recursive: true });
    writeFileSync(join(root, "install.sh"), "echo reviewed\n");
    writeFileSync(join(root, "AfternoteVaultWorker.app/ticket"), "before\n");
    writeFileSync(join(root, "Afternote.app/Contents/MacOS/Afternote"), "reviewed\n");
    writeFileSync(join(root, "Afternote.app/Contents/Resources/reviewed.dat"), "reviewed\n");
    const before = collectPayloadEntries(root);
    expect(before.some((entry) =>
      entry.path === "Afternote.app/Contents/MacOS/Afternote"
    )).toBe(false);

    writeFileSync(join(root, "AfternoteVaultWorker.app/ticket"), "after\n");
    expect(() => assertOnlyAllowedPayloadChanges(
      before,
      collectPayloadEntries(root),
      ["AfternoteVaultWorker.app"],
    )).not.toThrow();

    writeFileSync(join(root, "install.sh"), "echo injected\n");
    expect(() => assertOnlyAllowedPayloadChanges(
      before,
      collectPayloadEntries(root),
      ["AfternoteVaultWorker.app"],
    )).toThrow("allowed mutation set");

    writeFileSync(join(root, "install.sh"), "echo reviewed\n");
    writeFileSync(join(root, "Afternote.app/Contents/Resources/reviewed.dat"), "injected\n");
    expect(() => assertOnlyAllowedPayloadChanges(
      before,
      collectPayloadEntries(root),
      ["AfternoteVaultWorker.app"],
    )).toThrow("allowed mutation set");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "afternote-release-integrity-"));
  temporaryDirectories.push(directory);
  return directory;
}
