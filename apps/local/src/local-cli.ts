import { existsSync, lstatSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  manageCodexIntegration,
  parseCodexIntegrationAction,
} from "./codex-integration";
import { installedAfternoteCommand } from "./connector-runtime";
import {
  manageClaudeCodeIntegration,
  parseClaudeCodeIntegrationAction,
} from "./claude-code-integration";
import {
  manageClaudeDesktopConnector,
  parseClaudeDesktopConnectorAction,
} from "./claude-desktop-connector";
import { writeExclusivePrivateFile } from "./exclusive-export";
import { runRecallEvaluation } from "./recall-eval";
import { runOrganizationEvaluation } from "./organization-eval";
import type { TextEmbeddingModel } from "./retrieval";
import {
  probeMcpClientIdentity,
  vaultBrokerHealth,
  type McpBrokerClientKind,
} from "./vault-broker-client";
import { runBrokerMcpAdapter } from "./mcp-broker-adapter";
import {
  ensureMcpClientIdentity,
  rotateMcpClientIdentity,
  type McpClientIdentityKind,
  type McpClientRotationApproval,
} from "./mcp-client-identity";
import { assertLegacyRuntimeRetired } from "./legacy-runtime-retirement";
import localPackage from "../package.json";

declare const AFTERNOTE_BUILD_VERSION: string | undefined;
declare const AFTERNOTE_STANDALONE: boolean | undefined;
declare const AFTERNOTE_RELEASE_BUILD: boolean | undefined;

export const LOCAL_VERSION =
  typeof AFTERNOTE_BUILD_VERSION === "string"
    ? AFTERNOTE_BUILD_VERSION
    : `${localPackage.version}-dev`;

const isStandaloneArtifact =
  typeof AFTERNOTE_STANDALONE === "boolean" ? AFTERNOTE_STANDALONE : false;

export type LocalSemanticRuntime = {
  open(vaultPath: string): TextEmbeddingModel | null;
  status(vaultPath: string): unknown;
  acquire(vaultPath: string): Promise<unknown>;
  help: string;
};

export type PrivateCliCommand = (args: string[]) => Promise<boolean>;

