import {
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installedAfternoteCommand, probeMcpRuntime } from "./connector-runtime";
import {
  runIntegrationHostCommand,
  verifyIntegrationHostCommand,
} from "./integration-host-command";
import { integrationIdentityIsHealthy } from "./integration-identity";
import {
  manageConnectorLifecycle,
  type ConnectorHostAdapter,
} from "./connector-lifecycle";

const CLAUDE_SERVER_NAME = "afternote-claude-code";
const LEGACY_CLAUDE_SERVER_NAME = "afternote";

export type ClaudeCodeIntegrationAction =
  | "install"
  | "status"
  | "remove"
  | "rotate-identity"
  | "prepare-reconnect";

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
  readLegacyServer?: () => ClaudeCodeServer | null;
  probeRuntime?: (command: string, args: readonly string[]) => Promise<boolean>;
  probeIdentity?: () => boolean | Promise<boolean>;
  runTool?: (args: readonly string[]) => void;
};

export function createClaudeCodeConnectorAdapter(
  dependencies: ClaudeCodeIntegrationDependencies = {},
): ConnectorHostAdapter<ClaudeCodeRegistrations, ClaudeCodeIntegrationStatus> {
  const afternoteCommand = dependencies.afternoteCommand ??
    installedAfternoteCommand();
  const toolCommand = dependencies.toolCommand === undefined
    ? resolveClaudeCodeCommand()
    : dependencies.toolCommand;
  const readServer = dependencies.readServer ?? (() =>
    readClaudeCodeServer(CLAUDE_SERVER_NAME));
  const readLegacyServer = dependencies.readLegacyServer ??
    (dependencies.readServer
      ? () => null
      : () => readClaudeCodeServer(LEGACY_CLAUDE_SERVER_NAME));
  const probeRuntime = dependencies.probeRuntime ?? probeMcpRuntime;
  const probeIdentity = dependencies.probeIdentity ?? (() => true);
  const runTool = dependencies.runTool ?? ((args: readonly string[]) => {
    if (!toolCommand) throw new Error("Claude Code CLI is unavailable");
    runClaude(toolCommand, [...args]);
  });
  const readConfiguration = (): ClaudeCodeRegistrations | null => {
    const current = readServer();
    const legacy = readLegacyServer();
    return current || legacy ? { current, legacy } : null;
  };
  const status = (registrations: ClaudeCodeRegistrations | null) =>
    classifyRegistrations(registrations, afternoteCommand);
  return {
    displayName: "Claude Code",
    afternoteCommand,
    toolCommand,
    unavailableError:
      "Afternote requires the signed native Claude Code build; npm scripts and wrapper processes are not supported. Install Anthropic's native build, then try again.",
    conflictError:
      "Claude Code has an Afternote MCP registration that this installation does not own; remove or rename it before installing",
    removalRefusedError:
      "Refusing to remove a Claude Code MCP server that is not owned by this Afternote installation",
    stillInstalledError:
      "Claude Code still reports the Afternote MCP server after removal",
    installRollbackError:
      "Claude Code installation failed and its Afternote entry could not be rolled back safely",
    removalRollbackError:
      "Claude Code removal failed and its Afternote entry could not be rolled back safely",
    unavailableStatus: () => ({
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
    }),
    readConfiguration,
    status,
    isOwnedLegacy: (registrations) =>
      registrations !== null &&
      classifyRegistrations(registrations, afternoteCommand).problemCode ===
        "connector_legacy",
    withRuntimeStatus: (value) =>
      withRuntimeStatus(value, probeRuntime, probeIdentity),
    existingConfigurationError: () =>
      "Claude Code has the expected Afternote entry, but its MCP runtime validation failed",
    installedConfigurationError: (value) =>
      `Claude Code did not retain a healthy Afternote MCP configuration (config=${value.configHealthy}, runtime=${value.runtimeHealthy})`,
    add: () => runTool([
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
    ]),
    remove: (registrations) => removeOwnedClaudeCodeEntries(
      registrations,
      afternoteCommand,
      runTool,
    ),
    restore: (previous) => restoreClaudeCodeEntries(
      previous,
      readServer,
      readLegacyServer,
      afternoteCommand,
      runTool,
    ),
    identityIsHealthy: () => Promise.resolve(probeIdentity()),
  };
}

