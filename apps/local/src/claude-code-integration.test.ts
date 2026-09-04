import { describe, expect, it } from "bun:test";
import {
  isOwnedLegacyClaudeCodeServer,
  manageClaudeCodeIntegration,
  parseClaudeCodeIntegrationAction,
  resolveClaudeCodeCommand,
} from "./claude-code-integration";

describe("Claude Code integration actions", () => {
  it("accepts the explicit identity rotation action", () => {
    expect(parseClaudeCodeIntegrationAction("rotate-identity")).toBe(
      "rotate-identity",
    );
  });

  it("never treats identity rotation as removal", async () => {
    await expect(
      manageClaudeCodeIntegration("rotate-identity", true),
    ).rejects.toThrow("Claude Code identity rotation must be routed separately");
  });

  it("recognizes only the exact Afternote-owned legacy entry for migration", () => {
    const command = "/Users/test/.local/bin/afternote";
    expect(isOwnedLegacyClaudeCodeServer({
      type: "stdio",
      command,
      args: ["mcp"],
    }, command)).toBe(true);
    expect(isOwnedLegacyClaudeCodeServer({
      type: "stdio",
      command: "/usr/local/bin/something-else",
      args: ["mcp"],
    }, command)).toBe(false);
    expect(isOwnedLegacyClaudeCodeServer({
      type: "stdio",
      command,
      args: ["mcp"],
      env: { TOKEN: "foreign" },
    }, command)).toBe(false);
  });

  it("discovers a shell-installed Claude Code CLI outside an app PATH", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const command = resolveClaudeCodeCommand();
      if (command !== null) {
        expect(command.endsWith("/claude")).toBe(true);
      }
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reports tool availability separately from connector installation", async () => {
    const missing = await manageClaudeCodeIntegration("status", true, {
      afternoteCommand: "/Applications/Afternote.app/Contents/MacOS/afternote",
      toolCommand: null,
    });
    expect(missing).toMatchObject({
      schemaVersion: 3,
      toolAvailable: false,
      installed: false,
      healthy: false,
      repairable: false,
      problemCode: null,
    });

    const available = await manageClaudeCodeIntegration("status", true, {
      afternoteCommand: "/Applications/Afternote.app/Contents/MacOS/afternote",
      toolCommand: "/usr/local/bin/claude",
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
    const tool = "/usr/local/bin/claude";
    const conflict = await manageClaudeCodeIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => ({
        type: "stdio",
        command: "/tmp/foreign",
        args: ["mcp"],
      }),
    });
    expect(conflict).toMatchObject({
      toolAvailable: true,
      installed: true,
      configHealthy: false,
      repairable: false,
      problemCode: "connector_conflict",
    });

    const legacy = await manageClaudeCodeIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => ({ type: "stdio", command: afternote, args: ["mcp"] }),
    });
    expect(legacy).toMatchObject({
      installed: true,
      configHealthy: false,
      repairable: true,
      problemCode: "connector_legacy",
    });

    const configured = {
      type: "stdio",
      command: afternote,
      args: ["mcp", "--client", "claude"],
    };
    const unhealthy = await manageClaudeCodeIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => configured,
      probeRuntime: async () => false,
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

    const healthy = await manageClaudeCodeIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => configured,
      probeRuntime: async () => true,
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

    const missingIdentity = await manageClaudeCodeIntegration("status", true, {
      afternoteCommand: afternote,
      toolCommand: tool,
      readServer: () => configured,
      probeIdentity: async () => false,
      probeRuntime: async () => {
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
      type: "stdio",
      command: afternote,
      args: ["mcp", "--client", "claude"],
    };
    const states = [null, configured, configured];
    const commands: string[][] = [];
    await expect(manageClaudeCodeIntegration("install", true, {
      afternoteCommand: afternote,
      toolCommand: "/verified/claude",
      readServer: () => states.shift() ?? null,
      probeIdentity: () => true,
      probeRuntime: async () => false,
      runTool: (args) => commands.push([...args]),
    })).rejects.toThrow("did not retain a healthy");
    expect(commands).toEqual([
      ["mcp", "add", "--scope", "user", "afternote", "--", afternote, "mcp", "--client", "claude"],
      ["mcp", "remove", "--scope", "user", "afternote"],
    ]);
  });
});
