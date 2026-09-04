import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  probeCodexMcpReadiness,
  type CodexMcpReadiness,
} from "./codex-mcp-readiness";
import {
  runIntegrationHostCommand,
  verifyIntegrationHostCommand,
} from "./integration-host-command";
import { integrationIdentityIsHealthy } from "./integration-identity";

const CODEX_SERVER_NAME = "afternote";
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;

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
  if (!standalone) {
    throw new Error(
      "Codex integration must be configured from a standalone Afternote artifact",
    );
  }
  if (action === "rotate-identity") {
    throw new Error("Codex identity rotation must be routed separately");
  }

  const afternoteCommand = dependencies.afternoteCommand ??
    installedAfternoteCommand();
  const codexCommand = dependencies.toolCommand === undefined
    ? resolveCodexCommand()
    : dependencies.toolCommand;
  if (!codexCommand) {
    if (action === "status") {
      return {
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
      };
    }
    throw new Error(
      "Codex CLI was not found on PATH or in the Codex desktop app. Install or open Codex, then try again.",
    );
  }
  const readServer = dependencies.readServer ?? readCodexServer;
  const probeReadiness = dependencies.probeReadiness ?? probeCodexMcpReadiness;
  const probeIdentity = dependencies.probeIdentity ?? (() => true);
  const runTool = dependencies.runTool ?? ((args: readonly string[]) =>
    runCodex(codexCommand, [...args]));
  const current = readServer(codexCommand);
  const status = configurationStatus(current, afternoteCommand);
  const legacyOwned = isOwnedLegacyServer(current, afternoteCommand);
  const classified = classifyConfiguration(status, current, legacyOwned);
  if (action === "status") {
    return await withRuntimeStatus(
      classified,
      codexCommand,
      probeReadiness,
      probeIdentity,
    );
  }

  if (action === "install") {
    if (current && !classified.configHealthy && !legacyOwned) {
      throw new Error(
        "Codex already has a different MCP server named afternote; remove or rename it before installing",
      );
    }
    if (classified.configHealthy) {
      const validated = await withRuntimeStatus(
        classified,
        codexCommand,
        probeReadiness,
        probeIdentity,
      );
      if (!validated.healthy) {
        throw new Error(
          readinessFailure(
            "Codex has the expected Afternote entry, but its MCP startup validation failed",
            validated.readiness,
          ),
        );
      }
      return {
        ...validated,
        changed: false,
        backup: null,
      };
    }

    if (!await integrationIdentityIsHealthy(probeIdentity)) {
      throw new Error("Afternote client signing identity is unavailable");
    }
    try {
      if (legacyOwned) {
        runTool(["mcp", "remove", CODEX_SERVER_NAME]);
      }
      runTool([
        "mcp",
        "add",
        CODEX_SERVER_NAME,
        "--",
        afternoteCommand,
        "mcp",
        "--client",
        "codex",
      ]);
      const installedServer = readServer(codexCommand);
      const installed = await withRuntimeStatus(
        classifyConfiguration(
          configurationStatus(installedServer, afternoteCommand),
          installedServer,
          false,
        ),
        codexCommand,
        probeReadiness,
        probeIdentity,
      );
      if (!installed.healthy) {
        throw new Error(
          readinessFailure(
            "Codex did not retain a working Afternote MCP configuration",
            installed.readiness,
          ),
        );
      }
      return { ...installed, changed: true, backup: null };
    } catch (error) {
      try {
        restoreCodexEntry(codexCommand, current, readServer, afternoteCommand, runTool);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Codex installation failed and its Afternote entry could not be rolled back safely",
        );
      }
      throw error;
    }
  }

  if (!current) {
    return { ...classified, removed: false, backup: null };
  }
  if (!classified.configHealthy) {
    throw new Error(
      "Refusing to remove a Codex MCP server that is not owned by this Afternote installation",
    );
  }
  try {
    runTool(["mcp", "remove", CODEX_SERVER_NAME]);
    const removedServer = readServer(codexCommand);
    const removed = classifyConfiguration(
      configurationStatus(removedServer, afternoteCommand),
      removedServer,
      false,
    );
    if (removed.installed) {
      throw new Error("Codex still reports the Afternote MCP server after removal");
    }
    return { ...removed, removed: true, backup: null };
  } catch (error) {
    try {
      restoreCodexEntry(codexCommand, current, readServer, afternoteCommand, runTool);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Codex removal failed and its Afternote entry could not be rolled back safely",
      );
    }
    throw error;
  }
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
  const candidates = options.desktopCandidates ?? [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    join(homedir(), "Applications/ChatGPT.app/Contents/Resources/codex"),
    join(homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ];
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

export function installedAfternoteCommand(): string {
  const installedLink = join(
    process.env.AFTERNOTE_BIN_ROOT ?? join(homedir(), ".local", "bin"),
    "afternote",
  );
  if (
    existsSync(installedLink) &&
    realpathSync.native(installedLink) === realpathSync.native(process.execPath)
  ) {
    return installedLink;
  }
  throw new Error(
    "Could not identify this Afternote installation; install Afternote Local first, then run the installed afternote command",
  );
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

export async function probeMcpRuntime(
  command: string,
  args: readonly string[],
): Promise<boolean> {
  void args;
  const healthcheck = process.env.AFTERNOTE_BROKER_HEALTHCHECK;
  const child = Bun.spawn(healthcheck ? [healthcheck] : [command, "broker-health"], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const exitCode = await withTimeout(child.exited, "health response");
    if (exitCode !== 0) return false;
    const output = await new Response(child.stdout).text();
    const health = JSON.parse(output) as {
      protocolVersion?: unknown;
      publicMetadata?: { transport?: unknown };
    };
    return health.protocolVersion === 1 &&
      health.publicMetadata?.transport === "launchd-mach-service";
  } catch {
    return false;
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Afternote MCP ${label} timed out`)),
          RUNTIME_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

function codexHome(): string {
  const configured = process.env.CODEX_HOME;
  if (!configured) return join(homedir(), ".codex");
  if (!isAbsolute(configured)) {
    throw new Error("CODEX_HOME must be absolute");
  }
  return resolve(configured);
}
