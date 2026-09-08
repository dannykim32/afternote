import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  probeCodexMcpReadiness,
  type CodexMcpReadiness,
} from "./codex-mcp-readiness";
import {
  runIntegrationHostCommand,
  verifyIntegrationHostCommand,
} from "./integration-host-command";
import { integrationIdentityIsHealthy } from "./integration-identity";
import { installedAfternoteCommand } from "./connector-runtime";
import {
  manageConnectorLifecycle,
  type ConnectorHostAdapter,
} from "./connector-lifecycle";

const CODEX_SERVER_NAME = "afternote";

export type CodexIntegrationAction =
  | "install"
  | "status"
  | "remove"
  | "rotate-identity";

export type CodexServer = {
  name: string;
  enabled?: boolean;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
  };
};

export type CodexIntegrationProblemCode =
  | "connector_missing"
  | "connector_legacy"
  | "connector_conflict"
  | "identity_unavailable"
  | "runtime_unavailable"
  | null;

export type CodexIntegrationStatus = {
  format: "afternote-codex-integration";
  schemaVersion: 4;
  toolAvailable: boolean;
  installed: boolean;
  healthy: boolean;
  configHealthy: boolean;
  identityHealthy: boolean;
  runtimeHealthy: boolean;
  repairable: boolean;
  problemCode: CodexIntegrationProblemCode;
  readiness: CodexMcpReadiness | null;
  command: string;
  args: ["mcp", "--client", "codex"];
};

export type CodexIntegrationDependencies = {
  afternoteCommand?: string;
  toolCommand?: string | null;
  readServer?: (toolCommand: string) => CodexServer | null;
  probeReadiness?: (toolCommand: string) => Promise<CodexMcpReadiness>;
  probeIdentity?: () => boolean | Promise<boolean>;
  runTool?: (args: readonly string[]) => void;
};

export function createCodexConnectorAdapter(
  dependencies: CodexIntegrationDependencies = {},
): ConnectorHostAdapter<CodexServer, CodexIntegrationStatus> {
  const afternoteCommand = dependencies.afternoteCommand ??
    installedAfternoteCommand();
  const toolCommand = dependencies.toolCommand === undefined
    ? resolveCodexCommand()
    : dependencies.toolCommand;
  const readServer = dependencies.readServer ?? readCodexServer;
  const probeReadiness = dependencies.probeReadiness ?? probeCodexMcpReadiness;
  const probeIdentity = dependencies.probeIdentity ?? (() => true);
  const runTool = dependencies.runTool ?? ((args: readonly string[]) => {
    if (!toolCommand) throw new Error("Codex CLI is unavailable");
    runCodex(toolCommand, [...args]);
  });
  const readConfiguration = () => toolCommand ? readServer(toolCommand) : null;
  const status = (server: CodexServer | null) =>
    classifyConfiguration(
      configurationStatus(server, afternoteCommand),
      server,
      isOwnedLegacyServer(server, afternoteCommand),
    );
  return {
    displayName: "Codex",
    afternoteCommand,
    toolCommand,
    unavailableError:
      "Afternote requires the signed native Codex build; npm scripts and wrapper processes are not supported. Install the official Codex or ChatGPT app, then try again.",
    conflictError:
      "Codex already has a different MCP server named afternote; remove or rename it before installing",
    removalRefusedError:
      "Refusing to remove a Codex MCP server that is not owned by this Afternote installation",
    stillInstalledError: "Codex still reports the Afternote MCP server after removal",
    installRollbackError:
      "Codex installation failed and its Afternote entry could not be rolled back safely",
    removalRollbackError:
      "Codex removal failed and its Afternote entry could not be rolled back safely",
    unavailableStatus: () => ({
      format: "afternote-codex-integration",
      schemaVersion: 4,
      toolAvailable: false,
      installed: false,
      healthy: false,
      configHealthy: false,
      identityHealthy: false,
      runtimeHealthy: false,
      repairable: false,
      problemCode: null,
      readiness: null,
      command: afternoteCommand,
      args: ["mcp", "--client", "codex"],
    }),
    readConfiguration,
    status,
    isOwnedLegacy: (server) => isOwnedLegacyServer(server, afternoteCommand),
    withRuntimeStatus: (value) => {
      if (!toolCommand) return Promise.resolve(value);
      return withRuntimeStatus(value, toolCommand, probeReadiness, probeIdentity);
    },
    existingConfigurationError: (value) => readinessFailure(
      "Codex has the expected Afternote entry, but its MCP startup validation failed",
      value.readiness,
    ),
    installedConfigurationError: (value) => readinessFailure(
      "Codex did not retain a working Afternote MCP configuration",
      value.readiness,
    ),
    add: () => runTool([
      "mcp",
      "add",
      CODEX_SERVER_NAME,
      "--",
      afternoteCommand,
      "mcp",
      "--client",
      "codex",
    ]),
    remove: () => runTool(["mcp", "remove", CODEX_SERVER_NAME]),
    restore: (previous) => {
      if (!toolCommand) throw new Error("Codex CLI is unavailable");
      restoreCodexEntry(
        toolCommand,
        previous,
        readServer,
        afternoteCommand,
        runTool,
      );
    },
    identityIsHealthy: () => Promise.resolve(probeIdentity()),
  };
}

