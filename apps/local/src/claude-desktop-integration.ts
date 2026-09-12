import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_DESKTOP_EXTENSION_ID,
  CLAUDE_DESKTOP_MANIFEST_VERSION,
  claudeDesktopLauncher,
  createClaudeDesktopPackage,
} from "./claude-desktop-package";
import { installedAfternoteCommand, probeMcpRuntime } from "./connector-runtime";
import { verifyIntegrationHostCommand } from "./integration-host-command";
import { integrationIdentityIsHealthy } from "./integration-identity";

export { CLAUDE_DESKTOP_EXTENSION_ID, createClaudeDesktopPackage };

export type ClaudeDesktopIntegrationAction =
  | "install"
  | "status"
  | "remove"
  | "rotate-identity";

export type ClaudeDesktopIntegrationProblemCode =
  | "connector_missing"
  | "connector_disabled"
  | "connector_conflict"
  | "identity_unavailable"
  | "runtime_unavailable"
  | null;

export type ClaudeDesktopIntegrationStatus = {
  format: "afternote-claude-desktop-integration";
  schemaVersion: 1;
  toolAvailable: boolean;
  installed: boolean;
  healthy: boolean;
  configHealthy: boolean;
  identityHealthy: boolean;
  runtimeHealthy: boolean;
  repairable: boolean;
  problemCode: ClaudeDesktopIntegrationProblemCode;
  approvalRequired: boolean;
  extensionId: typeof CLAUDE_DESKTOP_EXTENSION_ID;
  command: string;
  args: ["mcp", "--client", "claude-desktop"];
};

export type ClaudeDesktopIntegrationDependencies = {
  afternoteCommand?: string;
  packageVersion?: string;
  homeDirectory?: string;
  resolveApplication?: () => string | null;
  probeRuntime?: (command: string, args: readonly string[]) => Promise<boolean>;
  probeIdentity?: () => boolean | Promise<boolean>;
  openPackage?: (application: string, packagePath: string) => void;
};

export function parseClaudeDesktopIntegrationAction(
  action: string | undefined,
): ClaudeDesktopIntegrationAction {
  if (
    action === "install" ||
    action === "status" ||
    action === "remove" ||
    action === "rotate-identity"
  ) return action;
  throw new Error(
    "Claude Desktop action must be install, status, remove, or rotate-identity",
  );
}

export async function manageClaudeDesktopIntegration(
  action: ClaudeDesktopIntegrationAction,
  standalone: boolean,
  dependencies: ClaudeDesktopIntegrationDependencies = {},
): Promise<ClaudeDesktopIntegrationStatus & {
  changed?: boolean;
  removed?: boolean;
  packagePath?: string;
}> {
  if (action === "rotate-identity") {
    throw new Error("Claude Desktop identity rotation must be routed separately");
  }
  if (!standalone) {
    throw new Error(
      "Claude Desktop integration must be configured from a standalone Afternote artifact",
    );
  }
  const afternoteCommand = dependencies.afternoteCommand ??
    installedAfternoteCommand();
  const packageVersion = dependencies.packageVersion ?? "0.0.0";
  const homeDirectory = dependencies.homeDirectory ?? homedir();
  const resolveApplication = dependencies.resolveApplication ??
    (() => resolveClaudeDesktopApplication({ homeDirectory }));
  const application = resolveApplication();
  const status = classifyClaudeDesktopInstallation({
    afternoteCommand,
    homeDirectory,
    toolAvailable: application !== null,
  });

  if (action === "status") {
    return await withRuntimeStatus(status, dependencies);
  }
  if (action === "remove") {
    throw new Error(
      "Open Settings > Extensions in Claude Desktop and remove Afternote there, then check again in Afternote",
    );
  }
  if (!application) {
    throw new Error(
      "Afternote requires the signed Claude Desktop app from Anthropic; install or update Claude, then try again",
    );
  }
  if (status.installed) {
    if (!status.configHealthy) {
      throw new Error(
        "Claude Desktop already has an Afternote extension that this installation will not overwrite; review or remove it in Claude Desktop first",
      );
    }
    const validated = await withRuntimeStatus(status, dependencies);
    if (!validated.healthy) {
      throw new Error(
        "Claude Desktop has the expected Afternote extension, but its local runtime validation failed",
      );
    }
    return { ...validated, changed: false };
  }
  if (!await integrationIdentityIsHealthy(dependencies.probeIdentity ?? (() => true))) {
    throw new Error("Afternote client signing identity is unavailable");
  }
  const packagePath = claudeDesktopPackagePath(homeDirectory, packageVersion);
  createClaudeDesktopPackage({
    afternoteCommand,
    packageVersion,
    destination: packagePath,
  });
  (dependencies.openPackage ?? openClaudeDesktopPackage)(application, packagePath);
  return {
    ...status,
    identityHealthy: true,
    approvalRequired: true,
    changed: true,
    packagePath,
  };
}

export function resolveClaudeDesktopApplication(options: {
  homeDirectory?: string;
  candidates?: readonly string[];
  verifyCommand?: typeof verifyIntegrationHostCommand;
} = {}): string | null {
  const homeDirectory = options.homeDirectory ?? homedir();
  const candidates = options.candidates ?? [
    "/Applications/Claude.app",
    join(homeDirectory, "Applications", "Claude.app"),
  ];
  const verifyCommand = options.verifyCommand ?? verifyIntegrationHostCommand;
  for (const candidate of candidates) {
    try {
      const applicationInfo = lstatSync(candidate);
      if (!applicationInfo.isDirectory() || applicationInfo.isSymbolicLink()) continue;
      const application = realpathSync.native(candidate);
      const executable = join(application, "Contents", "MacOS", "Claude");
      verifyCommand("Claude Desktop", executable);
      return application;
    } catch {
      // Ignore unsigned lookalikes and continue to the next standard location.
    }
  }
  return null;
}

