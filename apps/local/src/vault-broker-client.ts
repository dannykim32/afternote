import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import type { ArchiveReader, ArchivePassagePage, ArchiveSearchPage } from "@afternote/mcp";
import { ARCHIVE_CAPABILITIES, type BrokerCapability } from "./broker-capabilities";
import { existsSync, lstatSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  MemoryError,
  vaultContextsEqual,
  type BrowseNotesInput,
  type BrowseNotesPage,
  type ListNoteRevisionsInput,
  type Memory,
  type MemoryCapability,
  type Note,
  type NoteRevisionsPage,
  type RecallResult,
  type RememberInput,
  type SearchNotesInput,
  type SearchNotesPage,
  type UpdateNoteInput,
  type VaultContext,
} from "@afternote/memory";
import { writeExclusivePrivateFile } from "./exclusive-export";
import {
  openDurableClientSigner,
  packagedVaultKeychainOptions,
  requestVaultBrokerXpc,
  type DurableClientSigner,
} from "./sqlcipher-database";
import {
  canonicalBrokerTranscript,
  TRUSTED_MCP_CONNECTION_TTL_MS,
  type BrokerRequestEnvelope,
} from "./vault-broker";
import {
  VAULT_BROKER_IDENTIFIER,
  VAULT_BROKER_PROTOCOL_VERSION,
} from "./vault-broker-metadata";

declare const AFTERNOTE_BROKER_CODE_REQUIREMENT: string | undefined;
declare const AFTERNOTE_BROKER_MACH_SERVICE: string | undefined;

const OWNER_PRESENCE_XPC_TIMEOUT_MS = 125_000;

export type VaultBrokerHealth = {
  bootId: string;
  protocolVersion: typeof VAULT_BROKER_PROTOCOL_VERSION;
  publicMetadata: {
    applicationVersion: string;
    brokerIdentifier: typeof VAULT_BROKER_IDENTIFIER;
    transport: "launchd-mach-service";
  };
};

export class VaultBrokerRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class VaultBrokerTransportError extends Error {
  constructor(
    readonly code: "unavailable" | "timed_out",
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

const REACTIVATABLE_SESSION_DENIALS = new Set([
  "Broker boot does not match",
  "Session was not found",
  "Session is expired",
  "Session is disconnected",
  "Trusted work session is expired",
]);

export function isRejectedStaleBrokerSession(error: unknown): boolean {
  return error instanceof VaultBrokerRequestError &&
    error.code === "denied" &&
    REACTIVATABLE_SESSION_DENIALS.has(error.message);
}

export function isRecoverableBrokerTransportError(
  error: unknown,
): error is VaultBrokerTransportError {
  return error instanceof VaultBrokerTransportError;
}

export function requestVaultBroker(
  method: string,
  params: Record<string, unknown>,
  options?: {
    service?: string;
    timeoutMs?: number;
    codeRequirement?: string;
    transport?: typeof requestVaultBrokerXpc;
  },
): unknown {
  const requestId = randomUUID();
  let serialized: string;
  try {
    serialized = (options?.transport ?? requestVaultBrokerXpc)(
      options?.service ?? packagedBrokerMachService(),
      options?.codeRequirement ?? packagedBrokerCodeRequirement(),
      JSON.stringify({
        protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
        requestId,
        method,
        params,
      }),
      options?.timeoutMs,
    );
  } catch (error) {
    throw typedBrokerTransportError(error) ?? error;
  }
  let response: unknown;
  try {
    response = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new Error("Broker response is not valid JSON", { cause: error });
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Broker response is invalid");
  }
  const record = response as Record<string, unknown>;
  if (
    record.protocolVersion !== VAULT_BROKER_PROTOCOL_VERSION ||
    record.requestId !== requestId ||
    typeof record.ok !== "boolean"
  ) {
    throw new Error("Broker response context is invalid");
  }
  if (!record.ok) {
    const brokerError = record.error as { code?: unknown; message?: unknown } | undefined;
    throw new VaultBrokerRequestError(
      typeof brokerError?.code === "string" ? brokerError.code : "denied",
      typeof brokerError?.message === "string"
        ? brokerError.message
        : "Broker request was denied",
    );
  }
  return record.result;
}

function typedBrokerTransportError(
  error: unknown,
): VaultBrokerTransportError | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "Broker XPC request timed out") {
    return new VaultBrokerTransportError("timed_out", error.message, error);
  }
  if (
    error.message === "Broker XPC service is unavailable" ||
    error.message === "Could not create the broker XPC connection"
  ) {
    return new VaultBrokerTransportError("unavailable", error.message, error);
  }
  return null;
}

