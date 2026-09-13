import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  writeSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import { createAfternoteMcpServer } from "@afternote/mcp";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  MemoryError,
  vaultContextsEqual,
  type BrowseNotesPage,
  type Memory,
  type MemoryCapability,
  type Note,
  type NoteRevisionsPage,
  type RecallResult,
  type RememberInput,
  type SearchNotesPage,
  type VaultContext,
} from "@afternote/memory";
import {
  isRecoverableBrokerTransportError,
  isRejectedStaleBrokerSession,
  VaultBrokerRequestError,
  VaultBrokerMemoryClient,
  type McpBrokerClientKind,
} from "./vault-broker-client";
import {
  requireParentAndGrandparentCodeSigningRequirements,
  requireParentCodeSigningRequirement,
  type DurableClientSigner,
} from "./sqlcipher-database";
import {
  MCP_HOST_CODE_POLICIES,
  MCP_HOST_CODE_REQUIREMENTS,
} from "./integration-host-policy";
export {
  MCP_HOST_CODE_POLICIES,
  MCP_HOST_CODE_REQUIREMENTS,
} from "./integration-host-policy";

declare const AFTERNOTE_ACCEPTANCE_TRACE: boolean | undefined;

const ACCEPTANCE_TRACE_PATH_ENV = "AFTERNOTE_ACCEPTANCE_TRACE_PATH";
const ACCEPTANCE_TRACE_PREFIX = "AFTERNOTE_ACCEPTANCE_TRACE ";

const MCP_CAPABILITIES: MemoryCapability[] = [
  "memory.remember",
  "memory.recall",
  "memory.get_note",
];

type ActivatedBrokerMemory = Memory & { readonly vault: VaultContext };
type BrokerOperation = "remember" | "recall" | "get_note";

export type McpBrokerAcceptanceTraceEvent = {
  kind: "mcp-broker-activation" | "mcp-broker-operation";
  operation: BrokerOperation;
  attempt: 1 | 2;
  reactivation: boolean;
  outcome: "succeeded" | "failed" | "stale_session" | "transport_restart";
  durationMs: number;
};

export class DeferredVaultBrokerMemoryClient implements Memory {
  readonly vault: VaultContext = {
    vaultId: "0".repeat(64),
    deployment: "local",
  };
  readonly #activate: () => ActivatedBrokerMemory;
  readonly #clock: () => number;
  readonly #trace: ((event: McpBrokerAcceptanceTraceEvent) => void) | undefined;
  readonly #connectorKind: McpBrokerClientKind | undefined;
  #delegate: ActivatedBrokerMemory | undefined;

  constructor(
    activate: () => ActivatedBrokerMemory,
    options: {
      clock?: () => number;
      trace?: (event: McpBrokerAcceptanceTraceEvent) => void;
      connectorKind?: McpBrokerClientKind;
    } = {},
  ) {
    this.#activate = activate;
    this.#clock = options.clock ?? (() => performance.now());
    this.#trace = options.trace;
    this.#connectorKind = options.connectorKind;
  }

  async capabilities(vault: VaultContext): Promise<MemoryCapability[]> {
    this.#assertAdapterVault(vault);
    return [...MCP_CAPABILITIES];
  }