function classifyClaudeDesktopInstallation(options: {
  afternoteCommand: string;
  homeDirectory: string;
  toolAvailable: boolean;
}): ClaudeDesktopIntegrationStatus {
  const extensionPath = claudeDesktopExtensionPath(options.homeDirectory);
  const installed = existsSync(extensionPath);
  const owned = installed && extensionIsOwned(extensionPath, options.afternoteCommand);
  const enabled = owned && extensionIsEnabled(options.homeDirectory);
  const configHealthy = owned && enabled;
  const problemCode: ClaudeDesktopIntegrationProblemCode = !installed
    ? "connector_missing"
    : !owned
    ? "connector_conflict"
    : !enabled
    ? "connector_disabled"
    : null;
  return {
    format: "afternote-claude-desktop-integration",
    schemaVersion: 1,
    toolAvailable: options.toolAvailable,
    installed,
    healthy: false,
    configHealthy,
    identityHealthy: false,
    runtimeHealthy: false,
    repairable: !installed || (owned && !enabled),
    problemCode,
    approvalRequired: false,
    extensionId: CLAUDE_DESKTOP_EXTENSION_ID,
    command: options.afternoteCommand,
    args: ["mcp", "--client", "claude-desktop"],
  };
}

async function withRuntimeStatus(
  status: ClaudeDesktopIntegrationStatus,
  dependencies: ClaudeDesktopIntegrationDependencies,
): Promise<ClaudeDesktopIntegrationStatus> {
  if (!status.configHealthy) return status;
  if (!await integrationIdentityIsHealthy(dependencies.probeIdentity ?? (() => true))) {
    return {
      ...status,
      problemCode: "identity_unavailable",
      identityHealthy: false,
    };
  }
  const runtimeHealthy = await (dependencies.probeRuntime ?? probeMcpRuntime)(
    status.command,
    status.args,
  );
  return {
    ...status,
    healthy: runtimeHealthy,
    identityHealthy: true,
    runtimeHealthy,
    problemCode: runtimeHealthy ? null : "runtime_unavailable",
  };
}

function extensionIsOwned(extensionPath: string, afternoteCommand: string): boolean {
  try {
    const root = lstatSync(extensionPath);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    const manifestPath = join(extensionPath, "manifest.json");
    const launcherPath = join(extensionPath, "bin", "afternote-launcher");
    const manifestInfo = lstatSync(manifestPath);
    const launcherInfo = lstatSync(launcherPath);
    if (
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink() ||
      !launcherInfo.isFile() ||
      launcherInfo.isSymbolicLink() ||
      (launcherInfo.mode & 0o111) === 0 ||
      manifestInfo.size > 64 * 1024 ||
      launcherInfo.size > 8 * 1024
    ) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      manifest_version?: unknown;
      name?: unknown;
      display_name?: unknown;
      author?: { name?: unknown };
      server?: {
        type?: unknown;
        entry_point?: unknown;
        mcp_config?: { command?: unknown; args?: unknown; env?: unknown };
      };
    };
    return manifest.manifest_version === CLAUDE_DESKTOP_MANIFEST_VERSION &&
      manifest.name === "afternote" &&
      manifest.display_name === "Afternote" &&
      manifest.author?.name === "Danny Kim" &&
      manifest.server?.type === "binary" &&
      manifest.server.entry_point === "bin/afternote-launcher" &&
      manifest.server.mcp_config?.command ===
        "${__dirname}/bin/afternote-launcher" &&
      manifest.server.mcp_config.args === undefined &&
      manifest.server.mcp_config.env === undefined &&
      readFileSync(launcherPath, "utf8") ===
        claudeDesktopLauncher(afternoteCommand);
  } catch {
    return false;
  }
}

function extensionIsEnabled(homeDirectory: string): boolean {
  const settingsPath = join(
    homeDirectory,
    "Library",
    "Application Support",
    "Claude",
    "Claude Extensions Settings",
    `${CLAUDE_DESKTOP_EXTENSION_ID}.json`,
  );
  try {
    const info = lstatSync(settingsPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return false;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      isEnabled?: unknown;
      orgBlockedReason?: unknown;
    };
    return settings.isEnabled === true && settings.orgBlockedReason === undefined;
  } catch {
    return false;
  }
}

function claudeDesktopExtensionPath(homeDirectory: string): string {
  return join(
    homeDirectory,
    "Library",
    "Application Support",
    "Claude",
    "Claude Extensions",
    CLAUDE_DESKTOP_EXTENSION_ID,
  );
}

function claudeDesktopPackagePath(
  homeDirectory: string,
  packageVersion: string,
): string {
  return join(
    homeDirectory,
    ".afternote",
    "connectors",
    `Afternote-${packageVersion}.mcpb`,
  );
}

function openClaudeDesktopPackage(application: string, packagePath: string): void {
  const result = Bun.spawnSync([
    "/usr/bin/open",
    "-a",
    application,
    packagePath,
  ], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error("Claude Desktop could not open the Afternote extension package");
  }
}