export function vaultBrokerHealth(options?: {
  service?: string;
  timeoutMs?: number;
  codeRequirement?: string;
}): VaultBrokerHealth {
  return requestVaultBroker("health", {}, options) as VaultBrokerHealth;
}

export type McpBrokerClientKind = "codex" | "claude" | "claude-desktop";
export type BrokerMemoryClientKind = McpBrokerClientKind;

type ActivatedSession = {
  sessionId: string;
  clientId: string;
  grantId: string;
  capabilities: BrokerCapability[];
  forgetPolicy: "never" | "confirm_each" | "session";
  expiresAt: string;
  brokerBootId: string;
  vaultId: string;
};

export function probeMcpClientIdentity(
  kind: McpBrokerClientKind,
  options: {
    clientStatePath?: string;
    openSigner?: (tag: string) => DurableClientSigner;
  } = {},
): {
  installIdentity: string;
  signingMode: "secure-enclave" | "development-exact-build";
} {
  const profile = clientProfile(kind);
  const statePath = options.clientStatePath ?? defaultClientStatePath(kind);
  const existingIdentity = readClientInstallIdentity(
    statePath,
    kind,
  );
  const installIdentity = existingIdentity ?? randomUUID();
  const signer = (options.openSigner ?? ((tag) => openDurableClientSigner(
    tag,
    packagedVaultKeychainOptions(),
  )))(
    `${profile.keychainServicePrefix}.${installIdentity}`,
  );
  signer.sign(`afternote-mcp-client-readiness:${randomUUID()}`);
  if (existingIdentity === null) {
    writeClientInstallIdentity(
      statePath,
      kind,
      installIdentity,
    );
  }
  return { installIdentity, signingMode: signer.signingMode };
}

export class VaultBrokerMemoryClient implements Memory, ArchiveReader {
  readonly vault: VaultContext;
  readonly #session: ActivatedSession;
  readonly #sessionPrivateKey: string;
  readonly #service: string;
  readonly #codeRequirement: string | undefined;
  readonly #request: typeof requestVaultBroker;

  private constructor(options: {
    session: ActivatedSession;
    sessionPrivateKey: string;
    service: string;
    codeRequirement?: string;
    request: typeof requestVaultBroker;
  }) {
    this.#session = options.session;
    this.#sessionPrivateKey = options.sessionPrivateKey;
    this.#service = options.service;
    this.#codeRequirement = options.codeRequirement;
    this.#request = options.request;
    this.vault = { vaultId: options.session.vaultId, deployment: "local" };
  }