export async function runLocalCli(
  args: string[],
  semanticRuntime?: LocalSemanticRuntime,
  privateCommand?: PrivateCliCommand,
): Promise<void> {
  if (await relaunchWithBundledLibraries(args, Boolean(semanticRuntime))) return;
  if (privateCommand && await privateCommand(args)) return;
  const command = args[0] ?? "mcp";

  switch (command) {
    case "mcp":
      await runMcp(args.slice(1));
      return;
    case "broker-health":
      console.log(JSON.stringify(vaultBrokerHealth()));
      return;
    case "connections":
      openNativeApplication("connections", args.slice(1));
      return;
    case "ui":
      openNativeApplication("library", args.slice(1));
      return;
    case "export":
      await exportVault(requiredPath(args[1], "export destination"));
      return;
    case "export-markdown":
      await exportMarkdown(requiredPath(args[1], "Markdown export destination"));
      return;
    case "restore":
      await restoreVault(requiredPath(args[1], "interchange path"));
      return;
    case "encrypt-vault":
      await encryptVault(args.slice(1));
      return;
    case "doctor":
      await printDoctor();
      return;
    case "diagnostics":
      await writeDiagnostics(
        requiredPath(args[1], "diagnostic bundle destination"),
      );
      return;
    case "lock":
      await changeVaultLifecycle("lock");
      return;
    case "unlock":
      await changeVaultLifecycle("unlock");
      return;
    case "package-verify-legacy-runtime-retired":
      verifyLegacyRuntimeRetired();
      return;
    case "eval-recall":
      await evaluateRecall(args.slice(1), semanticRuntime);
      return;
    case "eval-organization":
      await evaluateOrganization();
      return;
    case "semantic":
      await manageSemanticSearch(args[1], semanticRuntime);
      return;
    case "codex": {
      const action = parseCodexIntegrationAction(args[1]);
      if (action === "rotate-identity" || action === "prepare-reconnect") {
        console.log(JSON.stringify(
          await rotateInstalledMcpClientIdentity("codex", action),
          null,
          2,
        ));
        return;
      }
      const afternoteCommand = action === "install"
        ? installedAfternoteCommand()
        : undefined;
      const identity = action === "install" && isReleaseArtifact()
        ? await ensureInstalledMcpClientIdentity("codex")
        : undefined;
      const integration = await manageCodexIntegration(
        action,
        isStandaloneArtifact,
        {
          ...(afternoteCommand ? { afternoteCommand } : {}),
          probeIdentity: () => probeInstalledMcpClientIdentity("codex"),
        },
      );
      console.log(
        JSON.stringify(
          { ...integration, ...(identity ? { identity } : {}) },
          null,
          2,
        ),
      );
      return;
    }
    case "claude-code": {
      const action = parseClaudeCodeIntegrationAction(args[1]);
      if (action === "rotate-identity" || action === "prepare-reconnect") {
        console.log(JSON.stringify(
          await rotateInstalledMcpClientIdentity("claude", action),
          null,
          2,
        ));
        return;
      }
      const afternoteCommand = action === "install"
        ? installedAfternoteCommand()
        : undefined;
      const identity = action === "install" && isReleaseArtifact()
        ? await ensureInstalledMcpClientIdentity("claude")
        : undefined;
      const integration = await manageClaudeCodeIntegration(
        action,
        isStandaloneArtifact,
        {
          ...(afternoteCommand ? { afternoteCommand } : {}),
          probeIdentity: () => probeInstalledMcpClientIdentity("claude"),
        },
      );
      console.log(
        JSON.stringify(
          { ...integration, ...(identity ? { identity } : {}) },
          null,
          2,
        ),
      );
      return;
    }
    case "claude-desktop": {
      const action = parseClaudeDesktopConnectorAction(args[1]);
      if (action === "rotate-identity" || action === "prepare-reconnect") {
        console.log(JSON.stringify(
          await rotateInstalledMcpClientIdentity("claude-desktop", action),
          null,
          2,
        ));
        return;
      }
      const afternoteCommand = action === "install"
        ? installedAfternoteCommand()
        : undefined;
      const identity = action === "install" && isReleaseArtifact()
        ? await ensureInstalledMcpClientIdentity("claude-desktop")
        : undefined;
      const connector = await manageClaudeDesktopConnector(
        action,
        isStandaloneArtifact,
        {
          ...(afternoteCommand ? { afternoteCommand } : {}),
          packageVersion: LOCAL_VERSION,
          probeIdentity: () => probeInstalledMcpClientIdentity("claude-desktop"),
        },
      );
      console.log(
        JSON.stringify(
          { ...connector, ...(identity ? { identity } : {}) },
          null,
          2,
        ),
      );
      return;
    }
    case "version":
    case "--version":
    case "-v":
      console.log(LOCAL_VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp(semanticRuntime?.help);
      return;
    default:
      throw new Error(`Unknown Afternote Local command: ${command}`);
  }
}

function openNativeApplication(
  surface: "library" | "connections",
  args: string[],
): void {
  if (!isStandaloneArtifact) {
    throw new Error("The native Afternote app is available in the packaged Local artifact");
  }
  const appBundle = installedApplicationBundle();
  const appExecutable = join(
    appBundle,
    "Contents",
    "MacOS",
    "Afternote",
  );
  if (!existsSync(appExecutable)) {
    throw new Error("The signed Afternote app is unavailable");
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== "--no-open")) {
    throw new Error(`${surface} accepts only --no-open`);
  }
  if (args.includes("--no-open")) {
    console.log(JSON.stringify({ opened: false, surface, application: appExecutable }));
    return;
  }
  const launch = Bun.spawnSync(["/usr/bin/open", appBundle, "--args", `--${surface}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (launch.exitCode !== 0) {
    throw new Error("macOS could not open the signed Afternote application");
  }
  console.log(JSON.stringify({ opened: true, surface }));
}

function installedApplicationBundle(): string {
  const runtimeDirectory = dirname(process.execPath);
  const recordedPath = join(runtimeDirectory, "application-path");
  const candidates: string[] = [];
  if (existsSync(recordedPath)) {
    const info = lstatSync(recordedPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("The installed Afternote application record is invalid");
    }
    const recorded = readFileSync(recordedPath, "utf8").trim();
    if (!isAbsolute(recorded)) {
      throw new Error("The installed Afternote application record is invalid");
    }
    candidates.push(recorded);
  }
  candidates.push(
    join(runtimeDirectory, "Afternote.app"),
    "/Applications/Afternote.app",
    join(homedir(), "Applications", "Afternote.app"),
  );
  for (const candidate of candidates) {
    const executable = join(candidate, "Contents", "MacOS", "Afternote");
    if (!existsSync(candidate) || !existsSync(executable)) continue;
    const appInfo = lstatSync(candidate);
    const executableInfo = lstatSync(executable);
    if (appInfo.isDirectory() && !appInfo.isSymbolicLink() &&
        executableInfo.isFile() && !executableInfo.isSymbolicLink()) {
      return candidate;
    }
  }
  throw new Error("The signed Afternote app is unavailable");
}

async function relaunchWithBundledLibraries(
  args: string[],
  semanticAvailable: boolean,
): Promise<boolean> {
  if (
    !isStandaloneArtifact ||
    process.env.AFTERNOTE_LIBRARY_BOOTSTRAPPED === "1" ||
    process.platform !== "darwin" ||
    !semanticAvailable ||
    !commandNeedsEmbeddingLibrary(args)
  ) {
    return false;
  }
  const runtimeDirectory = dirname(process.execPath);
  const libraryPath = join(runtimeDirectory, "libonnxruntime.1.21.0.dylib");
  if (!existsSync(libraryPath)) return false;
  const info = lstatSync(libraryPath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Bundled ONNX runtime library must be a regular file");
  }

  const child = Bun.spawn([process.execPath, ...args], {
    env: {
      ...process.env,
      AFTERNOTE_LIBRARY_BOOTSTRAPPED: "1",
      DYLD_LIBRARY_PATH: [
        runtimeDirectory,
        process.env.DYLD_LIBRARY_PATH,
      ].filter(Boolean).join(":"),
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const forwardInterrupt = () => child.kill("SIGINT");
  const forwardTermination = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    process.exitCode = await child.exited;
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
  }
  return true;
}

function commandNeedsEmbeddingLibrary(args: string[]): boolean {
  const command = args[0] ?? "mcp";
  if (command === "semantic") return args[1] === "install";
  if (command === "eval-recall") return args.includes("--semantic");
  return false;
}

async function runMcp(args: string[]): Promise<void> {
  const kind = mcpClientKind(args);
  await runBrokerMcpAdapter(kind);
}

function mcpClientKind(args: string[]): McpBrokerClientKind {
  if (args.length === 2 && args[0] === "--client") {
    if (
      args[1] === "codex" ||
      args[1] === "claude" ||
      args[1] === "claude-desktop"
    ) return args[1];
  }
  throw new Error(
    "Afternote MCP requires an installed connector identity; install Codex, Claude Code, or Claude Desktop from Afternote Connections",
  );
}

async function exportVault(destination: string): Promise<void> {
  console.log(JSON.stringify(await runNativeAdminCommand([
    "--admin-export",
    "json",
    destination,
  ])));
}

async function exportMarkdown(destination: string): Promise<void> {
  console.log(JSON.stringify(await runNativeAdminCommand([
    "--admin-export",
    "markdown",
    destination,
  ])));
}

async function restoreVault(interchangePath: string): Promise<void> {
  console.log(JSON.stringify(await runNativeAdminCommand([
    "--admin-restore",
    interchangePath,
  ])));
}

async function encryptVault(args: string[]): Promise<void> {
  if (args.length !== 2) {
    throw new Error(
      "encrypt-vault requires live and artifact policies: keep, delete, or move:<absolute-path>",
    );
  }
  const livePolicy = recoveryCliPolicy(args[0], "live vault");
  const artifactPolicy = recoveryCliPolicy(args[1], "legacy artifacts");
  console.log(JSON.stringify(await runNativeAdminCommand([
    "--admin-migrate",
    livePolicy,
    artifactPolicy,
  ])));
}

type RecoveryCliPolicy = "keep" | "delete" | `move:${string}`;

function recoveryCliPolicy(
  value: string | undefined,
  label: string,
): RecoveryCliPolicy {
  if (value === "keep" || value === "delete") return value;
  if (value?.startsWith("move:")) {
    const destination = value.slice("move:".length);
    if (destination && isAbsolute(destination)) {
      return `move:${resolve(destination)}`;
    }
  }
  throw new Error(`${label} policy must be keep, delete, or move:<absolute-path>`);
}

async function printDoctor(): Promise<void> {
  console.log(JSON.stringify(await localDiagnosticBundle(), null, 2));
}

async function writeDiagnostics(destination: string): Promise<void> {
  const bundle = await localDiagnosticBundle();
  const contents = `${JSON.stringify(bundle, null, 2)}\n`;
  writeExclusivePrivateFile(destination, (descriptor) => {
    writeSync(descriptor, contents);
  });
  console.log(JSON.stringify({ written: true, format: bundle.format }));
}

async function localDiagnosticBundle(): Promise<
  Record<string, unknown>
> {
  return await runNativeAdminCommand(["--admin-diagnostics"]);
}

async function changeVaultLifecycle(action: "lock" | "unlock"): Promise<void> {
  console.log(JSON.stringify(
    await runNativeAdminCommand([action === "lock" ? "--admin-lock" : "--admin-unlock"]),
    null,
    2,
  ));
}

async function rotateInstalledMcpClientIdentity(
  kind: McpClientIdentityKind,
  action: "rotate-identity" | "prepare-reconnect" = "rotate-identity",
): Promise<Awaited<ReturnType<typeof rotateMcpClientIdentity>>> {
  if (!isStandaloneArtifact) {
    throw new Error(
      "MCP client identity rotation requires the packaged Afternote Local artifact",
    );
  }
  return await rotateMcpClientIdentity(kind, {
    statePath: join(homedir(), ".afternote", "clients", `${kind}.json`),
    approve: async ({
      kind: requestedKind,
      installIdentity,
      replacementInstallIdentity,
    }) =>
      await runNativeAdminCommand([
        action === "prepare-reconnect"
          ? "--admin-prepare-connector-reconnect"
          : "--admin-prepare-client-rotation",
        requestedKind,
        installIdentity,
        replacementInstallIdentity,
      ]) as McpClientRotationApproval,
  });
}

async function ensureInstalledMcpClientIdentity(
  kind: McpClientIdentityKind,
) {
  return await ensureMcpClientIdentity(kind, {
    probe: () => probeMcpClientIdentity(kind),
    rotate: () => rotateInstalledMcpClientIdentity(kind),
  });
}

function probeInstalledMcpClientIdentity(kind: McpClientIdentityKind): boolean {
  if (!isReleaseArtifact()) {
    return true;
  }
  probeMcpClientIdentity(kind);
  return true;
}

function isReleaseArtifact(): boolean {
  return typeof AFTERNOTE_RELEASE_BUILD === "boolean" && AFTERNOTE_RELEASE_BUILD;
}

export async function runNativeAdminCommand(
  args: ["--admin-diagnostics"] |
    ["--admin-export", "json" | "markdown", string] |
    ["--admin-migrate", RecoveryCliPolicy, RecoveryCliPolicy] |
    ["--admin-restore", string] |
    ["--admin-prepare-client-rotation" | "--admin-prepare-connector-reconnect", McpClientIdentityKind, string, string] |
    ["--admin-enroll-release-key"] |
    ["--admin-lock" | "--admin-unlock"],
): Promise<Record<string, unknown>> {
  const appExecutable = nativeOwnerControlExecutable();
  const child = Bun.spawn([appExecutable, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 13 * 60_000);
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBoundedProcessText(child.stdout, 1_048_576, "stdout"),
      readBoundedProcessText(child.stderr, 65_536, "stderr"),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally {
    clearTimeout(deadline);
  }
  if (timedOut) {
    throw new Error("Afternote owner administration exceeded its bounded operation window");
  }
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || "Afternote owner administration was denied");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error("Afternote owner administration returned invalid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Afternote owner administration returned an invalid result");
  }
  return parsed as Record<string, unknown>;
}

async function readBoundedProcessText(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        throw new Error(`Afternote owner administration returned oversized ${label}`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, bytes),
  );
}

function nativeOwnerControlExecutable(): string {
  if (!isStandaloneArtifact) {
    throw new Error("Owner administration requires the packaged Afternote Local artifact");
  }
  const executable = join(
    installedApplicationBundle(),
    "Contents",
    "MacOS",
    "Afternote",
  );
  if (!existsSync(executable)) throw new Error("The signed Afternote app is unavailable");
  const info = lstatSync(executable);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("The signed Afternote app executable is invalid");
  }
  return executable;
}

async function evaluateRecall(
  args: string[],
  semanticRuntime?: LocalSemanticRuntime,
): Promise<void> {
  const semantic = args.includes("--semantic");
  if (semantic && !semanticRuntime) {
    throw new Error("Semantic search is not included in this Afternote release");
  }
  const embeddingModel = semantic ? semanticRuntime!.open(vaultPath()) : null;
  if (semantic && !embeddingModel) {
    throw new Error("Install the local semantic model before running its evaluation");
  }
  const report = await runRecallEvaluation(LOCAL_VERSION, {
    ...recallEvaluationScale(
      args.filter((argument) => argument !== "--semantic"),
    ),
    embeddingModel: embeddingModel ?? undefined,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    throw new Error("Deterministic Recall evaluation did not meet its gates");
  }
}

async function evaluateOrganization(): Promise<void> {
  const report = await runOrganizationEvaluation(LOCAL_VERSION);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) {
    throw new Error("Automatic organization did not meet its 10,000-note gates");
  }
}

async function manageSemanticSearch(
  action: string | undefined,
  semanticRuntime?: LocalSemanticRuntime,
): Promise<void> {
  if (!semanticRuntime) {
    throw new Error("Semantic search is not included in this Afternote release");
  }
  const path = vaultPath();
  if (action === "status") {
    console.log(JSON.stringify(semanticRuntime.status(path), null, 2));
    return;
  }
  if (action === "install") {
    console.log(
      "Downloading the pinned 23 MB semantic index model. Note content is not uploaded.",
    );
    console.log(JSON.stringify(await semanticRuntime.acquire(path), null, 2));
    return;
  }
  throw new Error("Semantic action must be status or install");
}

function recallEvaluationScale(args: string[]): {
  noiseMultiplier?: 0 | 10 | 100;
  targetNoteCount?: 10_000;
} {
  if (args.length === 0) return { noiseMultiplier: 0 };
  if (args.length === 2 && args[0] === "--noise") {
    if (args[1] === "10") return { noiseMultiplier: 10 };
    if (args[1] === "100") return { noiseMultiplier: 100 };
  }
  if (args.length === 2 && args[0] === "--notes" && args[1] === "10000") {
    return { targetNoteCount: 10_000 };
  }
  throw new Error(
    "Recall evaluation accepts --semantic, --noise 10 or 100, or --notes 10000",
  );
}

function printHelp(semanticHelp?: string): void {
  const recallHelp = semanticHelp ?? `
  eval-recall [--noise 10|100] [--notes 10000]
                       Run deterministic exact Recall quality and noise-scaling gates`;
  console.log(`Afternote Local ${LOCAL_VERSION}

Usage: afternote <command>

Commands:
  mcp --client codex|claude|claude-desktop
                       Run an installed, owner-approved MCP adapter
  connections [--no-open]
                       Open Connections in the signed native Afternote app
  ui [--no-open]       Open Library in the signed native Afternote app
  export <path>       Create a lossless versioned JSON vault export
  export-markdown <file>
                       Create a human-readable current-note Markdown export
  restore <path>      Restore a validated JSON export into a clean vault path
  encrypt-vault <keep|delete|move:/path> <keep|delete|move:/directory>
                       Encrypt schema-8 storage with explicit live/artifact handling
  doctor              Print share-safe local diagnostics
  diagnostics <file>  Write an owner-only share-safe diagnostic bundle
  lock                 Close the vault and invalidate live broker authority
  unlock               Reopen the vault under a fresh authorization epoch
${recallHelp}
  eval-organization    Run automatic organization at the 10,000-note scale gate
  codex install|status|remove|rotate-identity|prepare-reconnect
                       Configure and validate the Codex MCP integration
  claude-code install|status|remove|rotate-identity|prepare-reconnect
                       Configure and validate the Claude Code MCP integration
  claude-desktop install|status|rotate-identity|prepare-reconnect
                       Configure and validate the Claude Desktop MCP connector
  version             Print the artifact version

Exports contain plaintext note content and source metadata. Markdown is not a restore format. Diagnostics use coarse allowlisted fields. Existing files and vaults are never overwritten.`);
}

function vaultPath(): string {
  const configured = process.env.AFTERNOTE_VAULT_PATH;
  if (!configured) return join(homedir(), ".afternote", "vault.db");
  if (!isAbsolute(configured)) {
    throw new Error("AFTERNOTE_VAULT_PATH must be absolute");
  }
  return resolve(configured);
}

function verifyLegacyRuntimeRetired(): void {
  if (!isStandaloneArtifact) {
    throw new Error("Legacy runtime retirement proof requires the packaged artifact");
  }
  const configured = process.env.AFTERNOTE_RUNTIME_PATH;
  const legacyRuntimePath = configured ?? join(homedir(), ".afternote", "runtime");
  if (!isAbsolute(legacyRuntimePath)) {
    throw new Error("AFTERNOTE_RUNTIME_PATH must be absolute");
  }
  assertLegacyRuntimeRetired({
    runtimePath: legacyRuntimePath,
    vaultPath: vaultPath(),
  });
  console.log(JSON.stringify({ retired: true }));
}

function requiredPath(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return resolve(value);
}