  async remember(vault: VaultContext, input: RememberInput): Promise<Note> {
    this.#assertAdapterVault(vault);
    return await this.#withReactivation("remember", (memory) =>
      memory.remember(memory.vault, input)
    );
  }

  async recall(vault: VaultContext, query: string, limit?: number): Promise<RecallResult[]> {
    this.#assertAdapterVault(vault);
    return await this.#withReactivation("recall", (memory) =>
      memory.recall(memory.vault, query, limit)
    );
  }

  async getNote(vault: VaultContext, id: string): Promise<Note | null> {
    this.#assertAdapterVault(vault);
    return await this.#withReactivation("get_note", (memory) =>
      memory.getNote(memory.vault, id)
    );
  }

  async forget(): Promise<boolean> {
    throw this.#unsupported();
  }

  async browseNotes(): Promise<BrowseNotesPage> {
    throw this.#unsupported();
  }

  async searchNotes(): Promise<SearchNotesPage> {
    throw this.#unsupported();
  }

  async updateNote(): Promise<Note> {
    throw this.#unsupported();
  }

  async listNoteRevisions(): Promise<NoteRevisionsPage> {
    throw this.#unsupported();
  }

  #activated(
    operation: BrokerOperation,
    attempt: 1 | 2,
    reactivation: boolean,
  ): ActivatedBrokerMemory {
    if (this.#delegate) return this.#delegate;
    const startedAt = this.#clock();
    try {
      const activated = this.#activate();
      this.#delegate = activated;
      this.#emit({
        kind: "mcp-broker-activation",
        operation,
        attempt,
        reactivation,
        outcome: "succeeded",
        durationMs: this.#elapsed(startedAt),
      });
      return activated;
    } catch (error) {
      this.#emit({
        kind: "mcp-broker-activation",
        operation,
        attempt,
        reactivation,
        outcome: "failed",
        durationMs: this.#elapsed(startedAt),
      });
      throw this.#connectorAccessError(error);
    }
  }

  async #withReactivation<Result>(
    operationName: BrokerOperation,
    operation: (memory: ActivatedBrokerMemory) => Promise<Result>,
  ): Promise<Result> {
    const active = this.#activated(operationName, 1, false);
    try {
      return await this.#runOperation(operationName, 1, false, active, operation);
    } catch (error) {
      const reactivatable = isRejectedStaleBrokerSession(error) ||
        (operationName !== "remember" && isRecoverableBrokerTransportError(error));
      if (!reactivatable) throw error;
      if (this.#delegate === active) this.#delegate = undefined;
      const reactivated = this.#activated(operationName, 2, true);
      return await this.#runOperation(operationName, 2, true, reactivated, operation);
    }
  }

  async #runOperation<Result>(
    operationName: BrokerOperation,
    attempt: 1 | 2,
    reactivation: boolean,
    memory: ActivatedBrokerMemory,
    operation: (memory: ActivatedBrokerMemory) => Promise<Result>,
  ): Promise<Result> {
    const startedAt = this.#clock();
    try {
      const result = await operation(memory);
      this.#emit({
        kind: "mcp-broker-operation",
        operation: operationName,
        attempt,
        reactivation,
        outcome: "succeeded",
        durationMs: this.#elapsed(startedAt),
      });
      return result;
    } catch (error) {
      this.#emit({
        kind: "mcp-broker-operation",
        operation: operationName,
        attempt,
        reactivation,
        outcome: isRejectedStaleBrokerSession(error)
          ? "stale_session"
          : isRecoverableBrokerTransportError(error)
          ? "transport_restart"
          : "failed",
        durationMs: this.#elapsed(startedAt),
      });
      throw this.#connectorAccessError(error);
    }
  }

  #elapsed(startedAt: number): number {
    return Math.max(0, this.#clock() - startedAt);
  }

  #emit(event: McpBrokerAcceptanceTraceEvent): void {
    try {
      this.#trace?.(event);
    } catch {
      // Acceptance diagnostics must never change broker behavior.
    }
  }

  #connectorAccessError(error: unknown): unknown {
    if (!this.#connectorKind || !connectorNeedsReconnect(error)) return error;
    const label = this.#connectorKind === "codex"
      ? "Codex"
      : this.#connectorKind === "claude"
      ? "Claude Code"
      : "Claude Desktop";
    return new MemoryError(
      "unauthorized",
      `${label} access needs to be reconnected. Open Afternote > Connections, ` +
        `choose Prepare reconnect for ${label}, then start a new ${label} session.`,
      { cause: error },
    );
  }

  #assertAdapterVault(vault: VaultContext): void {
    if (!vaultContextsEqual(vault, this.vault)) {
      throw new MemoryError("unauthorized", "MCP adapter vault context does not match");
    }
  }

  #unsupported(): MemoryError {
    return new MemoryError("unsupported_capability", "MCP cannot perform this operation");
  }
}