  static activate(
    kind: BrokerMemoryClientKind,
    options?: {
      service?: string;
      clientStatePath?: string;
      request?: typeof requestVaultBroker;
      signer?: DurableClientSigner;
      codeRequirement?: string;
    },
  ): VaultBrokerMemoryClient {
    const service = options?.service ?? packagedBrokerMachService();
    const brokerRequest = options?.request ?? requestVaultBroker;
    const profile = clientProfile(kind);
    const installIdentity = readOrCreateInstallIdentity(
      options?.clientStatePath ?? defaultClientStatePath(kind),
      kind,
    );
    const signer = options?.signer ?? openDurableClientSigner(
      `${profile.keychainServicePrefix}.${installIdentity}`,
      packagedVaultKeychainOptions(),
    );
    const requestedCapabilities = profile.capabilities;
    const begin = brokerRequest("client.begin", {
      kind,
      displayName: profile.displayName,
      installIdentity,
      publicKey: signer.publicKey,
      signingMode: signer.signingMode,
      requestedCapabilities,
      forgetPolicy: "never",
    }, { service, codeRequirement: options?.codeRequirement }) as {
      state: "paired" | "proof_required";
      requestId?: string;
      clientProofTranscript?: string;
      clientId?: string;
      grantId?: string;
    };
    const paired = begin.state === "paired"
      ? requirePaired(begin)
      : brokerRequest("client.complete_pairing", {
          requestId: requiredString(begin.requestId, "pairing request ID"),
          clientSignature: signer.sign(
            requiredString(begin.clientProofTranscript, "pairing proof transcript"),
          ),
        }, {
          service,
          codeRequirement: options?.codeRequirement,
          timeoutMs: OWNER_PRESENCE_XPC_TIMEOUT_MS,
        }) as {
          clientId: string;
          grantId: string;
        };

    const ephemeral = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const activation = brokerRequest("session.begin", {
      clientId: paired.clientId,
      grantId: paired.grantId,
      sessionPublicKey: ephemeral.publicKey,
      requestedCapabilities: [...requestedCapabilities, ...ARCHIVE_CAPABILITIES],
      ttlMs: profile.sessionTtlMs,
    }, { service, codeRequirement: options?.codeRequirement }) as {
      activationId: string;
      ownerDecisionTranscript: string;
      clientProofTranscript: string;
      sessionProofTranscript: string;
    };
    const session = brokerRequest("session.complete", {
      activationId: activation.activationId,
      ownerDecisionTranscript: activation.ownerDecisionTranscript,
      clientSignature: signer.sign(activation.clientProofTranscript),
      sessionSignature: sign(
        "sha256",
        Buffer.from(activation.sessionProofTranscript),
        ephemeral.privateKey,
      ).toString("base64url"),
    }, {
      service,
      codeRequirement: options?.codeRequirement,
      timeoutMs: OWNER_PRESENCE_XPC_TIMEOUT_MS,
    }) as ActivatedSession;
    if (
      session.forgetPolicy !== "never" ||
      !Array.isArray(session.capabilities) ||
      session.capabilities.some((scope) => typeof scope !== "string") ||
      session.capabilities.includes("memory.forget") ||
      session.capabilities.filter((scope) => !scope.startsWith("archive.")).join("\n") !== requestedCapabilities.join("\n") ||
      session.capabilities.some((scope) => ![...requestedCapabilities, ...ARCHIVE_CAPABILITIES].includes(scope)) ||
      new Set(session.capabilities).size !== session.capabilities.length
    ) {
      throw new MemoryError("unauthorized", "Broker returned an invalid Memory grant");
    }
    return new VaultBrokerMemoryClient({
      session,
      sessionPrivateKey: ephemeral.privateKey,
      service,
      codeRequirement: options?.codeRequirement,
      request: brokerRequest,
    });
  }

  async capabilities(vault: VaultContext): Promise<MemoryCapability[]> {
    this.#assertVault(vault);
    return this.#session.capabilities.filter((scope): scope is MemoryCapability => scope.startsWith("memory."));
  }

  async searchArchives(query: string, limit: number): Promise<ArchiveSearchPage> {
    return this.#execute(this.vault, "archive.search", { query, limit }) as ArchiveSearchPage;
  }

  async readArchive(id: string, startIndex: number, limit: number): Promise<ArchivePassagePage> {
    return this.#execute(this.vault, "archive.read", { id, startIndex, limit }) as ArchivePassagePage;
  }

  async remember(vault: VaultContext, input: RememberInput): Promise<Note> {
    return (this.#execute(vault, "memory.remember", input) as { note: Note }).note;
  }

  async recall(
    vault: VaultContext,
    query: string,
    limit = 5,
  ): Promise<RecallResult[]> {
    return (this.#execute(vault, "memory.recall", { query, limit }) as {
      results: RecallResult[];
    }).results;
  }

  async getNote(vault: VaultContext, id: string): Promise<Note | null> {
    return (this.#execute(vault, "memory.get_note", { id }) as {
      note: Note | null;
    }).note;
  }

  async forget(vault: VaultContext, id: string): Promise<boolean> {
    return (this.#execute(vault, "memory.forget", { id }) as {
      forgotten: boolean;
    }).forgotten;
  }

  async browseNotes(
    vault: VaultContext,
    input?: BrowseNotesInput,
  ): Promise<BrowseNotesPage> {
    void vault;
    void input;
    throw new MemoryError("unsupported_capability", "MCP cannot browse the vault");
  }

  async searchNotes(
    vault: VaultContext,
    input: SearchNotesInput,
  ): Promise<SearchNotesPage> {
    void vault;
    void input;
    throw new MemoryError("unsupported_capability", "MCP cannot browse the vault");
  }

  async updateNote(
    vault: VaultContext,
    id: string,
    input: UpdateNoteInput,
  ): Promise<Note> {
    void vault;
    void id;
    void input;
    throw new MemoryError("unsupported_capability", "MCP cannot edit notes");
  }

  async listNoteRevisions(
    vault: VaultContext,
    id: string,
    input?: ListNoteRevisionsInput,
  ): Promise<NoteRevisionsPage> {
    void vault;
    void id;
    void input;
    throw new MemoryError("unsupported_capability", "MCP cannot inspect revisions");
  }

  #execute(
    vault: VaultContext,
    operation: string,
    body: Record<string, unknown>,
  ): unknown {
    this.#assertVault(vault);
    const bodyBytes = Buffer.from(JSON.stringify(body));
    const unsigned = {
      protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
      brokerBootId: this.#session.brokerBootId,
      vaultId: this.vault.vaultId,
      clientId: this.#session.clientId,
      grantId: this.#session.grantId,
      sessionId: this.#session.sessionId,
      requestId: randomUUID(),
      issuedAt: new Date().toISOString(),
      operation,
      bodySha256: createHash("sha256").update(bodyBytes).digest("hex"),
    };
    const envelope: BrokerRequestEnvelope = {
      ...unsigned,
      signature: sign(
        "sha256",
        Buffer.from(canonicalBrokerTranscript(unsigned)),
        this.#sessionPrivateKey,
      ).toString("base64url"),
    };
    return this.#request("memory.execute", { envelope, body }, {
      service: this.#service,
      codeRequirement: this.#codeRequirement,
    });
  }

  #assertVault(vault: VaultContext): void {
    if (!vaultContextsEqual(vault, this.vault)) {
      throw new MemoryError("unauthorized", "Vault context does not match this broker session");
    }
  }
}

