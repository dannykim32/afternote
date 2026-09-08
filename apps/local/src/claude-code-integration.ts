import {
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  installedAfternoteCommand,
  probeMcpRuntime,
} from "./codex-integration";
import {
  runIntegrationHostCommand,
  verifyIntegrationHostCommand,
} from "./integration-host-command";
import { integrationIdentityIsHealthy } from "./integration-identity";

const CLAUDE_SERVER_NAME = "afternote";

export type ClaudeCodeIntegrationAction =
  | "install"
  | "status"
  | "remove"
  | "rotate-identity";

export type ClaudeCodeServer = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

type ClaudeCodeConfig = {
  mcpServers?: Record<string, ClaudeCodeServer>;
};

export type ClaudeCodeIntegrationProblemCode =
  | "connector_missing"
  | "connector_legacy"
  | "connector_conflict"
  | "identity_unavailable"
  | "runtime_unavailable"
  | null;

export type ClaudeCodeIntegrationStatus = {
  format: "afternote-claude-code-integration";
  schemaVersion: 3;
  toolAvailable: boolean;
  installed: boolean;
  healthy: boolean;
  configHealthy: boolean;
  identityHealthy: boolean;
  runtimeHealthy: boolean;
  repairable: boolean;
  problemCode: ClaudeCodeIntegrationProblemCode;
  scope: "user";
  command: string;
  args: ["mcp", "--client", "claude"];
};

export type ClaudeCodeIntegrationDependencies = {
  afternoteCommand?: string;
  toolCommand?: string | null;
  readServer?: () => ClaudeCodeServer | null;
  probeRuntime?: (command: string, args: readonly string[]) => Promise<boolean>;
  probeIdentity?: () => boolean | Promise<boolean>;
  runTool?: (args: readonly string[]) => void;
};

export function parseClaudeCodeIntegrationAction(
  action: string | undefined,
): ClaudeCodeIntegrationAction {
  if (
    action === "install" ||
    action === "status" ||
    action === "remove" ||
    action === "rotate-identity"
  ) {
    return action;
  }
  throw new Error(
    "Claude Code action must be install, status, remove, or rotate-identity",
  );
}

