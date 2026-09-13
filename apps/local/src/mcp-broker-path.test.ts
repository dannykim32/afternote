import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const sourceDirectory = fileURLToPath(new URL(".", import.meta.url));

describe("production MCP broker path", () => {
  it("enables redacted MCP timing traces only in acceptance packages", () => {
    const buildScript = readFileSync(
      join(sourceDirectory, "../../../scripts/build-local-alpha.ts"),
      "utf8",
    );
    expect(buildScript.match(/--define=AFTERNOTE_ACCEPTANCE_TRACE=\$\{acceptanceBuild\}/g))
      .toHaveLength(2);
  });

  it("reserves the acceptance timing prefix for MCP broker timing events", () => {
    const nonTimingSources = [
      join(sourceDirectory, "vault-broker-worker.ts"),
      join(sourceDirectory, "../native/vault_broker_gateway.mm"),
    ].map((file) => readFileSync(file, "utf8")).join("\n");
    expect(nonTimingSources).not.toMatch(/["'`]AFTERNOTE_ACCEPTANCE_TRACE /u);
  });

  it("has no legacy runtime, bearer-token, or direct-database fallback", () => {
    const productionPath = [
      "mcp-broker-adapter.ts",
      "vault-broker-client.ts",
      "vault-broker-worker.ts",
    ].map((file) => readFileSync(join(sourceDirectory, file), "utf8")).join("\n");

    expect(productionPath).not.toContain("ensureLocalRuntime");
    expect(productionPath).not.toContain("runtime.token");
    expect(productionPath).not.toContain("LocalRuntimeMemoryClient");
    expect(readFileSync(join(sourceDirectory, "mcp-broker-adapter.ts"), "utf8"))
      .not.toContain("SqliteMemory");
    const adapter = readFileSync(
      join(sourceDirectory, "mcp-broker-adapter.ts"),
      "utf8",
    );
    expect(adapter).toContain("requireParentCodeSigningRequirement");
    expect(adapter)
      .toContain("requireParentAndGrandparentCodeSigningRequirements");
    expect(adapter).toContain("matchesAncestorCodeSigningRequirements");
    const nativeAddon = readFileSync(
      join(sourceDirectory, "../native/sqlcipher_addon.cc"),
      "utf8",
    );
    expect(nativeAddon).toContain("ParentProcessIdentifier");
    expect(nativeAddon)
      .toContain("Grandparent process does not satisfy the required code signature");
    expect(nativeAddon).toContain("MatchesAncestorCodeSigningRequirements");
  });

  it("rejects generic MCP invocation before creating legacy runtime authority", () => {
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      join(sourceDirectory, "main.ts"),
      "mcp",
    ], {
      env: {
        ...process.env,
        AFTERNOTE_RUNTIME_PATH: join(sourceDirectory, "must-not-exist-runtime"),
        AFTERNOTE_VAULT_PATH: join(sourceDirectory, "must-not-exist-vault.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("requires an installed connector identity");
  });
});