function packagedBrokerCodeRequirement(): string {
  const requirement = typeof AFTERNOTE_BROKER_CODE_REQUIREMENT === "string"
    ? AFTERNOTE_BROKER_CODE_REQUIREMENT
    : undefined;
  if (!requirement) {
    throw new Error("Broker code-signing requirement is unavailable");
  }
  return requirement;
}

export function packagedBrokerMachService(): string {
  const service = typeof AFTERNOTE_BROKER_MACH_SERVICE === "string"
    ? AFTERNOTE_BROKER_MACH_SERVICE
    : VAULT_BROKER_IDENTIFIER;
  if (!/^[A-Za-z0-9.-]{1,255}$/.test(service)) {
    throw new Error("Packaged broker Mach service name is invalid");
  }
  return service;
}

function defaultClientStatePath(
  kind: BrokerMemoryClientKind,
): string {
  return join(homedir(), ".afternote", "clients", `${kind}.json`);
}

function clientProfile(
  kind: BrokerMemoryClientKind,
): {
  displayName: string;
  capabilities: MemoryCapability[];
  sessionTtlMs: number;
  keychainServicePrefix: string;
} {
  return {
    displayName: kind === "codex"
      ? "Codex"
      : kind === "claude"
      ? "Claude Code"
      : "Claude Desktop",
    capabilities: ["memory.remember", "memory.recall", "memory.get_note"],
    sessionTtlMs: TRUSTED_MCP_CONNECTION_TTL_MS,
    keychainServicePrefix: `dev.afternote.mcp-client.${kind}`,
  };
}

function readOrCreateInstallIdentity(
  path: string,
  kind: BrokerMemoryClientKind,
): string {
  const existing = readClientInstallIdentity(path, kind);
  if (existing !== null) return existing;
  const installIdentity = randomUUID();
  writeClientInstallIdentity(path, kind, installIdentity);
  return installIdentity;
}

function readClientInstallIdentity(
  path: string,
  kind: BrokerMemoryClientKind,
): string | null {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("MCP client state must be a regular file");
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      format?: unknown;
      schemaVersion?: unknown;
      kind?: unknown;
      installIdentity?: unknown;
    };
    if (
      parsed.format !== "afternote-mcp-client" ||
      parsed.schemaVersion !== 1 ||
      parsed.kind !== kind ||
      typeof parsed.installIdentity !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.installIdentity)
    ) {
      throw new Error("MCP client state is invalid");
    }
    return parsed.installIdentity;
  }
  return null;
}

function writeClientInstallIdentity(
  path: string,
  kind: BrokerMemoryClientKind,
  installIdentity: string,
): void {
  if (dirname(path) === path) throw new Error("MCP client state path is invalid");
  writeExclusivePrivateFile(path, (descriptor) => {
    writeSync(descriptor, `${JSON.stringify({
      format: "afternote-mcp-client",
      schemaVersion: 1,
      kind,
      installIdentity,
    }, null, 2)}\n`);
  });
}

function requirePaired(value: {
  clientId?: string;
  grantId?: string;
}): { clientId: string; grantId: string } {
  return {
    clientId: requiredString(value.clientId, "client ID"),
    grantId: requiredString(value.grantId, "grant ID"),
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Broker ${name} is invalid`);
  }
  return value;
}