export async function runBrokerMcpAdapter(
  requestedKind: McpBrokerClientKind,
  options?: {
    service?: string;
    clientStatePath?: string;
    signer?: DurableClientSigner;
    codeRequirement?: string;
    hostCodeRequirement?: string;
  },
): Promise<void> {
  const kind = authorizeMcpConnectorHost(
    requestedKind,
    undefined,
    options?.hostCodeRequirement,
  );
  const memory = new DeferredVaultBrokerMemoryClient(
    () => VaultBrokerMemoryClient.activate(kind, options),
    { connectorKind: kind, trace: acceptanceTraceSink() },
  );
  const server = await createAfternoteMcpServer(memory, memory.vault, {
    sourceApplication: connectorSourceApplication(kind),
  });
  await serveStdio(() => server, {
    onerror(error) {
      console.error("Afternote Local MCP error:", error);
    },
  });
}

type McpConnectorHostAuthorization = {
  requireParent(requirement: string): void;
  requireParentAndGrandparent(
    parentRequirement: string,
    grandparentRequirement: string,
  ): void;
};

const nativeMcpConnectorHostAuthorization: McpConnectorHostAuthorization = {
  requireParent: requireParentCodeSigningRequirement,
  requireParentAndGrandparent:
    requireParentAndGrandparentCodeSigningRequirements,
};

export function authorizeMcpConnectorHost(
  requestedKind: McpBrokerClientKind,
  authorization: McpConnectorHostAuthorization =
    nativeMcpConnectorHostAuthorization,
  parentRequirementOverride?: string,
): McpBrokerClientKind {
  const requestedPolicy = MCP_HOST_CODE_POLICIES[requestedKind];
  const parentRequirement = parentRequirementOverride ?? requestedPolicy.parent;
  if (requestedKind === "claude") {
    try {
      authorization.requireParentAndGrandparent(
        parentRequirement,
        MCP_HOST_CODE_POLICIES["claude-desktop"].grandparent,
      );
      return "claude-desktop";
    } catch {
      authorization.requireParent(parentRequirement);
      return "claude";
    }
  }
  if (requestedKind === "claude-desktop") {
    authorization.requireParentAndGrandparent(
      parentRequirement,
      MCP_HOST_CODE_POLICIES["claude-desktop"].grandparent,
    );
    return "claude-desktop";
  }
  authorization.requireParent(parentRequirement);
  return requestedKind;
}

function connectorSourceApplication(kind: McpBrokerClientKind): string {
  return kind === "codex"
    ? "Codex"
    : kind === "claude"
    ? "Claude Code"
    : "Claude Desktop";
}

function connectorNeedsReconnect(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    /Could not (?:read|verify) the development client key \(-(?:25308|25293)\)/
      .test(error.message)
  ) {
    return true;
  }
  return error instanceof VaultBrokerRequestError &&
    error.code === "denied" &&
    /\brevoked\b|requires explicit reconnect preparation/i.test(error.message);
}

function acceptanceTraceSink():
  | ((event: McpBrokerAcceptanceTraceEvent) => void)
  | undefined {
  return createAcceptanceTraceSink({
    enabled:
      typeof AFTERNOTE_ACCEPTANCE_TRACE === "boolean" &&
      AFTERNOTE_ACCEPTANCE_TRACE,
    path: process.env[ACCEPTANCE_TRACE_PATH_ENV],
  });
}

export function createAcceptanceTraceSink(options: {
  enabled: boolean;
  path?: string;
}): ((event: McpBrokerAcceptanceTraceEvent) => void) | undefined {
  if (!options.enabled) return undefined;
  if (!options.path) {
    return (event) => {
      console.error(`${ACCEPTANCE_TRACE_PREFIX}${JSON.stringify(event)}`);
    };
  }
  if (!isAbsolute(options.path)) {
    throw new Error("Acceptance trace channel must be an absolute private file");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      options.path,
      constants.O_WRONLY |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0),
    );
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      (process.platform !== "win32" && (
        (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())
      ))
    ) {
      throw new Error("Acceptance trace channel must be an owner-only regular file");
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
  return (event) => {
    writeSync(
      descriptor,
      `${ACCEPTANCE_TRACE_PREFIX}${JSON.stringify(event)}\n`,
    );
  };
}