export function parseClaudeCodeIntegrationAction(
  action: string | undefined,
): ClaudeCodeIntegrationAction {
  if (
    action === "install" ||
    action === "status" ||
    action === "remove" ||
    action === "rotate-identity" ||
    action === "prepare-reconnect"
  ) {
    return action;
  }
  throw new Error(
    "Claude Code action must be install, status, remove, rotate-identity, or prepare-reconnect",
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
  if (action === "rotate-identity" || action === "prepare-reconnect") {
    throw new Error("Claude Code identity rotation must be routed separately");
  }
  if (!standalone) {
    throw new Error(
      "Claude Code integration must be configured from a standalone Afternote artifact",
    );
  }
  return manageConnectorLifecycle(
    action,
    standalone,
    createClaudeCodeConnectorAdapter(dependencies),
  );
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

function isOwnedClaudeCodeServer(
  server: ClaudeCodeServer | null,
  afternoteCommand: string,
): boolean {
  return isOwnedLegacyClaudeCodeServer(server, afternoteCommand) ||
    server?.type === "stdio" &&
      server.command === afternoteCommand &&
      server.args?.length === 3 &&
      server.args[0] === "mcp" &&
      server.args[1] === "--client" &&
      server.args[2] === "claude" &&
      (server.env === undefined || Object.keys(server.env).length === 0);
}

type ClaudeCodeRegistrations = {
  current: ClaudeCodeServer | null;
  legacy: ClaudeCodeServer | null;
};

function classifyRegistrations(
  registrations: ClaudeCodeRegistrations | null,
  afternoteCommand: string,
): ClaudeCodeIntegrationStatus {
  if (!registrations) return classifyConfiguration(
    configurationStatus(null, afternoteCommand),
    null,
    false,
  );
  const { current, legacy } = registrations;
  const currentStatus = configurationStatus(current, afternoteCommand);
  const currentOwned = isOwnedClaudeCodeServer(current, afternoteCommand);
  const legacyOwned = isOwnedClaudeCodeServer(legacy, afternoteCommand);
  if (
    (current && !currentOwned) ||
    (legacy && !legacyOwned)
  ) {
    return {
      ...currentStatus,
      installed: true,
      configHealthy: false,
      repairable: false,
      problemCode: "connector_conflict",
    };
  }
  if (legacy || (current && !currentStatus.configHealthy)) {
    return {
      ...currentStatus,
      installed: true,
      configHealthy: false,
      repairable: true,
      problemCode: "connector_legacy",
    };
  }
  return classifyConfiguration(currentStatus, current, false);
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

function readClaudeCodeServer(serverName: string): ClaudeCodeServer | null {
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
  const server = (config as ClaudeCodeConfig).mcpServers?.[serverName];
  if (server === undefined) return null;
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    throw new Error("Claude Code Afternote MCP configuration is invalid");
  }
  return server;
}

function runClaude(claudeCommand: string, args: string[]): void {
  runIntegrationHostCommand("Claude Code", claudeCommand, args);
}

function removeOwnedClaudeCodeEntries(
  registrations: ClaudeCodeRegistrations,
  afternoteCommand: string,
  runTool: (args: readonly string[]) => void,
): void {
  for (const [name, server] of [
    [LEGACY_CLAUDE_SERVER_NAME, registrations.legacy],
    [CLAUDE_SERVER_NAME, registrations.current],
  ] as const) {
    if (!server) continue;
    if (!isOwnedClaudeCodeServer(server, afternoteCommand)) {
      throw new Error("Refusing to remove an unowned Claude Code MCP server");
    }
    runTool(["mcp", "remove", "--scope", "user", name]);
  }
}

function restoreClaudeCodeEntries(
  previous: ClaudeCodeRegistrations | null,
  readServer: () => ClaudeCodeServer | null,
  readLegacyServer: () => ClaudeCodeServer | null,
  afternoteCommand: string,
  runTool: (args: readonly string[]) => void,
): void {
  const current: ClaudeCodeRegistrations = {
    current: readServer(),
    legacy: readLegacyServer(),
  };
  for (const [name, present, expected] of [
    [CLAUDE_SERVER_NAME, current.current, previous?.current ?? null],
    [LEGACY_CLAUDE_SERVER_NAME, current.legacy, previous?.legacy ?? null],
  ] as const) {
    if (JSON.stringify(present) === JSON.stringify(expected)) continue;
    if (present && !isOwnedClaudeCodeServer(present, afternoteCommand)) {
      throw new Error(
        "Claude Code configuration changed concurrently; the unrelated entry was preserved",
      );
    }
    if (present) {
      runTool(["mcp", "remove", "--scope", "user", name]);
    }
    if (!expected) continue;
    if (!expected.command || !Array.isArray(expected.args)) {
      throw new Error("The previous Claude Code Afternote entry cannot be restored safely");
    }
    runTool([
      "mcp",
      "add",
      "--scope",
      "user",
      name,
      "--",
      expected.command,
      ...expected.args,
    ]);
  }
}

function claudeCodeConfigPath(): string {
  return join(homedir(), ".claude.json");
}
