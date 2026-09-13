import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
import { assertSignedReleaseEntitlements } from "../../../scripts/build-local-alpha";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("public release input controls", () => {
  it("rejects a signed vault worker carrying the client-signing Keychain group", () => {
    const root = temporaryDirectory();
    const executable = join(root, "afternote-vault-worker");
    const entitlements = join(root, "entitlements.plist");
    copyFileSync("/usr/bin/true", executable);
    chmodSync(executable, 0o755);
    writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.application-identifier</key><string>486B2A8N8A.dev.afternote.vault-broker.worker</string>
<key>keychain-access-groups</key><array><string>486B2A8N8A.dev.afternote.client-key</string></array>
</dict></plist>
`);
    const signExecutable = () => Bun.spawnSync([
      "/usr/bin/codesign",
      "--force",
      "--sign",
      "-",
      "--entitlements",
      entitlements,
      executable,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(signExecutable().exitCode).toBe(0);

    expect(() => assertSignedReleaseEntitlements(
      executable,
      "worker",
      "486B2A8N8A",
    )).toThrow("Keychain access groups");

    writeFileSync(
      entitlements,
      readFileSync(entitlements, "utf8").replace("client-key", "vault-key"),
    );
    expect(signExecutable().exitCode).toBe(0);
    expect(() => assertSignedReleaseEntitlements(
      executable,
      "worker",
      "486B2A8N8A",
    )).not.toThrow();
  });

  it("rejects ambient compiler and Bun configuration inputs", () => {
    expect(() => assertSafeReleaseEnvironment({ CPATH: "/tmp/inject" }))
      .toThrow("CPATH");
    expect(() => assertSafeReleaseEnvironment({ BUN_CONFIG_REGISTRY: "https://example.invalid" }))
      .toThrow("BUN_CONFIG_REGISTRY");
    expect(() => assertSafeReleaseEnvironment({ AFTERNOTE_PACKAGE_VERSION: "2.0.0-alpha.8" }))
      .toThrow("AFTERNOTE_PACKAGE_VERSION");
    expect(() => assertSafeReleaseEnvironment({
      AFTERNOTE_KEYCHAIN_ACCESS_GROUP: "486B2A8N8A.dev.afternote.client-key",
    })).toThrow("AFTERNOTE_KEYCHAIN_ACCESS_GROUP");
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
  it("binds contained framework symlinks and rejects links that escape the payload", () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "Afternote.app/Contents/Frameworks/Example.framework/Versions/A"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "Afternote.app/Contents/Frameworks/Example.framework/Versions/A/Example"),
      "framework\n",
    );
    symlinkSync(
      "Versions/A/Example",
      join(root, "Afternote.app/Contents/Frameworks/Example.framework/Example"),
    );
    expect(collectPayloadEntries(root)).toContainEqual({
      path: "Afternote.app/Contents/Frameworks/Example.framework/Example",
      type: "symlink",
      target: "Versions/A/Example",
    });

    symlinkSync(
      "/Applications",
      join(root, "Afternote.app/Contents/Frameworks/Example.framework/escape"),
    );
    expect(() => collectPayloadEntries(root)).toThrow("escapes its payload root");
  });

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

    symlinkSync("/Applications", join(root, "Applications"));
    verifyEmbeddedRuntimeManifest(application);
    verifyApplicationPayloadManifest(application);
    rmSync(join(root, "Applications"));

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