export function parseCodexIntegrationAction(
  action: string | undefined,
): CodexIntegrationAction {
  if (
    action === "install" ||
    action === "status" ||
    action === "remove" ||
    action === "rotate-identity"
  ) {
    return action;
  }
  throw new Error(
    "Codex action must be install, status, remove, or rotate-identity",
  );
}

export async function manageCodexIntegration(
  action: CodexIntegrationAction,
  standalone: boolean,
  dependencies: CodexIntegrationDependencies = {},
): Promise<CodexIntegrationStatus & {
  changed?: boolean;
  removed?: boolean;
  backup?: string | null;
}> {
  if (action === "rotate-identity") {
    throw new Error("Codex identity rotation must be routed separately");
  }
  return manageConnectorLifecycle(
    action,
    standalone,
    createCodexConnectorAdapter(dependencies),
  );
}

export function resolveCodexCommand(options: {
  pathCommand?: string | null;
  desktopCandidates?: readonly string[];
  verifyCommand?: (command: string) => string;
} = {}): string | null {
  const pathCommand = options.pathCommand === undefined
    ? Bun.which("codex")
    : options.pathCommand;
  const verifyCommand = options.verifyCommand ??
    ((command: string) => verifyIntegrationHostCommand("Codex", command));
  if (pathCommand && isExecutableFile(pathCommand)) {
    try {
      return verifyCommand(pathCommand);
    } catch {
      // Continue to publisher-verified desktop candidates.
    }
  }
  const candidates = options.desktopCandidates ?? codexCommandCandidates();
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate)) continue;
    try {
      return verifyCommand(candidate);
    } catch {
      // Ignore executable lookalikes that do not match the Codex publisher.
    }
  }
  return null;
}

