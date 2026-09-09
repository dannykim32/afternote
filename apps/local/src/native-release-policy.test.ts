import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const repositoryRoot = resolve(import.meta.dir, "../../..");

describe("native release input policy", () => {
  it("pins source archives and every externally supplied release binary", () => {
    const configuration = JSON.parse(readFileSync(
      join(repositoryRoot, "scripts/native-release-inputs.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(configuration.schemaVersion).toBe(3);
    expect(configuration.platform).toBe("darwin-arm64");
    expect(configuration.minimumMacosVersion).toBe("13.3");
    expect(configuration.releaseToolchain).toEqual({
      commandLineToolsVersion: "14.3.1.0.1.1683849156",
      macosSdkVersion: "13.3",
      clangVersion: "Apple clang version 14.0.3 (clang-1403.0.22.14.1)",
      linkerVersion: "@(#)PROGRAM:ld  PROJECT:ld64-857.1",
    });
    for (const key of [
      "bunExecutableSha256",
      "nodeHeadersSha256",
      "onnxRuntimeBindingSha256",
      "onnxRuntimeLibrarySha256",
      "opensslLibrarySha256",
      "sqlcipherLibrarySha256",
      "sqlcipherHeaderSha256",
    ]) {
      expect(configuration[key]).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const key of ["opensslSource", "sqlcipherSource"]) {
      const source = configuration[key] as Record<string, unknown>;
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.maximumBytes).toBeGreaterThan(0);
    }
  });

  it("builds release libraries from pinned source with a reproducible epoch", () => {
    const preparation = readFileSync(
      join(repositoryRoot, "scripts/prepare-native-release-dependencies.ts"),
      "utf8",
    );
    expect(preparation).toContain('const sourceDateEpoch = "0"');
    expect(preparation).toContain('"/usr/bin/curl"');
    expect(preparation).toContain('"--proto-redir", "=https"');
    expect(preparation).toContain('"--http1.1"');
    expect(preparation).toContain('"--continue-at", "-"');
    expect(preparation).toContain('"--retry", "8"');
    expect(preparation).toContain('"--max-filesize", String(input.maximumBytes)');
    expect(preparation).toContain("SOURCE_DATE_EPOCH: sourceDateEpoch");
    expect(preparation).toContain("if (releaseBuild)");
    expect(preparation).toContain("Native release build requires the reviewed Apple toolchain");
    expect(preparation).toContain('"-DSQLITE_ENABLE_FTS5"');
    expect(preparation).toContain("assertDeploymentTarget(cryptoPath)");
    expect(preparation).toContain("assertNoBuildPath(sqlcipherPath, temporaryRoot)");
  });

  it("keeps Homebrew out of signed release libraries and claims only their target", () => {
    const nativeBuild = readFileSync(
      join(repositoryRoot, "scripts/build-local-sqlcipher-addon.ts"),
      "utf8",
    );
    const packageBuild = readFileSync(
      join(repositoryRoot, "scripts/build-local-alpha.ts"),
      "utf8",
    );
    const supplyChain = readFileSync(
      join(repositoryRoot, "scripts/release-supply-chain.ts"),
      "utf8",
    );
    expect(nativeBuild).toContain('join(repositoryRoot, "apps/local/native/release-deps")');
    expect(nativeBuild).toContain('requiredDigest(manifest.onnxRuntimeLibrarySha256');
    expect(nativeBuild).toContain('"-mcpu=apple-m1"');
    expect(nativeBuild).toContain("assertPreparedNativeDependencies()");
    expect(nativeBuild).toContain("assertDeploymentTarget(sqlcipherPath)");
    expect(nativeBuild).not.toContain("/opt/homebrew/opt/sqlcipher/lib");
    expect(nativeBuild).not.toContain("/opt/homebrew/opt/openssl@4/lib");
    expect(packageBuild).toContain('const minimumMacosVersion = "13.3"');
    expect(packageBuild).toContain('"-mmacosx-version-min=13.3"');
    expect(packageBuild).toContain('["/usr/bin/xcode-select", "-p"]');
    expect(packageBuild).toContain("com.apple.pkg.CLTools_Executables");
    expect(supplyChain).not.toContain("/opt/homebrew/opt/sqlcipher");
    expect(supplyChain).not.toContain("/opt/homebrew/opt/openssl@4");
  });

  it("applies the shared policy to direct native build inputs", () => {
    for (const [environment, expected] of [
      [{ AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS: "sometimes" }, "must be 0 or 1"],
      [{ AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE: "dev.afternote.vault-broker.acceptance.test" }, "requires AFTERNOTE_ACCEPTANCE_BUILD=1"],
      [{
        AFTERNOTE_ACCEPTANCE_BUILD: "1",
        AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE: `dev.afternote.vault-broker.acceptance.${"x".repeat(240)}`,
      }, "Acceptance broker Mach service"],
    ] as const) {
      const result = Bun.spawnSync([
        process.execPath,
        "run",
        "scripts/build-local-sqlcipher-addon.ts",
      ], {
        cwd: repositoryRoot,
        env: { ...process.env, ...environment },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(expected);
    }
  });
});
