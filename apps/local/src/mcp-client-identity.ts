import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";

export type McpClientIdentityKind = "codex" | "claude";

export type McpClientRotationRequest = {
  kind: McpClientIdentityKind;
  installIdentity: string;
  replacementInstallIdentity: string;
};

export type McpClientRotationApproval = McpClientRotationRequest & {
  prepared: true;
  clientId: string | null;
};

export type McpClientIdentityRotationResult = {
  rotated: true;
  kind: McpClientIdentityKind;
  previousInstallIdentity: string;
  installIdentity: string;
  backupPath: string;
};

type McpClientIdentityState = {
  format: "afternote-mcp-client";
  schemaVersion: 1;
  kind: McpClientIdentityKind;
  installIdentity: string;
};

export async function ensureMcpClientIdentity(
  kind: McpClientIdentityKind,
  options: {
    probe():
      | { signingMode: "secure-enclave" | "development-exact-build" }
      | Promise<{ signingMode: "secure-enclave" | "development-exact-build" }>;
    rotate(): unknown | Promise<unknown>;
    isRecoverable?: (error: unknown) => boolean;
  },
): Promise<{
  healthy: true;
  kind: McpClientIdentityKind;
  repaired: boolean;
  signingMode: "secure-enclave" | "development-exact-build";
}> {
  try {
    const probe = await options.probe();
    return { healthy: true, kind, repaired: false, signingMode: probe.signingMode };
  } catch (error) {
    const recoverable = options.isRecoverable ?? isStaleDevelopmentClientIdentity;
    if (!recoverable(error)) throw error;
  }
  await options.rotate();
  const probe = await options.probe();
  return { healthy: true, kind, repaired: true, signingMode: probe.signingMode };
}

export async function rotateMcpClientIdentity(
  kind: McpClientIdentityKind,
  options: {
    statePath: string;
    approve(
      request: McpClientRotationRequest,
    ): McpClientRotationApproval | Promise<McpClientRotationApproval>;
    generateInstallIdentity?: () => string;
    now?: () => Date;
  },
): Promise<McpClientIdentityRotationResult> {
  const inspected = inspectIdentityState(options.statePath, kind);
  const parent = dirname(options.statePath);
  const backupDirectory = join(parent, "rotation-backups");
  if (!existsSync(backupDirectory)) {
    mkdirSync(backupDirectory, { mode: 0o700 });
  }
  assertPrivateDirectory(backupDirectory, "MCP client identity backup directory");
  const nextInstallIdentity = (options.generateInstallIdentity ?? randomUUID)();
  if (!isUuid(nextInstallIdentity) || nextInstallIdentity === inspected.state.installIdentity) {
    throw new Error("Replacement MCP client identity is invalid");
  }
  const request = {
    kind,
    installIdentity: inspected.state.installIdentity,
    replacementInstallIdentity: nextInstallIdentity,
  } as const;
  const approval = await options.approve(request);
  assertExactApproval(approval, request);
  assertUnchangedIdentityState(options.statePath, inspected);
  assertPrivateDirectory(parent, "MCP client identity directory");
  assertPrivateDirectory(backupDirectory, "MCP client identity backup directory");

  const timestamp = (options.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[-:.]/g, "");
  const backupPath = join(
    backupDirectory,
    `${kind}-${timestamp}-${randomUUID()}.json`,
  );
  linkSync(options.statePath, backupPath);
  const backupInfo = lstatSync(backupPath);
  if (
    backupInfo.dev !== inspected.info.dev ||
    backupInfo.ino !== inspected.info.ino ||
    !privateRegularFile(backupInfo)
  ) {
    rmSync(backupPath, { force: true });
    throw new Error("MCP client identity changed while rotation was pending");
  }
  fsyncDirectory(backupDirectory);

  const nextState: McpClientIdentityState = {
    format: "afternote-mcp-client",
    schemaVersion: 1,
    kind,
    installIdentity: nextInstallIdentity,
  };
  const temporaryPath = `${options.statePath}.rotation-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeSync(descriptor, `${JSON.stringify(nextState, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertUnchangedIdentityState(options.statePath, inspected);
    renameSync(temporaryPath, options.statePath);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }

  return {
    rotated: true,
    kind,
    previousInstallIdentity: inspected.state.installIdentity,
    installIdentity: nextInstallIdentity,
    backupPath,
  };
}

function inspectIdentityState(
  path: string,
  expectedKind: McpClientIdentityKind,
): { state: McpClientIdentityState; contents: string; info: Stats } {
  assertPrivateDirectory(dirname(path), "MCP client identity directory");
  if (!existsSync(path)) throw invalidIdentityState();
  const info = lstatSync(path);
  if (!privateRegularFile(info)) throw invalidIdentityState();
  const contents = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw invalidIdentityState();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidIdentityState();
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\n") !==
      ["format", "installIdentity", "kind", "schemaVersion"].sort().join("\n") ||
    record.format !== "afternote-mcp-client" ||
    record.schemaVersion !== 1 ||
    record.kind !== expectedKind ||
    !isUuid(record.installIdentity)
  ) {
    throw invalidIdentityState();
  }
  return {
    state: record as McpClientIdentityState,
    contents,
    info,
  };
}

function assertUnchangedIdentityState(
  path: string,
  inspected: { state: McpClientIdentityState; contents: string; info: Stats },
): void {
  const current = inspectIdentityState(path, inspected.state.kind);
  if (
    current.info.dev !== inspected.info.dev ||
    current.info.ino !== inspected.info.ino ||
    current.contents !== inspected.contents
  ) {
    throw new Error("MCP client identity changed while rotation was pending");
  }
}

function assertExactApproval(
  approval: McpClientRotationApproval,
  request: McpClientRotationRequest,
): void {
  if (
    !approval ||
    typeof approval !== "object" ||
    Array.isArray(approval) ||
    Object.keys(approval).sort().join("\n") !==
      [
        "clientId",
        "installIdentity",
        "kind",
        "prepared",
        "replacementInstallIdentity",
      ].sort().join("\n") ||
    approval.prepared !== true ||
    approval.kind !== request.kind ||
    approval.installIdentity !== request.installIdentity ||
    approval.replacementInstallIdentity !== request.replacementInstallIdentity ||
    !(approval.clientId === null || isUuid(approval.clientId))
  ) {
    throw new Error("Owner-approved MCP client rotation result is invalid");
  }
}

function isStaleDevelopmentClientIdentity(error: unknown): boolean {
  return error instanceof Error &&
    /Could not (?:read|verify) the development client key \(-(?:25308|25293)\)/.test(
      error.message,
    );
}

function assertPrivateDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} must be an owner-only directory`);
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform !== "win32" && (
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    ))
  ) {
    throw new Error(`${label} must be an owner-only directory`);
  }
}

function privateRegularFile(info: Stats): boolean {
  return info.isFile() &&
    !info.isSymbolicLink() &&
    (process.platform === "win32" || (
      (info.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || info.uid === process.getuid())
    ));
}

function invalidIdentityState(): Error {
  return new Error(
    "MCP client identity state must be an owner-only regular file with exact schema",
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