export function codexCommandCandidates(homeDirectory = homedir()): string[] {
  return [
    join(homeDirectory, ".local/bin/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    join(homeDirectory, "Applications/ChatGPT.app/Contents/Resources/codex"),
    join(homeDirectory, "Applications/Codex.app/Contents/Resources/codex"),
  ];
}

function isExecutableFile(path: string): boolean {
  try {
    const resolved = realpathSync.native(path);
    if (!statSync(resolved).isFile()) return false;
    accessSync(resolved, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isOwnedLegacyServer(
  server: CodexServer | null,
  afternoteCommand: string,
): boolean {
  return server?.enabled !== false &&
    server?.transport?.type === "stdio" &&
    server.transport.command === afternoteCommand &&
    server.transport.args?.length === 1 &&
    server.transport.args[0] === "mcp";
}

function configurationStatus(
  server: CodexServer | null,
  afternoteCommand: string,
): CodexIntegrationStatus {
  const installed = server !== null;
  const configHealthy =
    server?.enabled !== false &&
    server?.transport?.type === "stdio" &&
    server.transport.command === afternoteCommand &&
    server.transport.args?.length === 3 &&
    server.transport.args[0] === "mcp" &&
    server.transport.args[1] === "--client" &&
    server.transport.args[2] === "codex";
  return {
    format: "afternote-codex-integration",
    schemaVersion: 4,
    toolAvailable: true,
    installed,
    healthy: false,
    configHealthy,
    identityHealthy: false,
    runtimeHealthy: false,
    repairable: !installed,
    problemCode: installed ? "connector_conflict" : "connector_missing",
    readiness: null,
    command: afternoteCommand,
    args: ["mcp", "--client", "codex"],
  };
}

function classifyConfiguration(
  status: CodexIntegrationStatus,
  server: CodexServer | null,
  legacyOwned: boolean,
): CodexIntegrationStatus {
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
  status: CodexIntegrationStatus,
  codexCommand: string,
  probeReadiness: (toolCommand: string) => Promise<CodexMcpReadiness>,
  probeIdentity: () => boolean | Promise<boolean>,
): Promise<CodexIntegrationStatus> {
  if (!status.configHealthy) return status;
  if (!await integrationIdentityIsHealthy(probeIdentity)) {
    return {
      ...status,
      healthy: false,
      identityHealthy: false,
      runtimeHealthy: false,
      repairable: false,
      problemCode: "identity_unavailable",
      readiness: null,
    };
  }
  const readiness = await probeReadiness(codexCommand);
  return {
    ...status,
    healthy: readiness.healthy,
    identityHealthy: true,
    runtimeHealthy: readiness.healthy,
    repairable: false,
    problemCode: readiness.healthy ? null : "runtime_unavailable",
    readiness,
  };
}

function readinessFailure(
  prefix: string,
  readiness: CodexMcpReadiness | null,
): string {
  return readiness?.error ? `${prefix}: ${readiness.error.message}` : prefix;
}


function readCodexServer(codexCommand: string): CodexServer | null {
  const output = runCodex(codexCommand, ["mcp", "list", "--json"]);
  let servers: unknown;
  try {
    servers = JSON.parse(output);
  } catch (error) {
    throw new Error("Codex returned an invalid MCP configuration report", {
      cause: error,
    });
  }
  if (!Array.isArray(servers)) {
    throw new Error("Codex returned an invalid MCP configuration report");
  }
  const server = servers.find(
    (candidate): candidate is CodexServer =>
      typeof candidate === "object" &&
      candidate !== null &&
      "name" in candidate &&
      candidate.name === CODEX_SERVER_NAME,
  );
  return server ?? null;
}

function runCodex(codexCommand: string, args: string[]): string {
  return runIntegrationHostCommand("Codex", codexCommand, args);
}

function restoreCodexEntry(
  codexCommand: string,
  previous: CodexServer | null,
  readServer: (toolCommand: string) => CodexServer | null,
  afternoteCommand: string,
  runTool: (args: readonly string[]) => void,
): void {
  const current = readServer(codexCommand);
  if (JSON.stringify(current) === JSON.stringify(previous)) return;
  if (
    current &&
    !configurationStatus(current, afternoteCommand).configHealthy &&
    !isOwnedLegacyServer(current, afternoteCommand)
  ) {
    throw new Error(
      "Codex configuration changed concurrently; the unrelated entry was preserved",
    );
  }
  if (current) runTool(["mcp", "remove", CODEX_SERVER_NAME]);
  if (!previous) return;
  const command = previous.transport?.command;
  const args = previous.transport?.args;
  if (!command || !Array.isArray(args)) {
    throw new Error("The previous Codex Afternote entry cannot be restored safely");
  }
  runTool([
    "mcp",
    "add",
    CODEX_SERVER_NAME,
    "--",
    command,
    ...args,
  ]);
}