export async function manageClaudeCodeIntegration(
  action: ClaudeCodeIntegrationAction,
  standalone: boolean,
  dependencies: ClaudeCodeIntegrationDependencies = {},
): Promise<ClaudeCodeIntegrationStatus & {
  changed?: boolean;
  removed?: boolean;
  backup?: string | null;
}> {
  if (!standalone) {
    throw new Error(
      "Claude Code integration must be configured from a standalone Afternote artifact",
    );
  }
  if (action === "rotate-identity") {
    throw new Error("Claude Code identity rotation must be routed separately");
  }
  const afternoteCommand = dependencies.afternoteCommand ??
    installedAfternoteCommand();
  const claudeCommand = dependencies.toolCommand === undefined
    ? resolveClaudeCodeCommand()
    : dependencies.toolCommand;
  if (!claudeCommand) {
    if (action === "status") {
      return {
        format: "afternote-claude-code-integration",
        schemaVersion: 3,
        toolAvailable: false,
        installed: false,
        healthy: false,
        configHealthy: false,
        identityHealthy: false,
        runtimeHealthy: false,
        repairable: false,
        problemCode: null,
        scope: "user",
        command: afternoteCommand,
        args: ["mcp", "--client", "claude"],
      };
    }
    throw new Error(
      "Afternote requires the signed native Claude Code build; npm scripts and wrapper processes are not supported. Install Anthropic's native build, then try again.",
    );
  }
  const readServer = dependencies.readServer ?? readClaudeCodeServer;
  const probeRuntime = dependencies.probeRuntime ?? probeMcpRuntime;
  const probeIdentity = dependencies.probeIdentity ?? (() => true);
  const runTool = dependencies.runTool ?? ((args: readonly string[]) =>
    runClaude(claudeCommand, [...args]));
  const current = readServer();
  const status = configurationStatus(current, afternoteCommand);
  const legacyOwned = isOwnedLegacyClaudeCodeServer(current, afternoteCommand);
  const classified = classifyConfiguration(status, current, legacyOwned);

  if (action === "status") {
    return await withRuntimeStatus(classified, probeRuntime, probeIdentity);
  }

  if (action === "install") {
    if (current && !classified.configHealthy && !legacyOwned) {
      throw new Error(
        "Claude Code already has a different MCP server named afternote; remove or rename it before installing",
      );
    }
    if (classified.configHealthy) {
      const validated = await withRuntimeStatus(
        classified,
        probeRuntime,
        probeIdentity,
      );
      if (!validated.healthy) {
        throw new Error(
          "Claude Code has the expected Afternote entry, but its MCP runtime validation failed",
        );
      }
      return { ...validated, changed: false, backup: null };
    }

    if (!await integrationIdentityIsHealthy(probeIdentity)) {
      throw new Error("Afternote client signing identity is unavailable");
    }
    try {
      if (legacyOwned) {
        runTool([
          "mcp",
          "remove",
          "--scope",
          "user",
          CLAUDE_SERVER_NAME,
        ]);
      }
      runTool([
        "mcp",
        "add",
        "--scope",
        "user",
        CLAUDE_SERVER_NAME,
        "--",
        afternoteCommand,
        "mcp",
        "--client",
        "claude",
      ]);
      const installedServer = readServer();
      const installed = await withRuntimeStatus(
        classifyConfiguration(
          configurationStatus(installedServer, afternoteCommand),
          installedServer,
          false,
        ),
        probeRuntime,
        probeIdentity,
      );
      if (!installed.healthy) {
        throw new Error(
          `Claude Code did not retain a healthy Afternote MCP configuration (config=${installed.configHealthy}, runtime=${installed.runtimeHealthy})`,
        );
      }
      return { ...installed, changed: true, backup: null };
    } catch (error) {
      try {
        restoreClaudeCodeEntry(current, readServer, afternoteCommand, runTool);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Claude Code installation failed and its Afternote entry could not be rolled back safely",
        );
      }
      throw error;
    }
  }

  if (!current) return { ...classified, removed: false, backup: null };
  if (!classified.configHealthy) {
    throw new Error(
      "Refusing to remove a Claude Code MCP server that is not owned by this Afternote installation",
    );
  }
  try {
    runTool([
      "mcp",
      "remove",
      "--scope",
      "user",
      CLAUDE_SERVER_NAME,
    ]);
    const removedServer = readServer();
    const removed = classifyConfiguration(
      configurationStatus(removedServer, afternoteCommand),
      removedServer,
      false,
    );
    if (removed.installed) {
      throw new Error(
        "Claude Code still reports the Afternote MCP server after removal",
      );
    }
    return { ...removed, removed: true, backup: null };
  } catch (error) {
    try {
      restoreClaudeCodeEntry(current, readServer, afternoteCommand, runTool);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Claude Code removal failed and its Afternote entry could not be rolled back safely",
      );
    }
    throw error;
  }
}

export function resolveClaudeCodeCommand(options: {
  pathCommand?: string | null;
  candidates?: readonly string[];
  verifyCommand?: (command: string) => string;
} = {}): string | null {
  const pathCommand = options.pathCommand === undefined
    ? Bun.which("claude")
    : options.pathCommand;
  const candidates = [
    pathCommand,
    ...(options.candidates ?? [
      join(homedir(), ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]),
  ];
  const verifyCommand = options.verifyCommand ??
    ((command: string) => verifyIntegrationHostCommand("Claude Code", command));
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      return verifyCommand(candidate);
    } catch {
      // Ignore executable lookalikes that do not match the Claude Code publisher.
    }
  }
  return null;
}

export function isOwnedLegacyClaudeCodeServer(
  server: ClaudeCodeServer | null,
  afternoteCommand: string,
): boolean {
  return server?.type === "stdio" &&
    server.command === afternoteCommand &&
    server.args?.length === 1 &&
    server.args[0] === "mcp" &&
    (server.env === undefined || Object.keys(server.env).length === 0);
}

