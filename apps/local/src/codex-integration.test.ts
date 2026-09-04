import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  manageCodexIntegration,
  parseCodexIntegrationAction,
  resolveCodexCommand,
} from "./codex-integration";

describe("Codex integration discovery", () => {
  it("accepts the explicit identity rotation action", () => {
    expect(parseCodexIntegrationAction("rotate-identity")).toBe("rotate-identity");
  });

  it("never treats identity rotation as removal", async () => {
    await expect(
      manageCodexIntegration("rotate-identity", true),
    ).rejects.toThrow("Codex identity rotation must be routed separately");
  });

  it("uses an executable desktop-bundled Codex CLI when PATH has none", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-codex-discovery-"));
    const bundled = join(directory, "ChatGPT.app/Contents/Resources/codex");
    const missing = join(directory, "Codex.app/Contents/Resources/codex");
    try {
      mkdirSync(dirname(bundled), { recursive: true });
      writeFileSync(bundled, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      chmodSync(bundled, 0o755);
      expect(resolveCodexCommand({
        pathCommand: null,
        desktopCandidates: [missing, bundled],
        verifyCommand: (command) => command,
      })).toBe(bundled);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports tool availability separately from connector installation", async () => {
    const missing = await manageCodexIntegration("status", true, {
      afternoteCommand: "/Applications/Afternote.app/Contents/MacOS/afternote",
      toolCommand: null,
    });
    expect(missing).toMatchObject({
      schemaVersion: 4,
      toolAvailable: false,
      installed: false,
      healthy: false,
      repairable: false,
      problemCode: null,
    });

    const available = await manageCodexIntegration("status", true, {
      afternoteCommand: "/Applications/Afternote.app/Contents/MacOS/afternote",
      toolCommand: "/Applications/Codex.app/Contents/Resources/codex",
      readServer: () => null,
    });
    expect(available).toMatchObject({
      toolAvailable: true,
      installed: false,
      healthy: false,
      repairable: true,
      problemCode: "connector_missing",
    });
  });

  it("classifies conflicting, legacy, unhealthy, and healthy connectors", async () => {
    const afternote = "/Applications/Afternote.app/Contents/MacOS/afternote";
    const tool = "/Applications/Codex.app/Contents/Resources/codex";

    const conflict = await manageCodexIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => ({
        name: "afternote",
        transport: { type: "stdio", command: "/tmp/foreign", args: ["mcp"] },
      }),
    });
    expect(conflict).toMatchObject({
      toolAvailable: true,
      installed: true,
      configHealthy: false,
      repairable: false,
      problemCode: "connector_conflict",
    });

    const legacy = await manageCodexIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => ({
        name: "afternote",
        transport: { type: "stdio", command: afternote, args: ["mcp"] },
      }),
    });
    expect(legacy).toMatchObject({
      installed: true,
      configHealthy: false,
      repairable: true,
      problemCode: "connector_legacy",
    });

    const configured = {
      name: "afternote",
      transport: {
        type: "stdio",
        command: afternote,
        args: ["mcp", "--client", "codex"],
      },
    };
    const unhealthy = await manageCodexIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => configured,
      probeReadiness: async () => ({
        healthy: false,
        state: "failed",
        tools: [],
        startupMs: 5,
        error: { code: "startup_failed", message: "broker unavailable" },
      }),
      probeIdentity: async () => true,
    });
    expect(unhealthy).toMatchObject({
      installed: true,
      configHealthy: true,
      runtimeHealthy: false,
      healthy: false,
      repairable: false,
      problemCode: "runtime_unavailable",
    });

    const healthy = await manageCodexIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => configured,
      probeReadiness: async () => ({
        healthy: true,
        state: "ready",
        tools: ["get_note", "recall", "remember"],
        startupMs: 5,
        error: null,
      }),
      probeIdentity: async () => true,
    });
    expect(healthy).toMatchObject({
      installed: true,
      configHealthy: true,
      runtimeHealthy: true,
      healthy: true,
      repairable: false,
      problemCode: null,
    });

    const missingIdentity = await manageCodexIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => configured,
      probeIdentity: async () => false,
      probeReadiness: async () => {
        throw new Error("runtime must not be probed without a signing identity");
      },
    });
    expect(missingIdentity).toMatchObject({
      installed: true,
      configHealthy: true,
      identityHealthy: false,
      runtimeHealthy: false,
      healthy: false,
      problemCode: "identity_unavailable",
    });
  });

  it("rolls back only the Afternote entry when post-install validation fails", async () => {
    const afternote = "/Applications/Afternote.app/Contents/MacOS/afternote";
    const configured = {
      name: "afternote",
      transport: { type: "stdio", command: afternote, args: ["mcp", "--client", "codex"] },
    };
    const states = [null, configured, configured];
    const commands: string[][] = [];
    await expect(manageCodexIntegration("install", true, {
      afternoteCommand: afternote,
      toolCommand: "/verified/codex",
      readServer: () => states.shift() ?? null,
      probeIdentity: () => true,
      probeReadiness: async () => ({
        healthy: false,
        state: "failed",
        tools: [],
        startupMs: 1,
        error: { code: "startup_failed", message: "unavailable" },
      }),
      runTool: (args) => commands.push([...args]),
    })).rejects.toThrow("did not retain a working");
    expect(commands).toEqual([
      ["mcp", "add", "afternote", "--", afternote, "mcp", "--client", "codex"],
      ["mcp", "remove", "afternote"],
    ]);
  });
});