function configurationStatus(
  server: ClaudeCodeServer | null,
  afternoteCommand: string,
): ClaudeCodeIntegrationStatus {
  const installed = server !== null;
  const configHealthy =
    server?.type === "stdio" &&
    server.command === afternoteCommand &&
    server.args?.length === 3 &&
    server.args[0] === "mcp" &&
    server.args[1] === "--client" &&
    server.args[2] === "claude";
  return {
    format: "afternote-claude-code-integration",
    schemaVersion: 3,
    toolAvailable: true,
    installed,
    healthy: false,
    configHealthy,
    identityHealthy: false,
    runtimeHealthy: false,
    repairable: !installed,
    problemCode: installed ? "connector_conflict" : "connector_missing",
    scope: "user",
    command: afternoteCommand,
    args: ["mcp", "--client", "claude"],
  };
}

function classifyConfiguration(
  status: ClaudeCodeIntegrationStatus,
  server: ClaudeCodeServer | null,
  legacyOwned: boolean,
): ClaudeCodeIntegrationStatus {
  if (status.configHealthy) {
    return { ...status, repairable: false, problemCode: null };
  }
  if (legacyOwned) {
    return { ...status, repairable: true, problemCode: "connector_legacy" };
  }
  if (server !== null) {
    return { ...status, repairable: false, problemCode: "connector_conflict" };
  }
  return { ...status, repairable: true, problemCode: "connector_missing" };
}

async function withRuntimeStatus(
  status: ClaudeCodeIntegrationStatus,
  probeRuntime: (
    command: string,
    args: readonly string[],
  ) => Promise<boolean>,
  probeIdentity: () => boolean | Promise<boolean>,
): Promise<ClaudeCodeIntegrationStatus> {
  if (!status.configHealthy) return status;
  if (!await integrationIdentityIsHealthy(probeIdentity)) {
    return {
      ...status,
      healthy: false,
      identityHealthy: false,
      runtimeHealthy: false,
      repairable: false,
      problemCode: "identity_unavailable",
    };
  }
  const runtimeHealthy = await probeRuntime(status.command, status.args);
  return {
    ...status,
    healthy: runtimeHealthy,
    identityHealthy: true,
    runtimeHealthy,
    repairable: false,
    problemCode: runtimeHealthy ? null : "runtime_unavailable",
  };
}

function readClaudeCodeServer(): ClaudeCodeServer | null {
  const path = claudeCodeConfigPath();
  if (!existsSync(path)) return null;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("Claude Code configuration is not valid JSON", {
      cause: error,
    });
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Claude Code configuration must be a JSON object");
  }
  const server = (config as ClaudeCodeConfig).mcpServers?.[CLAUDE_SERVER_NAME];
  if (server === undefined) return null;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("Claude Code Afternote MCP configuration is invalid");
  }
  return server;
}

function runClaude(claudeCommand: string, args: string[]): void {
  runIntegrationHostCommand("Claude Code", claudeCommand, args);
}

function restoreClaudeCodeEntry(
  previous: ClaudeCodeServer | null,
  readServer: () => ClaudeCodeServer | null,
  afternoteCommand: string,
  runTool: (args: readonly string[]) => void,
): void {
  const current = readServer();
  if (JSON.stringify(current) === JSON.stringify(previous)) return;
  if (
    current &&
    !configurationStatus(current, afternoteCommand).configHealthy &&
    !isOwnedLegacyClaudeCodeServer(current, afternoteCommand)
  ) {
    throw new Error(
      "Claude Code configuration changed concurrently; the unrelated entry was preserved",
    );
  }
  if (current) {
    runTool([
      "mcp",
      "remove",
      "--scope",
      "user",
      CLAUDE_SERVER_NAME,
    ]);
  }
  if (!previous) return;
  if (!previous.command || !Array.isArray(previous.args)) {
    throw new Error("The previous Claude Code Afternote entry cannot be restored safely");
  }
  runTool([
    "mcp",
    "add",
    "--scope",
    "user",
    CLAUDE_SERVER_NAME,
    "--",
    previous.command,
    ...previous.args,
  ]);
}

function claudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}
