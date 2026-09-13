import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  MAX_NOTE_CHARACTERS,
  MAX_RECALL_QUERY_CHARACTERS,
  MAX_RECALL_RESULTS,
  MAX_SOURCE_APPLICATION_CHARACTERS,
  MAX_SOURCE_AUTHOR_CHARACTERS,
  MAX_SOURCE_LABEL_CHARACTERS,
  MAX_SOURCE_TIMESTAMP_CHARACTERS,
  MAX_SOURCE_URL_CHARACTERS,
  MEMORY_CAPABILITIES,
  countCharacters,
  MemoryError,
  type SourceContext,
  type VaultContext,
} from "@afternote/memory";
import { localVaultContext, localVaultLifecycleLockPath } from "./local-vault";
import { SqliteMemory, type EffectiveSearchMode } from "./sqlite-memory";
import type { DerivedIndexStatus, TextEmbeddingModel } from "./retrieval";
import {
  buildDiagnosticBundle,
  LOCAL_DIAGNOSTICS_API_VERSION,
} from "./diagnostics";
import {
  encryptionMigrationApprovalSnapshot,
  encryptionMigrationReadiness,
  encryptionMigrationRecoveryCoordinationDigest,
  encryptionMigrationRecoveryPending,
  finalizePlaintextVaultMigration,
  migratePlaintextVault,
  validateLegacyArtifactDecisions,
  type EncryptionMigrationApprovalSnapshot,
  type EncryptionMigrationFault,
  type LegacyArtifactDecision,
  type LegacyPlaintextDecision,
} from "./encrypted-vault-migration";
import {
  cleanVaultRestoreApprovalSnapshot,
  cleanVaultRestoreApprovalSnapshotDigest,
  cleanVaultRestoreCoordinationDigest,
  cleanVaultRestoreRecoveryPending,
  finalizeCleanVaultRestore,
  restoreCleanEncryptedVault,
  sealAuditedCleanVaultRestore,
  type CleanVaultRestoreApprovalSnapshot,
  type CleanVaultRestoreFault,
} from "./encrypted-vault-restore";
import {
  getOrCreateKeychainVaultKey,
  packagedVaultKeychainOptions,
  pollVaultBrokerGatewayXpc,
  ExclusiveFileLock,
  SqlcipherDatabase,
} from "./sqlcipher-database";
import {
  canonicalBrokerTranscript,
  NativeLibraryAuditCommitError,
  ROUTINE_AUTHENTICATION_TTLS_MS,
  TRUSTED_MCP_CONNECTION_TTL_MS,
  VaultBrokerAuthorization,
  type BrokerCapability,
  type BrokerClientKind,
  type BrokerRequestEnvelope,
  type BrokerTransportBinding,
  type ForgetPolicy,
  type OwnerConnectorRevocationTarget,
  type OwnerClientRotationTarget,
  type OwnerRevocationTarget,
  type OwnerTrustPath,
} from "./vault-broker";
import {
  VAULT_BROKER_IDENTIFIER,
  VAULT_BROKER_PROTOCOL_VERSION,
} from "./vault-broker-metadata";
import {
  LIBRARY_MAX_PAGE_SIZE,
  LIBRARY_MAX_REVISION_PAGE_SIZE,
  LIBRARY_MAX_SEARCH_RESULTS,
  LIBRARY_SCOPES,
  LIBRARY_SESSION_DEFAULT_TTL_MS,
  LIBRARY_SESSION_MAX_TTL_MS,
  LibraryCursorCodec,
  libraryDeleteTarget,
  libraryNoteSummary,
  libraryRevisionSummary,
  librarySearchResult,
  type LibraryScope,
} from "./vault-broker-library";
import {
  OwnerPresenceCoordinator,
  OwnerPresenceCoordinatorError,
} from "./owner-presence-coordinator";

declare const AFTERNOTE_ACCEPTANCE_TRACE: boolean | undefined;

const MAXIMUM_MESSAGE_BYTES = 1_048_576;
const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1_000;
const OWNER_SESSION_DEFAULT_TTL_MS = 5 * 60 * 1_000;
const OWNER_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const DEVELOPMENT_OWNER_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const OWNER_CHALLENGE_TTL_MS = 2 * 60 * 1_000;
const OWNER_INSPECTION_SCOPES = [
  "owner.inspect_clients",
  "owner.inspect_grants",
  "owner.inspect_sessions",
  "owner.inspect_audit",
] as const;
type OwnerInspectionScope = (typeof OWNER_INSPECTION_SCOPES)[number];
type GatewayPeerRole = "memory-client" | "owner-control";
const MAX_TRACKED_OWNER_REQUESTS = 1_024;
const MAX_PENDING_OWNER_CHALLENGES = 32;
const LIBRARY_DELETE_CHALLENGE_TTL_MS = 30_000;
const MAX_LIBRARY_RESPONSE_BYTES = 768 * 1_024;
const MAX_LIBRARY_QUERY_BYTES = 8 * 1_024;
const MAX_LIBRARY_SEARCH_MS = 2_000;
const ADMIN_EXPORT_OPERATION_TIMEOUT_MS = 9 * 60_000;

type GatewayEnvelope = {
  kind: "client" | "owner-presence" | "connection-closed";
  peerRole: GatewayPeerRole;
  connectionId: string;
  peerPid: number;
  payload: unknown;
};

type BrokerRequest = {
  protocolVersion: number;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};

export type VaultBrokerWorkerOptions = {
  applicationVersion: string;
  standalone?: boolean;
  ownerPresenceMode?: "required" | "development-bypass";
  vaultPath?: string;
  vaultKey?: Uint8Array;
  vaultKeyProvider?: () => Uint8Array;
  vaultKeyReader?: (vaultId: string) => Uint8Array | null;
  vaultKeyCreator?: (vaultId: string) => Uint8Array;
  vault?: VaultContext;
  embeddingModelProvider?: (vaultPath: string) => TextEmbeddingModel | null;
  embeddingDiscoveryProvider?: (vaultPath: string) => {
    model: TextEmbeddingModel | null;
    invalid: boolean;
  };
  now?: () => number;
  bootId?: string;
  trustPath?: OwnerTrustPath;
  onVaultDataPlaneOpenForTest?: () => void;
  onVaultHandleClosedForTest?: (
    handle: "memory" | "authorization" | "cursors" | "database",
  ) => void;
  onLockTransactionForTest?: () => void;
  onEncryptionMigrationPhaseForTest?: (phase: EncryptionMigrationFault) => void;
  onCleanVaultRestorePhaseForTest?: (phase: CleanVaultRestoreFault) => void;
  onRecoveryApprovalRevalidatedForTest?: (
    operation: "migration" | "restore",
  ) => void;
};

type VaultLifecycleState = "unlocked" | "locking" | "locked" | "unlocking";

type DeferredLifecycleAudit = {
  operation: "lifecycle.unlock";
  outcome: "denied" | "error";
  errorCode: string;
};

type PendingPresence =
  | {
      kind: "pairing";
      requestId: string;
      pairingRequestId: string;
      clientSignature: string;
      ownerTranscript: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
      peerRole: "memory-client";
    }
  | {
      kind: "activation";
      requestId: string;
      activationId: string;
      clientSignature: string;
      sessionSignature: string;
      ownerTranscript: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
      peerRole: "memory-client";
    }
  | {
      kind: "revocation";
      requestId: string;
      target: OwnerRevocationTarget;
      ownerTranscript: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "connector-revocation";
      requestId: string;
      target: OwnerConnectorRevocationTarget;
      ownerTranscript: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "owner-session";
      requestId: string;
      scopes: OwnerInspectionScope[];
      ownerTranscript: string;
      challengeExpiresAt: number;
      sessionExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "library-session";
      requestId: string;
      sessionId: string;
      scopes: LibraryScope[];
      ownerTranscript: string;
      challengeExpiresAt: number;
      sessionExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "library-delete";
      requestId: string;
      sessionId: string;
      noteId: string;
      noteRevision: number;
      targetDescription: string;
      ownerTranscript: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "admin";
      requestId: string;
      operation:
        | { kind: "export"; destination: string; format: "json" | "markdown" }
        | { kind: "diagnostics" }
        | {
            kind: "client-rotation";
            target: OwnerClientRotationTarget;
            replacementInstallIdentity: string;
          }
        | {
            kind: "revoked-client-replacement";
            target: OwnerClientRotationTarget;
            replacementInstallIdentity: string;
          };
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "lifecycle";
      requestId: string;
      operation: "lock" | "unlock";
      expectedState: "unlocked" | "locked";
      expectedEpoch: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "recovery-migration";
      requestId: string;
      vaultPath: string;
      liveDecision: LegacyPlaintextDecision;
      artifactAction: "keep" | "delete" | "move";
      artifactDestinationDirectory: string | null;
      approvalSnapshot: EncryptionMigrationApprovalSnapshot;
      approvalSnapshotDigest: string;
      coordinationDigest: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
    }
  | {
      kind: "recovery-restore";
      requestId: string;
      vaultPath: string;
      approvalSnapshot: CleanVaultRestoreApprovalSnapshot;
      approvalSnapshotDigest: string;
      coordinationDigest: string;
      challengeExpiresAt: number;
      binding: BrokerTransportBinding;
    };

type RecoveryPresence = Extract<
  PendingPresence,
  {
    kind: "recovery-migration" | "recovery-restore";
  }
>;

function isRecoveryPresence(
  pending: PendingPresence | undefined,
): pending is RecoveryPresence {
  return pending?.kind === "recovery-migration" ||
    pending?.kind === "recovery-restore";
}

function expectedOwnerPresenceRole(pending: PendingPresence): GatewayPeerRole {
  return pending.kind === "pairing" || pending.kind === "activation"
    ? pending.peerRole
    : "owner-control";
}

type OwnerInspectionSession = {
  scopes: OwnerInspectionScope[];
  expiresAt: number;
  binding: BrokerTransportBinding;
};

type LibrarySession = {
  sessionId: string;
  scopes: LibraryScope[];
  expiresAt: number;
  brokerBootId: string;
  vaultId: string;
  binding: BrokerTransportBinding;
};

export class VaultBrokerWorker {
  bootId: string;
  readonly #applicationVersion: string;
  readonly #standalone: boolean;
  readonly #ownerPresenceMode: "required" | "development-bypass";
  readonly #configuredVaultPath: string | undefined;
  #configuredVaultKey: Uint8Array | undefined;
  readonly #vaultKeyProvider: (() => Uint8Array) | undefined;
  readonly #vaultKeyReader:
    | ((vaultId: string) => Uint8Array | null)
    | undefined;
  readonly #vaultKeyCreator: ((vaultId: string) => Uint8Array) | undefined;
  readonly #configuredVault: VaultContext | undefined;
  readonly #now: (() => number) | undefined;
  readonly #ownerPrivateKey: KeyObject;
  readonly #ownerPublicKey: string;
  readonly #trustPath: OwnerTrustPath;
  readonly #onVaultDataPlaneOpenForTest: (() => void) | undefined;
  readonly #onVaultHandleClosedForTest:
    | ((handle: "memory" | "authorization" | "cursors" | "database") => void)
    | undefined;
  readonly #onLockTransactionForTest: (() => void) | undefined;
  readonly #onEncryptionMigrationPhaseForTest:
    | ((phase: EncryptionMigrationFault) => void)
    | undefined;
  readonly #onCleanVaultRestorePhaseForTest:
    | ((phase: CleanVaultRestoreFault) => void)
    | undefined;
  readonly #onRecoveryApprovalRevalidatedForTest:
    | ((operation: "migration" | "restore") => void)
    | undefined;
  readonly #pendingPresence = new OwnerPresenceCoordinator<PendingPresence>();
  readonly #ownerSessions = new Map<string, OwnerInspectionSession>();
  readonly #librarySessions = new Map<string, LibrarySession>();
  readonly #ownerRequestIds = new Map<string, number>();
  readonly #activationTtls = new Map<string, number>();
  readonly #tracedAuditEvents = new Set<string>();
  #authorization: VaultBrokerAuthorization | undefined;
  #database: SqlcipherDatabase | undefined;
  #memory: SqliteMemory | undefined;
  #vault: VaultContext | undefined;
  #libraryCursors: LibraryCursorCodec | undefined;
  #lifecycleState: VaultLifecycleState = "unlocked";
  #lifecycleEpoch: string;
  #lifecycleLoaded = false;
  #pendingLifecycleChallengeId: string | undefined;
  #pendingRecoveryChallengeId: string | undefined;
  #terminateAfterResponse = false;
  #semanticDiscoveryFailed = false;
  readonly #deferredLifecycleAudit: DeferredLifecycleAudit[] = [];
  readonly #vaultLifecycleLock: ExclusiveFileLock;
  readonly #embeddingModelProvider: (vaultPath: string) => {
    model: TextEmbeddingModel | null;
    invalid: boolean;
  };

  constructor(options: string | VaultBrokerWorkerOptions) {
    const normalized = typeof options === "string"
      ? { applicationVersion: options }
      : options;
    this.#applicationVersion = normalized.applicationVersion;
    this.#standalone = normalized.standalone ?? false;
    this.#ownerPresenceMode = normalized.ownerPresenceMode ?? "required";
    this.#configuredVaultPath = normalized.vaultPath;
    this.#configuredVaultKey = normalized.vaultKey
      ? Uint8Array.from(normalized.vaultKey)
      : undefined;
    this.#vaultKeyProvider = normalized.vaultKeyProvider;
    this.#vaultKeyReader = normalized.vaultKeyReader;
    this.#vaultKeyCreator = normalized.vaultKeyCreator;
    this.#configuredVault = normalized.vault;
    this.#embeddingModelProvider = normalized.embeddingDiscoveryProvider
      ? normalized.embeddingDiscoveryProvider
      : normalized.embeddingModelProvider
      ? (vaultPath) => ({
          model: normalized.embeddingModelProvider!(vaultPath),
          invalid: false,
        })
      : () => ({ model: null, invalid: false });
    this.#now = normalized.now;
    this.#trustPath = normalized.trustPath ?? "development-only";
    this.#onVaultDataPlaneOpenForTest = normalized.onVaultDataPlaneOpenForTest;
    this.#onVaultHandleClosedForTest = normalized.onVaultHandleClosedForTest;
    this.#onLockTransactionForTest = normalized.onLockTransactionForTest;
    this.#onEncryptionMigrationPhaseForTest =
      normalized.onEncryptionMigrationPhaseForTest;
    this.#onCleanVaultRestorePhaseForTest =
      normalized.onCleanVaultRestorePhaseForTest;
    this.#onRecoveryApprovalRevalidatedForTest =
      normalized.onRecoveryApprovalRevalidatedForTest;
    this.bootId = normalized.bootId ?? randomUUID();
    this.#lifecycleEpoch = this.bootId;
    const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.#ownerPrivateKey = owner.privateKey;
    this.#ownerPublicKey = owner.publicKey.export({ type: "spki", format: "pem" }).toString();
    this.#vaultLifecycleLock = new ExclusiveFileLock(
      localVaultLifecycleLockPath(this.#vaultConfiguration().vaultPath),
      "Another Afternote process owns the vault lifecycle",
    );
  }

  async handleSerialized(serialized: string): Promise<string> {
    if (!serialized || Buffer.byteLength(serialized) > MAXIMUM_MESSAGE_BYTES) {
      return serializedError(null, "invalid_request", "Broker request is malformed or oversized");
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(serialized) as unknown;
    } catch {
      return serializedError(null, "invalid_request", "Broker request is not valid JSON");
    }
    let gateway: GatewayEnvelope | undefined;
    let request: BrokerRequest | undefined;
    let ownerPresenceRequestId: string | undefined;
    try {
      gateway = parseGatewayEnvelope(envelope);
      if (gateway.kind === "owner-presence") {
        const challengeId = gateway.payload && typeof gateway.payload === "object" &&
            !Array.isArray(gateway.payload) &&
            typeof (gateway.payload as Record<string, unknown>).challengeId === "string"
          ? (gateway.payload as Record<string, unknown>).challengeId as string
          : undefined;
        ownerPresenceRequestId = challengeId
          ? this.#pendingPresence.get(challengeId)?.requestId
          : undefined;
        const response = await this.#completeOwnerPresence(gateway);
        this.#traceNewAuditEvents();
        return response;
      }
      if (gateway.kind === "connection-closed") {
        this.#authorization?.disconnectTransport(gateway.connectionId, gateway.peerPid);
        this.#ownerSessions.delete(ownerSessionKey(binding(gateway)));
        this.#librarySessions.delete(ownerSessionKey(binding(gateway)));
        for (const [challengeId, pending] of this.#pendingPresence) {
          if (bindingsEqual(pending.binding, binding(gateway))) {
            if (pending.kind === "lifecycle") {
              this.#recordLifecycleOutcome(
                pending.operation,
                "denied",
                "owner_disconnected",
              );
            }
            this.#pendingPresence.delete(challengeId);
            if (pending.kind === "lifecycle") {
              this.#pendingLifecycleChallengeId = undefined;
            } else if (isRecoveryPresence(pending)) {
              this.#pendingRecoveryChallengeId = undefined;
            }
          }
        }
        return JSON.stringify({ ok: true });
      }
      request = parseBrokerRequest(gateway.payload);
      this.#prunePendingOwnerChallenges();
      const response = await this.#handleRequest(
        request,
        binding(gateway),
        gateway.peerRole,
      );
      this.#traceNewAuditEvents();
      return response;
    } catch (error) {
      if (
        gateway?.peerRole === "owner-control" &&
        (error instanceof BrokerProtocolError) &&
        (error.code === "invalid_request" ||
          error.code === "invalid_cursor" ||
          error.code === "replayed" ||
          error.code === "identity_mismatch") &&
        (gateway.kind === "owner-presence" ||
          gateway.kind === "client" &&
            (request === undefined ||
              request.method.startsWith("library.") ||
              request.method.startsWith("owner.")))
      ) {
        this.#librarySessions.delete(ownerSessionKey(binding(gateway)));
      }
      this.#traceNewAuditEvents();
      this.#traceRequestError(error);
      return serializedError(
        request?.requestId ?? ownerPresenceRequestId ?? requestIdFromEnvelope(envelope),
        error instanceof NativeLibraryAuditCommitError
          ? "audit_commit_failed"
          : error instanceof BrokerProtocolError || error instanceof MemoryError
            ? error.code
            : "denied",
        error instanceof NativeLibraryAuditCommitError
          ? "The Library change and its audit record were rolled back"
          : peerSafeErrorMessage(error),
      );
    }
  }

  #traceRequestError(error: unknown): void {
    if (
      typeof AFTERNOTE_ACCEPTANCE_TRACE !== "boolean" ||
      !AFTERNOTE_ACCEPTANCE_TRACE
    ) return;
    console.error(`AFTERNOTE_ACCEPTANCE_DIAGNOSTIC ${JSON.stringify({
      kind: "broker-request-error",
      code: error instanceof BrokerProtocolError ? error.code : "denied",
      message: safeErrorMessage(error),
    })}`);
  }

  #traceNewAuditEvents(): void {
    if (
      typeof AFTERNOTE_ACCEPTANCE_TRACE !== "boolean" ||
      !AFTERNOTE_ACCEPTANCE_TRACE ||
      !this.#authorization
    ) return;
    try {
      for (const event of this.#authorization.readAuditForTest()) {
        if (this.#tracedAuditEvents.has(event.eventId)) continue;
        this.#tracedAuditEvents.add(event.eventId);
        console.error(`AFTERNOTE_ACCEPTANCE_DIAGNOSTIC ${JSON.stringify({
          kind: "persisted-audit-event",
          ...event,
        })}`);
      }
    } catch {
      console.error(
        'AFTERNOTE_ACCEPTANCE_DIAGNOSTIC {"kind":"trace-error","message":"Could not read redacted audit metadata"}',
      );
    }
  }

  close(): void {
    try {
      this.#closeVaultHandles();
    } finally {
      this.#configuredVaultKey?.fill(0);
      this.#configuredVaultKey = undefined;
      this.#pendingPresence.clear();
      this.#ownerSessions.clear();
      this.#librarySessions.clear();
      this.#ownerRequestIds.clear();
      this.#activationTtls.clear();
      this.#vaultLifecycleLock.release();
    }
  }

  closeLifecycleAdmissionForTest(): void {
    this.#lifecycleState = "locking";
  }

  shouldTerminateAfterResponse(): boolean {
    return this.#terminateAfterResponse;
  }

  hasConfiguredVaultKeyForTest(): boolean {
    return this.#configuredVaultKey !== undefined;
  }

  readAuditForTest() {
    return this.#authority().readAuditForTest();
  }

  #ensureVault(): void {
    if (this.#lifecycleState !== "unlocked") {
      throw new BrokerProtocolError("vault_locked", "Afternote vault is locked");
    }
    this.#openVault(false);
  }

  #openVault(allowLocked: boolean): void {
    if (this.#authorization && this.#memory && this.#vault) {
      if (!allowLocked && this.#lifecycleState !== "unlocked") {
        throw new BrokerProtocolError("vault_locked", "Afternote vault is locked");
      }
      return;
    }
    if (!allowLocked && this.#lifecycleLoaded && this.#lifecycleState !== "unlocked") {
      throw new BrokerProtocolError("vault_locked", "Afternote vault is locked");
    }
    const { vaultPath, vault } = this.#vaultConfiguration();
    const key = this.#retrieveVaultKey(vault);
    try {
      const database = new SqlcipherDatabase(vaultPath, { key });
      this.#database = database;
      this.#loadOrInitializeLifecycleState(database);
      if (!allowLocked && this.#lifecycleState !== "unlocked") {
        this.#closeVaultHandles();
        throw new BrokerProtocolError("vault_locked", "Afternote vault is locked");
      }
      this.#onVaultDataPlaneOpenForTest?.();
      let embeddingModel: TextEmbeddingModel | null = null;
      this.#semanticDiscoveryFailed = false;
      try {
        const discovery = this.#embeddingModelProvider(vaultPath);
        embeddingModel = discovery.model;
        this.#semanticDiscoveryFailed = discovery.invalid;
      } catch {
        this.#semanticDiscoveryFailed = true;
      }
      this.#memory = new SqliteMemory(vaultPath, vault, {
        encryptionKey: key,
        database,
        embeddingModel,
        retrievalMode: embeddingModel ? "hybrid" : "lexical",
      });
      this.#authorization = new VaultBrokerAuthorization({
        path: vaultPath,
        key,
        database,
        vaultId: vault.vaultId,
        bootId: this.bootId,
        ownerPublicKey: this.#ownerPublicKey,
        now: this.#now,
      });
      this.#vault = vault;
      this.#libraryCursors = new LibraryCursorCodec({
        key: randomBytes(32),
        bootId: this.bootId,
        vaultId: vault.vaultId,
        now: this.#now,
      });
    } catch (error) {
      try {
        this.#closeVaultHandles();
      } catch {
        this.#terminateAfterResponse = true;
      }
      throw error;
    } finally {
      key.fill(0);
    }
  }

  #vaultConfiguration(): { vaultPath: string; vault: VaultContext } {
    const vaultPath = this.#configuredVaultPath ??
      process.env.AFTERNOTE_VAULT_PATH ??
      join(homedir(), ".afternote", "vault.db");
    const vault = this.#configuredVault ?? localVaultContext(vaultPath);
    if (vault.deployment !== "local") {
      throw new BrokerProtocolError("invalid_vault", "Broker vault must be local");
    }
    return { vaultPath, vault };
  }

  #retrieveVaultKey(vault: VaultContext): Uint8Array {
    let key = this.#vaultKeyProvider
      ? this.#vaultKeyProvider()
      : this.#configuredVaultKey
      ? Uint8Array.from(this.#configuredVaultKey)
      : this.#vaultKeyReader
      ? this.#vaultKeyReader(vault.vaultId)
      : getOrCreateKeychainVaultKey(vault.vaultId, packagedVaultKeychainOptions());
    if (key === null) {
      const vaultEntry = recoveryEntryKind(
        this.#vaultConfiguration().vaultPath,
        "vault",
      );
      if (vaultEntry !== "absent" || !this.#vaultKeyCreator) {
        throw new BrokerProtocolError(
          "recovery_required",
          "Release-key enrollment must complete before the vault can open",
        );
      }
      key = this.#vaultKeyCreator(vault.vaultId);
    }
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      key?.fill(0);
      throw new BrokerProtocolError("unlock_failed", "Afternote vault remains locked");
    }
    return key;
  }

  #loadOrInitializeLifecycleState(database: SqlcipherDatabase): void {
    database.exec(`
      create table if not exists broker_lifecycle_state (
        singleton integer primary key check (singleton = 1),
        state text not null check (state in ('unlocked', 'locked')),
        epoch text not null,
        updated_at text not null
      );
    `);
    const row = database.query<{ state: string; epoch: string }, []>(
      "select state, epoch from broker_lifecycle_state where singleton = 1",
    ).get();
    if (!row) {
      database.query(
        "insert into broker_lifecycle_state (singleton, state, epoch, updated_at) values (1, 'unlocked', ?, ?)",
      ).run(this.bootId, new Date(this.#currentTime()).toISOString());
      this.#lifecycleState = "unlocked";
      this.#lifecycleEpoch = this.bootId;
      this.#lifecycleLoaded = true;
      return;
    }
    if ((row.state !== "unlocked" && row.state !== "locked") || !isUuid(row.epoch)) {
      throw new BrokerProtocolError("unlock_failed", "Afternote vault remains locked");
    }
    this.#lifecycleState = row.state;
    this.#lifecycleEpoch = row.epoch;
    this.#lifecycleLoaded = true;
    if (row.state === "unlocked" && row.epoch !== this.bootId) {
      this.#lifecycleEpoch = this.bootId;
      database.query(
        "update broker_lifecycle_state set epoch = ?, updated_at = ? where singleton = 1 and state = 'unlocked'",
      ).run(this.bootId, new Date(this.#currentTime()).toISOString());
    }
  }

  #ensureLifecycleLoaded(): void {
    if (this.#lifecycleLoaded) return;
    const { vaultPath, vault } = this.#vaultConfiguration();
    const key = this.#retrieveVaultKey(vault);
    let database: SqlcipherDatabase | undefined;
    try {
      database = new SqlcipherDatabase(vaultPath, { key });
      this.#loadOrInitializeLifecycleState(database);
    } finally {
      key.fill(0);
      if (database) {
        try {
          database.close();
        } catch {
          this.#terminateAfterResponse = true;
          throw new BrokerProtocolError(
            "lifecycle_transition_failed",
            "Vault maintenance storage did not close",
          );
        }
      }
    }
  }

  #closeVaultHandles(): void {
    const memory = this.#memory;
    const authorization = this.#authorization;
    const database = this.#database;
    const cursors = this.#libraryCursors;
    let firstFailure: unknown;
    const closeHandle = (
      kind: "memory" | "authorization" | "cursors" | "database",
      close: (() => void) | undefined,
    ) => {
      if (!close) return;
      try {
        close();
        this.#onVaultHandleClosedForTest?.(kind);
      } catch (error) {
        firstFailure ??= error;
      }
    };
    closeHandle("memory", memory ? () => memory.close() : undefined);
    closeHandle("authorization", authorization ? () => authorization.close() : undefined);
    closeHandle("cursors", cursors ? () => cursors.close() : undefined);
    closeHandle("database", database ? () => database.close() : undefined);
    this.#memory = undefined;
    this.#authorization = undefined;
    this.#database = undefined;
    this.#libraryCursors = undefined;
    if (firstFailure !== undefined) {
      this.#terminateAfterResponse = true;
      throw firstFailure;
    }
  }

  #authority(): VaultBrokerAuthorization {
    this.#ensureVault();
    return this.#authorization!;
  }

  #localMemory(): SqliteMemory {
    this.#ensureVault();
    return this.#memory!;
  }

  #vaultContext(): VaultContext {
    this.#ensureVault();
    return this.#vault!;
  }

  async #handleRequest(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
    peerRole: GatewayPeerRole,
  ): Promise<string> {
    if (
      peerRole === "owner-control" &&
      (request.method.startsWith("owner.") ||
        request.method.startsWith("library.") ||
        request.method.startsWith("admin.") ||
        request.method.startsWith("lifecycle.") ||
        request.method.startsWith("recovery."))
    ) {
      this.#consumeOwnerRequestId(request.requestId);
    }
    if (
      request.method !== "health" &&
      !request.method.startsWith("recovery.")
    ) {
      if (this.#pendingRecoveryChallengeId) {
        throw new BrokerProtocolError(
          "transition_in_progress",
          "Vault migration approval is pending",
        );
      }
      if (
        encryptionMigrationRecoveryPending(this.#vaultConfiguration().vaultPath) ||
        cleanVaultRestoreRecoveryPending(this.#vaultConfiguration().vaultPath)
      ) {
        throw new BrokerProtocolError(
          "recovery_required",
          "Vault recovery must complete before other operations",
        );
      }
      if (!this.#lifecycleLoaded) {
        const recoveryState = this.#classifyRecoveryState();
        if (recoveryState === "vault-key-unavailable") {
          throw new BrokerProtocolError(
            "recovery_required",
            "The vault key is unavailable for this installation",
          );
        }
      }
    }
    if (
      request.method !== "health" &&
      !request.method.startsWith("lifecycle.") &&
      !request.method.startsWith("recovery.")
    ) {
      this.#ensureLifecycleLoaded();
      if (this.#lifecycleState !== "unlocked") {
        throw new BrokerProtocolError("vault_locked", "Afternote vault is locked");
      }
    }
    switch (request.method) {
      case "health":
        assertExactObject(request.params, []);
        return success(request.requestId, {
          bootId: this.bootId,
          protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
          publicMetadata: {
            applicationVersion: this.#applicationVersion,
            brokerIdentifier: VAULT_BROKER_IDENTIFIER,
            transport: "launchd-mach-service",
          },
        });
      case "client.begin":
        assertOrdinaryPeerRole(peerRole);
        return this.#beginClient(request, transportBinding, peerRole);
      case "client.complete_pairing":
        assertOrdinaryPeerRole(peerRole);
        return this.#completePairingProof(request, transportBinding, peerRole);
      case "session.begin":
        assertOrdinaryPeerRole(peerRole);
        return this.#beginActivation(request, transportBinding);
      case "session.complete":
        assertOrdinaryPeerRole(peerRole);
        return this.#completeActivationProofs(request, transportBinding, peerRole);
      case "memory.execute":
        assertPeerRole(peerRole, "memory-client");
        return await this.#executeMemory(request, transportBinding);
      case "owner.session.begin":
        assertPeerRole(peerRole, "owner-control");
        return this.#beginOwnerSession(request, transportBinding);
      case "owner.routine_authentication":
        assertPeerRole(peerRole, "owner-control");
        return this.#routineAuthentication(request);
      case "owner.set_routine_authentication":
        assertPeerRole(peerRole, "owner-control");
        return this.#setRoutineAuthentication(request);
      case "owner.connector_overview":
        assertPeerRole(peerRole, "owner-control");
        return this.#connectorOverview(request);
      case "owner.inspect_connections":
        assertPeerRole(peerRole, "owner-control");
        return this.#inspectConnections(request, transportBinding);
      case "owner.inspect_audit":
        assertPeerRole(peerRole, "owner-control");
        return this.#inspectAudit(request, transportBinding);
      case "owner.revoke_client":
        assertPeerRole(peerRole, "owner-control");
        return this.#requestRevocation(request, transportBinding);
      case "owner.revoke_connector":
        assertPeerRole(peerRole, "owner-control");
        return this.#requestConnectorRevocation(request, transportBinding);
      case "library.session.begin":
        assertPeerRole(peerRole, "owner-control");
        return this.#beginLibrarySession(request, transportBinding);
      case "library.views":
      case "library.browse":
      case "library.search":
      case "library.get_note":
      case "library.list_revisions":
      case "library.remember":
      case "library.update_note":
      case "library.delete":
        assertPeerRole(peerRole, "owner-control");
        return await this.#executeLibrary(request, transportBinding);
      case "admin.export":
      case "admin.diagnostics":
      case "admin.prepare_client_rotation":
        assertPeerRole(peerRole, "owner-control");
        return this.#beginAdmin(request, transportBinding);
      case "lifecycle.status":
        assertPeerRole(peerRole, "owner-control");
        return this.#lifecycleStatus(request);
      case "lifecycle.lock":
      case "lifecycle.unlock":
        assertPeerRole(peerRole, "owner-control");
        return this.#beginLifecycleTransition(request, transportBinding);
      case "recovery.status":
        assertPeerRole(peerRole, "owner-control");
        return this.#recoveryStatus(request);
      case "recovery.migrate":
        assertPeerRole(peerRole, "owner-control");
        return this.#beginRecoveryMigration(request, transportBinding);
      case "recovery.restore":
        assertPeerRole(peerRole, "owner-control");
        return this.#beginRecoveryRestore(request, transportBinding);
      default:
        throw new BrokerProtocolError("not_found", "Broker method is not available");
    }
  }

  #beginClient(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
    peerRole: GatewayPeerRole,
  ): string {
    assertExactObject(request.params, [
      "displayName",
      "forgetPolicy",
      "installIdentity",
      "kind",
      "publicKey",
      "requestedCapabilities",
      "signingMode",
    ]);
    const kind = clientKind(request.params.kind);
    assertClientKindForRole(kind, peerRole);
    const suppliedDisplayName = boundedString(
      request.params.displayName,
      120,
      "display name",
    );
    const displayName = fixedClientDisplayName(kind);
    if (suppliedDisplayName !== displayName) {
      throw new BrokerProtocolError(
        "identity_mismatch",
        "Broker client display name does not match its authenticated kind",
      );
    }
    const installIdentity = boundedIdentifier(
      request.params.installIdentity,
      128,
      "install identity",
    );
    const publicKey = boundedString(request.params.publicKey, 4_096, "public key");
    const signingMode = boundedString(
      request.params.signingMode,
      2_048,
      "signing mode",
    );
    const requestedCapabilities = capabilities(request.params.requestedCapabilities);
    const forgetPolicy = forgetPolicyValue(request.params.forgetPolicy);
    if (forgetPolicy !== "never" || requestedCapabilities.includes("memory.forget")) {
      throw new BrokerProtocolError(
        "scope_denied",
        "Default pairing cannot grant Forget",
      );
    }
    const existing = this.#authority().findPairedClient({
      kind,
      installIdentity,
      publicKey,
    });
    if (existing) {
      return success(request.requestId, { state: "paired", ...existing });
    }
    const pending = this.#authority().requestPairing({
      kind,
      displayName,
      installIdentity,
      publicKey,
      signingMode,
      requestedCapabilities,
      forgetPolicy,
    });
    return success(request.requestId, {
      state: "proof_required",
      ...pending,
      connectionBinding: transportBindingDigest(transportBinding),
    });
  }

  #prunePendingOwnerChallenges(): void {
    const now = this.#currentTime();
    for (const [challengeId, pending] of this.#pendingPresence) {
      if (pending.challengeExpiresAt > now) continue;
      this.#pendingPresence.delete(challengeId);
      this.#removeSiblingAuthorityChallenges(pending);
      if (pending.kind === "pairing") {
        this.#authority().denyPairing(pending.pairingRequestId, "owner_timeout");
      } else if (pending.kind === "activation") {
        this.#authority().denyActivation(pending.activationId, "owner_timeout");
        this.#activationTtls.delete(pending.activationId);
      }
      if (pending.kind === "lifecycle") {
        this.#pendingLifecycleChallengeId = undefined;
      } else if (isRecoveryPresence(pending)) {
        this.#pendingRecoveryChallengeId = undefined;
      }
    }
  }

  #removeSiblingAuthorityChallenges(pending: PendingPresence): void {
    if (pending.kind !== "pairing" && pending.kind !== "activation") return;
    for (const [challengeId, candidate] of this.#pendingPresence) {
      const sameAuthorityRequest = pending.kind === "pairing"
        ? candidate.kind === "pairing" &&
          candidate.pairingRequestId === pending.pairingRequestId
        : candidate.kind === "activation" &&
          candidate.activationId === pending.activationId;
      if (sameAuthorityRequest) this.#pendingPresence.delete(challengeId);
    }
  }

  #assertOwnerChallengeCapacity(): void {
    this.#prunePendingOwnerChallenges();
    if (this.#pendingPresence.size >= MAX_PENDING_OWNER_CHALLENGES) {
      throw new BrokerProtocolError(
        "rate_limited",
        "Owner authentication challenge window is full",
      );
    }
  }

  #completePairingProof(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
    peerRole: "memory-client",
  ): string {
    assertExactObject(request.params, ["clientSignature", "requestId"]);
    const pairingRequestId = uuid(request.params.requestId, "pairing request ID");
    const clientSignature = boundedString(
      request.params.clientSignature,
      512,
      "client signature",
    );
    this.#authority().verifyPairingClientProof(pairingRequestId, clientSignature);
    const ownerTranscript = this.#authority().pairingOwnerTranscriptForPending(
      pairingRequestId,
    );
    const parsed = JSON.parse(ownerTranscript) as {
      displayName?: unknown;
      expiresAt?: unknown;
      requestedCapabilities?: unknown;
    };
    const displayName = typeof parsed.displayName === "string"
      ? parsed.displayName
      : "this client";
    const requestedCapabilities = capabilities(parsed.requestedCapabilities);
    for (const [, pending] of this.#pendingPresence) {
      if (pending.kind === "pairing" &&
        pending.pairingRequestId === pairingRequestId) {
        throw new BrokerProtocolError(
          "replayed",
          "Pairing approval is already pending",
        );
      }
    }
    this.#assertOwnerChallengeCapacity();
    const challengeId = randomUUID();
    const pairingExpiresAt = Date.parse(boundedString(
      parsed.expiresAt,
      64,
      "pairing expiration",
    ));
    if (!Number.isFinite(pairingExpiresAt)) {
      throw new BrokerProtocolError("invalid_request", "Pairing expiration is invalid");
    }
    const challengeExpiresAt = Math.min(
      this.#currentTime() + OWNER_CHALLENGE_TTL_MS,
      pairingExpiresAt,
    );
    this.#pendingPresence.set(challengeId, {
      kind: "pairing",
      requestId: request.requestId,
      pairingRequestId,
      clientSignature,
      ownerTranscript,
      challengeExpiresAt,
      binding: transportBinding,
      peerRole,
    });
    return ownerPresenceChallenge(
      challengeId,
      `Pair a ${displayName} connector with Afternote Memory? Client type: ${displayName}. Scopes: ${formatCapabilities(
        requestedCapabilities,
      )}. Forget is not included.`,
      challengeExpiresAt,
    );
  }

  #beginActivation(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, [
      "clientId",
      "grantId",
      "requestedCapabilities",
      "sessionPublicKey",
      "ttlMs",
    ]);
    const requestedCapabilities = capabilities(request.params.requestedCapabilities);
    if (requestedCapabilities.includes("memory.forget")) {
      throw new BrokerProtocolError(
        "scope_denied",
        "Default activation cannot add Forget",
      );
    }
    const ttlMs = sessionTtl(request.params.ttlMs);
    const activation = this.#authority().requestActivation({
        clientId: uuid(request.params.clientId, "client ID"),
        grantId: uuid(request.params.grantId, "grant ID"),
        sessionPublicKey: boundedString(
          request.params.sessionPublicKey,
          4_096,
          "session public key",
        ),
        requestedCapabilities,
        ttlMs,
        transportBinding,
      });
    this.#activationTtls.set(activation.activationId, ttlMs);
    return success(request.requestId, activation);
  }

  #completeActivationProofs(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
    peerRole: "memory-client",
  ): string {
    assertExactObject(request.params, [
      "activationId",
      "clientSignature",
      "ownerDecisionTranscript",
      "sessionSignature",
    ]);
    const activationId = uuid(request.params.activationId, "activation ID");
    const clientSignature = boundedString(
      request.params.clientSignature,
      512,
      "client signature",
    );
    const sessionSignature = boundedString(
      request.params.sessionSignature,
      512,
      "session signature",
    );
    const ownerTranscript = boundedString(
      request.params.ownerDecisionTranscript,
      8_192,
      "owner decision transcript",
    );
    this.#authority().verifyActivationProofs({
      activationId,
      clientSignature,
      sessionSignature,
    });
    if (this.#authority().activationOwnerTranscriptForPending(activationId) !== ownerTranscript) {
      throw new BrokerProtocolError("signature_invalid", "Activation transcript changed");
    }
    const activationTranscript = JSON.parse(ownerTranscript) as {
      decisionExpiresAt?: unknown;
    };
    const ttlMs = this.#activationTtls.get(activationId);
    if (ttlMs === undefined) {
      throw new BrokerProtocolError(
        "identity_mismatch",
        "Activation was not initiated by this broker process",
      );
    }
    this.#activationTtls.delete(activationId);
    const activationClientKind = this.#authority().activationClientKind(activationId);
    if (
      (activationClientKind === "codex" ||
        activationClientKind === "claude" ||
        activationClientKind === "claude-desktop") &&
      this.#authority().canSilentlyActivateTrustedMcp(activationId)
    ) {
      const activated = this.#authority().approveTrustedMcpActivation({
        activationId,
        clientSignature,
        sessionSignature,
      });
      return success(request.requestId, {
        ...activated,
        brokerBootId: this.bootId,
        vaultId: this.#vaultContext().vaultId,
      });
    }
    const phrase = createHash("sha256").update(ownerTranscript).digest("hex").slice(0, 12);
    const workSessionTtlMs = this.#authority().routineAuthenticationTtlMilliseconds();
    this.#assertOwnerChallengeCapacity();
    const challengeId = randomUUID();
    const activationDecisionExpiresAt = Date.parse(boundedString(
      activationTranscript.decisionExpiresAt,
      64,
      "activation decision expiration",
    ));
    if (!Number.isFinite(activationDecisionExpiresAt)) {
      throw new BrokerProtocolError(
        "invalid_request",
        "Activation decision expiration is invalid",
      );
    }
    const challengeExpiresAt = Math.min(
      this.#currentTime() + OWNER_CHALLENGE_TTL_MS,
      activationDecisionExpiresAt,
    );
    this.#pendingPresence.set(challengeId, {
      kind: "activation",
      requestId: request.requestId,
      activationId,
      clientSignature,
      sessionSignature,
      ownerTranscript,
      challengeExpiresAt,
      binding: transportBinding,
      peerRole,
    });
    return ownerPresenceChallenge(
      challengeId,
      `Start a shared Afternote work session for ${formatSessionDuration(workSessionTtlMs)} with an inactivity limit of ${formatSessionDuration(workSessionTtlMs)}? During this work session, previously paired Codex, Claude Code, and Claude Desktop apps may silently establish their own connection-bound, least-privilege sessions for up to ${formatSessionDuration(TRUSTED_MCP_CONNECTION_TTL_MS)}, limited to Remember, Recall, and Get. This triggering connection lasts ${formatSessionDuration(Math.min(ttlMs, TRUSTED_MCP_CONNECTION_TTL_MS))}. Verification: ${phrase.slice(0, 4)} ${phrase.slice(4, 8)} ${phrase.slice(8, 12)}.`,
      challengeExpiresAt,
    );
  }

  async #executeMemory(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): Promise<string> {
    assertExactObject(request.params, ["body", "envelope"]);
    const envelope = request.params.envelope as BrokerRequestEnvelope;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
      throw new BrokerProtocolError("invalid_request", "Memory envelope is invalid");
    }
    const body = validateMemoryBody(envelope.operation, request.params.body);
    const bodyBytes = Buffer.from(JSON.stringify(body));
    const vault = this.#vaultContext();
    const memory = this.#localMemory();
    if (envelope.operation === "memory.remember") {
      const note = this.#authority().executeAuthorizedMutation(
        envelope,
        bodyBytes,
        (_database, authorization) => {
          const remember = body as {
            content: string;
            source?: SourceContext;
          };
          const remembered = memory.rememberInCurrentTransaction(vault, {
            content: remember.content,
            ...(remember.source ? { source: remember.source } : {}),
          });
          return {
            result: remembered,
            noteRefs: [{ noteId: remembered.id, revision: remembered.revision }],
          };
        },
        transportBinding,
      );
      return success(request.requestId, { note });
    }
    const result = await this.#authority().executeAuthorizedRead<unknown>(
      envelope,
      bodyBytes,
      async () => {
        switch (envelope.operation) {
          case "memory.recall": {
            const recall = body as { query: string; limit: number };
            const results = await memory.recall(vault, recall.query, recall.limit);
            return {
              result: { results },
              noteRefs: results.map(({ citation }) => ({
                noteId: citation.noteId,
                revision: citation.revision,
              })),
            };
          }
          case "memory.get_note": {
            const note = await memory.getNote(vault, (body as { id: string }).id);
            return {
              result: { note },
              noteRefs: note ? [{ noteId: note.id, revision: note.revision }] : [],
            };
          }
          case "memory.forget": {
            const id = (body as { id: string }).id;
            const note = await memory.getNote(vault, id);
            const forgotten = await memory.forget(vault, id);
            return {
              result: { id, forgotten },
              noteRefs: note && forgotten
                ? [{ noteId: note.id, revision: note.revision }]
                : [],
            };
          }
          default:
            throw new BrokerProtocolError("scope_denied", "Memory operation is not supported");
        }
      },
      transportBinding,
    );
    return success(request.requestId, result);
  }

  #beginLibrarySession(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    this.#librarySessions.delete(ownerSessionKey(transportBinding));
    assertExactObject(request.params, ["requestedScopes", "ttlMs"]);
    const scopes = libraryScopes(request.params.requestedScopes);
    librarySessionTtl(request.params.ttlMs);
    const ttlMs = this.#authority().routineAuthenticationTtlMilliseconds();
    const challengeId = randomUUID();
    const sessionId = randomUUID();
    const now = this.#currentTime();
    const challengeExpiresAt = now + OWNER_CHALLENGE_TTL_MS;
    const sessionExpiresAt = now + ttlMs;
    const ownerTranscript = canonicalBrokerTranscript({
      action: "owner-begin-native-library",
      protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
      brokerBootId: this.bootId,
      vaultId: this.#vaultContext().vaultId,
      connectionId: transportBinding.connectionId,
      peerPid: transportBinding.peerPid,
      peerRole: "owner-control",
      peerCodeIdentity: "gateway-attested-owner-control",
      challengeId,
      sessionId,
      issuedAt: new Date(now).toISOString(),
      challengeExpiresAt: new Date(challengeExpiresAt).toISOString(),
      sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
      scopes,
    });
    this.#pendingPresence.set(challengeId, {
      kind: "library-session",
      requestId: request.requestId,
      sessionId,
      scopes,
      ownerTranscript,
      challengeExpiresAt,
      sessionExpiresAt,
      binding: transportBinding,
    });
    const canMutate = scopes.includes("library.remember") ||
      scopes.includes("library.update_note");
    return ownerPresenceChallenge(
      challengeId,
      `Open the Afternote Library for ${formatSessionDuration(ttlMs)}? ` +
        `This allows reading note text, source context, and revision history${
          canMutate ? ", plus explicit create and revision-safe edit" : ""
        }. Permanent deletion always requires another prompt.`,
      challengeExpiresAt,
    );
  }

  async #executeLibrary(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): Promise<string> {
    const memory = this.#localMemory();
    const vault = this.#vaultContext();
    const authority = this.#authority();
    switch (request.method) {
      case "library.views": {
        assertExactObject(request.params, []);
        const session = this.#librarySession(transportBinding, ["library.browse"]);
        const result = await authority.executeNativeLibraryRead(
          session.sessionId,
          request.method,
          async () => ({
            result: {
              views: memory.smartViews(vault).map(({ id, label, noteCount }) => ({
                id,
                label,
                noteCount,
              })),
            },
            noteRefs: [],
          }),
        );
        return this.#librarySuccess(request.requestId, result);
      }
      case "library.browse": {
        assertExactObject(request.params, ["cursor", "limit", "view"]);
        const session = this.#librarySession(transportBinding, ["library.browse"]);
        const limit = boundedLibraryLimit(
          request.params.limit,
          LIBRARY_MAX_PAGE_SIZE,
          "browse page size",
        );
        const view = nullableLibraryView(request.params.view);
        const memoryCursor = this.#decodeLibraryCursor(
          request.params.cursor,
          "browse",
          { view },
        );
        const page = await authority.executeNativeLibraryRead(
          session.sessionId,
          request.method,
          async () => {
            const loaded = view === null
              ? await memory.browseNotes(vault, { limit, ...(memoryCursor ? { cursor: memoryCursor } : {}) })
              : await memory.browseSmartView(
                  vault,
                  view,
                  { limit, ...(memoryCursor ? { cursor: memoryCursor } : {}) },
                );
            return {
              result: {
                notes: loaded.notes.map((note) => libraryNoteSummary(note)),
                nextCursor: loaded.nextCursor
                  ? this.#libraryCursors!.encode({
                      operation: "browse",
                      filter: { view },
                      memoryCursor: loaded.nextCursor,
                    })
                  : null,
              },
              noteRefs: loaded.notes.map((note) => ({
                noteId: note.id,
                revision: note.revision,
              })),
            };
          },
        );
        return this.#librarySuccess(request.requestId, page);
      }
      case "library.search": {
        assertExactObject(request.params, ["cursor", "limit", "query"]);
        const session = this.#librarySession(transportBinding, ["library.search"]);
        const query = libraryQuery(request.params.query);
        const limit = boundedLibraryLimit(
          request.params.limit,
          LIBRARY_MAX_SEARCH_RESULTS,
          "search result limit",
        );
        const filter = {
          querySha256: createHash("sha256").update(query).digest("hex"),
        };
        const memoryCursor = this.#decodeLibraryCursor(
          request.params.cursor,
          "search",
          filter,
        );
        const startedAt = performance.now();
        const page = await authority.executeNativeLibraryRead(
          session.sessionId,
          request.method,
          async () => {
            let loaded: Awaited<ReturnType<SqliteMemory["searchNotesWithDeadline"]>>;
            try {
              loaded = await memory.searchNotesWithDeadline(
                vault,
                {
                  query,
                  limit,
                  ...(memoryCursor ? { cursor: memoryCursor } : {}),
                },
                MAX_LIBRARY_SEARCH_MS,
              );
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.toLowerCase().includes("interrupted")
              ) {
                throw new BrokerProtocolError(
                  "rate_limited",
                  "Library search exceeded its work limit",
                );
              }
              throw error;
            }
            if (performance.now() - startedAt > MAX_LIBRARY_SEARCH_MS) {
              throw new BrokerProtocolError("rate_limited", "Library search exceeded its work limit");
            }
            return {
              result: {
                results: loaded.results.map((result) => librarySearchResult(result)),
                searchMode: loaded.searchMode,
                nextCursor: loaded.nextCursor
                  ? this.#libraryCursors!.encode({
                      operation: "search",
                      filter,
                      memoryCursor: loaded.nextCursor,
                    })
                  : null,
              },
              noteRefs: loaded.results.map(({ citation }) => ({
                noteId: citation.noteId,
                revision: citation.revision,
              })),
            };
          },
        );
        return this.#librarySuccess(request.requestId, page);
      }
      case "library.get_note": {
        assertExactObject(request.params, ["id", "revision"]);
        const session = this.#librarySession(transportBinding, [
          "library.get_note",
          "library.inspect_source",
        ]);
        const id = uuid(request.params.id, "note ID");
        const revision = nullablePositiveInteger(request.params.revision, "note revision");
        const result = await authority.executeNativeLibraryRead(
          session.sessionId,
          request.method,
          async () => {
            const value = revision === null
              ? await memory.getNote(vault, id)
              : memory.getNoteRevisionInCurrentTransaction(vault, id, revision);
            const current = revision === null ? value : await memory.getNote(vault, id);
            return {
              result: {
                note: value,
                deleteTarget: current && "updatedAt" in current
                  ? libraryDeleteTarget(current)
                  : null,
              },
              noteRefs: value
                ? [{ noteId: "id" in value ? value.id : value.noteId, revision: value.revision }]
                : [],
            };
          },
        );
        return this.#librarySuccess(request.requestId, result);
      }
      case "library.list_revisions": {
        assertExactObject(request.params, ["cursor", "id", "limit"]);
        const session = this.#librarySession(transportBinding, [
          "library.list_revisions",
          "library.inspect_source",
        ]);
        const id = uuid(request.params.id, "note ID");
        const limit = boundedLibraryLimit(
          request.params.limit,
          LIBRARY_MAX_REVISION_PAGE_SIZE,
          "revision page size",
        );
        const memoryCursor = this.#decodeLibraryCursor(
          request.params.cursor,
          "revisions",
          { id },
        );
        const page = await authority.executeNativeLibraryRead(
          session.sessionId,
          request.method,
          async () => {
            const current = await memory.getNote(vault, id);
            if (!current) throw new MemoryError("not_found", "Note was not found");
            const loaded = await memory.listNoteRevisions(vault, id, {
              limit,
              ...(memoryCursor ? { cursor: memoryCursor } : {}),
            });
            return {
              result: {
                revisions: loaded.revisions.map(libraryRevisionSummary),
                nextCursor: loaded.nextCursor
                  ? this.#libraryCursors!.encode({
                      operation: "revisions",
                      filter: { id },
                      memoryCursor: loaded.nextCursor,
                    })
                  : null,
              },
              noteRefs: loaded.revisions.map((revision) => ({
                noteId: revision.noteId,
                revision: revision.revision,
              })),
            };
          },
        );
        return this.#librarySuccess(request.requestId, page);
      }
      case "library.remember": {
        assertExactObject(request.params, ["content", "source"]);
        const session = this.#librarySession(transportBinding, ["library.remember"]);
        const content = libraryNoteContent(request.params.content);
        const source = nullableLibrarySource(request.params.source);
        const note = authority.executeNativeLibraryMutation(
          session.sessionId,
          request.method,
          () => {
            const remembered = memory.rememberInCurrentTransaction(vault, {
              content,
              ...(source ? { source } : {}),
            });
            return {
              result: remembered,
              noteRefs: [{ noteId: remembered.id, revision: remembered.revision }],
            };
          },
        );
        return this.#librarySuccess(request.requestId, { note });
      }
      case "library.update_note": {
        assertExactObject(request.params, ["content", "expectedRevision", "id", "source"]);
        const session = this.#librarySession(transportBinding, ["library.update_note"]);
        const id = uuid(request.params.id, "note ID");
        const expectedRevision = positiveInteger(
          request.params.expectedRevision,
          "expected revision",
        );
        const content = libraryNoteContent(request.params.content);
        const source = nullableLibrarySource(request.params.source);
        const note = authority.executeNativeLibraryMutation(
          session.sessionId,
          request.method,
          () => {
            const updated = memory.updateNoteInCurrentTransaction(vault, id, {
              content,
              expectedRevision,
              source,
            });
            return {
              result: updated,
              noteRefs: [{ noteId: updated.id, revision: updated.revision }],
            };
          },
        );
        return this.#librarySuccess(request.requestId, { note });
      }
      case "library.delete":
        return this.#requestLibraryDelete(request, transportBinding);
      default:
        throw new BrokerProtocolError("not_found", "Library method is not available");
    }
  }

  #requestLibraryDelete(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, ["expectedRevision", "id", "targetDescription"]);
    const session = this.#librarySession(transportBinding, [
      "library.get_note",
      "library.inspect_source",
    ]);
    let noteId: string | undefined;
    let noteRevision: number | undefined;
    try {
      noteId = uuid(request.params.id, "note ID");
      noteRevision = positiveInteger(request.params.expectedRevision, "expected revision");
      const targetDescription = boundedString(
        request.params.targetDescription,
        140,
        "delete target description",
      );
      const note = this.#localMemory().getNoteInCurrentTransaction(
        this.#vaultContext(),
        noteId,
      );
      if (!note) throw new MemoryError("not_found", "Note was not found");
      if (
        note.revision !== noteRevision ||
        libraryDeleteTarget(note) !== targetDescription
      ) {
        throw new BrokerProtocolError(
          "conflict",
          "Delete target changed; refresh before deleting",
        );
      }
      const challengeId = randomUUID();
      const issuedAt = this.#currentTime();
      const challengeExpiresAt = Math.min(
        issuedAt + LIBRARY_DELETE_CHALLENGE_TTL_MS,
        session.expiresAt,
      );
      const ownerTranscript = canonicalBrokerTranscript({
        action: "owner-delete-native-library-note",
        protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
        brokerBootId: this.bootId,
        vaultId: this.#vaultContext().vaultId,
        connectionId: transportBinding.connectionId,
        peerPid: transportBinding.peerPid,
        peerRole: "owner-control",
        peerCodeIdentity: "gateway-attested-owner-control",
        challengeId,
        issuedAt: new Date(issuedAt).toISOString(),
        challengeExpiresAt: new Date(challengeExpiresAt).toISOString(),
        sessionId: session.sessionId,
        noteId,
        noteRevision,
        targetDescription,
      });
      this.#pendingPresence.set(challengeId, {
        kind: "library-delete",
        requestId: request.requestId,
        sessionId: session.sessionId,
        noteId,
        noteRevision,
        targetDescription,
        ownerTranscript,
        challengeExpiresAt,
        binding: transportBinding,
      });
      return ownerPresenceChallenge(
        challengeId,
        `Permanently delete revision ${noteRevision} of “${targetDescription}”? This cannot be undone.`,
        challengeExpiresAt,
      );
    } catch (error) {
      this.#authority().recordNativeLibraryOutcome(
        session.sessionId,
        "library.delete",
        "error",
        brokerAuditErrorCode(error),
        noteId && noteRevision ? [{ noteId, revision: noteRevision }] : [],
      );
      throw error;
    }
  }

  #librarySession(
    transportBinding: BrokerTransportBinding,
    scopes: LibraryScope[],
  ): LibrarySession {
    const key = ownerSessionKey(transportBinding);
    const session = this.#librarySessions.get(key);
    if (!session) {
      throw new BrokerProtocolError(
        "library_session_required",
        "Library access requires native owner authentication",
      );
    }
    if (
      session.expiresAt <= this.#currentTime() ||
      session.brokerBootId !== this.bootId ||
      session.vaultId !== this.#vaultContext().vaultId
    ) {
      this.#librarySessions.delete(key);
      throw new BrokerProtocolError("library_session_expired", "Library session expired");
    }
    if (!bindingsEqual(session.binding, transportBinding)) {
      this.#librarySessions.delete(key);
      throw new BrokerProtocolError("identity_mismatch", "Library session peer changed");
    }
    if (scopes.some((scope) => !session.scopes.includes(scope))) {
      throw new BrokerProtocolError("scope_denied", "Library scope is not granted");
    }
    return session;
  }

  #decodeLibraryCursor(
    value: unknown,
    operation: "browse" | "search" | "revisions",
    filter: unknown,
  ): string | undefined {
    if (value === null) return undefined;
    if (typeof value !== "string") {
      throw new BrokerProtocolError("invalid_request", "Library cursor is invalid");
    }
    try {
      return this.#libraryCursors!.decode({ cursor: value, operation, filter });
    } catch (error) {
      throw new BrokerProtocolError("invalid_cursor", safeErrorMessage(error));
    }
  }

  #librarySuccess(requestId: string, result: unknown): string {
    const response = success(requestId, result);
    if (Buffer.byteLength(response) > MAX_LIBRARY_RESPONSE_BYTES) {
      throw new BrokerProtocolError(
        "response_too_large",
        "Library response exceeded its plaintext limit",
      );
    }
    return response;
  }

  #requestRevocation(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    this.#ownerSession(transportBinding, [
      "owner.inspect_clients",
      "owner.inspect_grants",
      "owner.inspect_sessions",
    ]);
    assertExactObject(request.params, [
      "authorityRevision",
      "clientId",
      "displayLabel",
      "kind",
      "scopes",
    ]);
    const target: OwnerRevocationTarget = {
      clientId: uuid(request.params.clientId, "client ID"),
      kind: clientKind(request.params.kind),
      displayLabel: boundedString(request.params.displayLabel, 120, "display label"),
      authorityRevision: positiveInteger(
        request.params.authorityRevision,
        "authority revision",
      ),
      scopes: capabilities(request.params.scopes),
    };
    const current = this.#authority().revocationTarget(target.clientId);
    if (canonicalBrokerTranscript(current) !== canonicalBrokerTranscript(target)) {
      throw new BrokerProtocolError("conflict", "Revocation target changed");
    }
    const challengeId = randomUUID();
    const challengeExpiresAt = this.#currentTime() + OWNER_CHALLENGE_TTL_MS;
    const ownerTranscript = canonicalBrokerTranscript({
      action: "owner-revoke-client",
      protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
      brokerBootId: this.bootId,
      vaultId: this.#vaultContext().vaultId,
      connectionId: transportBinding.connectionId,
      peerPid: transportBinding.peerPid,
      challengeId,
      challengeExpiresAt: new Date(challengeExpiresAt).toISOString(),
      target,
    });
    this.#pendingPresence.set(challengeId, {
      kind: "revocation",
      requestId: request.requestId,
      target,
      ownerTranscript,
      challengeExpiresAt,
      binding: transportBinding,
    });
    return ownerPresenceChallenge(
      challengeId,
      `Revoke ${target.displayLabel}? Scopes: ${formatCapabilities(target.scopes)}. ` +
        "Active and pending sessions stop on their next request.",
      challengeExpiresAt,
    );
  }

  #requestConnectorRevocation(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    this.#ownerSession(transportBinding, [
      "owner.inspect_clients",
      "owner.inspect_grants",
      "owner.inspect_sessions",
    ]);
    assertExactObject(request.params, ["kind"]);
    const target = this.#authority().connectorRevocationTarget(
      ownerClientKind(request.params.kind),
    );
    const challengeId = randomUUID();
    const challengeExpiresAt = this.#currentTime() + OWNER_CHALLENGE_TTL_MS;
    const ownerTranscript = canonicalBrokerTranscript({
      action: "owner-revoke-connector",
      protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
      brokerBootId: this.bootId,
      vaultId: this.#vaultContext().vaultId,
      connectionId: transportBinding.connectionId,
      peerPid: transportBinding.peerPid,
      challengeId,
      challengeExpiresAt: new Date(challengeExpiresAt).toISOString(),
      target,
    });
    this.#pendingPresence.set(challengeId, {
      kind: "connector-revocation",
      requestId: request.requestId,
      target,
      ownerTranscript,
      challengeExpiresAt,
      binding: transportBinding,
    });
    const scopes = [...new Set(
      target.clients.flatMap((client) => client.scopes),
    )] as BrokerCapability[];
    return ownerPresenceChallenge(
      challengeId,
      `Revoke ${target.displayLabel}? ${target.clients.length} client ` +
        `${target.clients.length === 1 ? "identity" : "identities"} will lose ` +
        `${formatCapabilities(scopes)}. Active and pending sessions stop on their next request.`,
      challengeExpiresAt,
    );
  }

  #beginAdmin(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    let operation: Extract<PendingPresence, { kind: "admin" }>["operation"];
    let reason: string;
    if (request.method === "admin.prepare_client_rotation") {
      assertExactObject(request.params, [
        "installIdentity",
        "kind",
        "replacementInstallIdentity",
      ]);
      if (this.#trustPath !== "development-only") {
        throw new BrokerProtocolError(
          "scope_denied",
          "Development client identity rotation is unavailable for production-signed builds",
        );
      }
      const kind = mcpClientKind(request.params.kind);
      const installIdentity = uuid(request.params.installIdentity, "install identity");
      const replacementInstallIdentity = uuid(
        request.params.replacementInstallIdentity,
        "replacement install identity",
      );
      if (replacementInstallIdentity === installIdentity) {
        throw new BrokerProtocolError(
          "invalid_request",
          "Replacement install identity must be new",
        );
      }
      let target: OwnerClientRotationTarget;
      try {
        target = this.#authority().clientRotationTarget(kind, installIdentity);
        operation = { kind: "client-rotation", target, replacementInstallIdentity };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "MCP client identity was not revoked for rotation"
        ) {
          try {
            target = this.#authority().revokedClientReplacementTarget(
              kind,
              installIdentity,
            );
            operation = {
              kind: "revoked-client-replacement",
              target,
              replacementInstallIdentity,
            };
          } catch {
            throw new BrokerProtocolError(
              "conflict",
              "The revoked development MCP client identity cannot be replaced safely",
            );
          }
        } else {
          throw new BrokerProtocolError(
            "conflict",
            "The development MCP client identity is unavailable or ambiguous",
          );
        }
      }
      reason = operation.kind === "revoked-client-replacement"
        ? `Replace revoked ${target.displayLabel} (${target.kind}) identity for installation ${
          target.installIdentity
        }? Its old grants and sessions remain revoked. The replacement must pair again.`
        : target.clientId === null
        ? `Replace orphaned ${target.displayLabel} (${target.kind}) identity for installation ${
          target.installIdentity
        }? The broker has no matching client authority after the vault reset.`
        : `Rotate ${target.displayLabel} (${target.kind}) identity for installation ${
          target.installIdentity
        }? Scopes: ${
          formatCapabilities(target.scopes)
        }. Its active and pending sessions will be revoked before local state changes.`;
    } else if (request.method === "admin.export") {
      assertExactObject(request.params, ["destination", "format"]);
      const destination = adminDestination(request.params.destination);
      const format = adminExportFormat(request.params.format);
      operation = { kind: "export", destination, format };
      reason = `Export Afternote ${format === "json" ? "JSON" : "Markdown"} to this exact path: ${destination}? The export contains plaintext notes.`;
    } else if (request.method === "admin.diagnostics") {
      assertExactObject(request.params, []);
      operation = { kind: "diagnostics" };
      reason = "Inspect share-safe Afternote diagnostics? Note text and local paths are excluded.";
    } else {
      throw new BrokerProtocolError("method_not_found", "Unknown broker method");
    }
    const challengeId = randomUUID();
    const challengeExpiresAt = this.#currentTime() + OWNER_CHALLENGE_TTL_MS;
    this.#pendingPresence.set(challengeId, {
      kind: "admin",
      requestId: request.requestId,
      operation,
      challengeExpiresAt,
      binding: transportBinding,
    });
    return ownerPresenceChallenge(challengeId, reason, challengeExpiresAt);
  }

  #lifecycleStatus(request: BrokerRequest): string {
    assertExactObject(request.params, []);
    this.#ensureLifecycleLoaded();
    return success(request.requestId, {
      state: this.#lifecycleState,
      epoch: this.#lifecycleEpoch,
    });
  }

  #beginLifecycleTransition(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, []);
    this.#ensureLifecycleLoaded();
    if (this.#pendingLifecycleChallengeId) {
      const pending = this.#pendingPresence.get(this.#pendingLifecycleChallengeId);
      if (
        pending?.kind === "lifecycle" &&
        pending.challengeExpiresAt <= this.#currentTime()
      ) {
        this.#pendingPresence.delete(this.#pendingLifecycleChallengeId);
        this.#pendingLifecycleChallengeId = undefined;
        this.#recordLifecycleOutcome(pending.operation, "denied", "owner_timeout");
      } else {
        throw new BrokerProtocolError(
          "transition_in_progress",
          "Another vault lifecycle decision is pending",
        );
      }
    }
    const operation = request.method === "lifecycle.lock" ? "lock" : "unlock";
    const expectedState = operation === "lock" ? "unlocked" : "locked";
    if (this.#lifecycleState !== expectedState) {
      throw new BrokerProtocolError(
        this.#lifecycleState === "locked" ? "already_locked" :
          this.#lifecycleState === "unlocked" ? "already_unlocked" :
          "transition_in_progress",
        this.#lifecycleState === "locked" ? "Afternote vault is already locked" :
          this.#lifecycleState === "unlocked" ? "Afternote vault is already unlocked" :
          "Another vault lifecycle transition is in progress",
      );
    }
    if (operation === "lock") this.#openVault(false);
    const challengeId = randomUUID();
    const challengeExpiresAt = this.#currentTime() + OWNER_CHALLENGE_TTL_MS;
    const vault = this.#configuredVault ?? localVaultContext(
      this.#configuredVaultPath ?? process.env.AFTERNOTE_VAULT_PATH ??
        join(homedir(), ".afternote", "vault.db"),
    );
    const ownerTranscript = canonicalBrokerTranscript({
      action: `owner-${operation}-vault`,
      protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
      brokerBootId: this.bootId,
      vaultId: vault.vaultId,
      lifecycleEpoch: this.#lifecycleEpoch,
      currentState: expectedState,
      targetState: operation === "lock" ? "locked" : "unlocked",
      connectionId: transportBinding.connectionId,
      peerPid: transportBinding.peerPid,
      peerRole: "owner-control",
      challengeId,
      challengeExpiresAt: new Date(challengeExpiresAt).toISOString(),
    });
    this.#pendingLifecycleChallengeId = challengeId;
    this.#pendingPresence.set(challengeId, {
      kind: "lifecycle",
      requestId: request.requestId,
      operation,
      expectedState,
      expectedEpoch: this.#lifecycleEpoch,
      challengeExpiresAt,
      binding: transportBinding,
    });
    return ownerPresenceChallenge(
      challengeId,
      operation === "lock"
        ? "Lock Afternote? Active access will end and the encrypted vault will close."
        : "Unlock Afternote? This opens the encrypted vault with a fresh authorization epoch.",
      challengeExpiresAt,
      {
        operation: request.method,
        currentState: expectedState,
        epoch: this.#lifecycleEpoch,
        transcriptSha256: createHash("sha256").update(ownerTranscript).digest("hex"),
      },
    );
  }

  #beginRecoveryMigration(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, [
      "artifactAction",
      "artifactDestinationDirectory",
      "liveAction",
      "liveDestination",
    ]);
    const recoveryState = this.#classifyRecoveryState();
    if (
      recoveryState !== "migration-required" &&
      recoveryState !== "migration-resume-required" &&
      recoveryState !== "migration-manual-resume-required"
    ) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "The vault is not eligible for plaintext migration",
      );
    }
    if (this.#authorization || this.#database || this.#lifecycleLoaded) {
      throw new BrokerProtocolError(
        "conflict",
        "The active vault is not eligible for plaintext migration",
      );
    }
    if (this.#pendingLifecycleChallengeId) {
      throw new BrokerProtocolError(
        "transition_in_progress",
        "A vault lifecycle decision is already pending",
      );
    }
    if (this.#pendingRecoveryChallengeId) {
      const pending = this.#pendingPresence.get(this.#pendingRecoveryChallengeId);
      if (isRecoveryPresence(pending) && pending.challengeExpiresAt <= this.#currentTime()) {
        this.#pendingPresence.delete(this.#pendingRecoveryChallengeId);
        this.#pendingRecoveryChallengeId = undefined;
      } else {
        throw new BrokerProtocolError(
          "transition_in_progress",
          "Another vault recovery decision is pending",
        );
      }
    }
    const { vaultPath } = this.#vaultConfiguration();
    let approvalSnapshot: EncryptionMigrationApprovalSnapshot;
    try {
      approvalSnapshot = encryptionMigrationApprovalSnapshot(vaultPath);
    } catch {
      throw new BrokerProtocolError(
        "conflict",
        "The vault is not eligible for plaintext migration",
      );
    }
    const liveDecision = recoveryLiveDecision(
      request.params.liveAction,
      request.params.liveDestination,
    );
    const artifactPolicy = recoveryArtifactPolicy(
      request.params.artifactAction,
      request.params.artifactDestinationDirectory,
    );
    const coordinationDigest = recoveryCoordinationDigest(
      liveDecision,
      artifactPolicy,
    );
    const challengeId = randomUUID();
    const challengeExpiresAt = this.#currentTime() + OWNER_CHALLENGE_TTL_MS;
    this.#pendingRecoveryChallengeId = challengeId;
    this.#pendingPresence.set(challengeId, {
      kind: "recovery-migration",
      requestId: request.requestId,
      vaultPath,
      liveDecision,
      artifactAction: artifactPolicy.action,
      artifactDestinationDirectory: artifactPolicy.destinationDirectory,
      approvalSnapshot,
      approvalSnapshotDigest: recoveryApprovalSnapshotDigest(approvalSnapshot),
      coordinationDigest,
      challengeExpiresAt,
      binding: transportBinding,
    });
    const verb = approvalSnapshot.readiness === "resumable" ? "Resume migrating" : "Migrate";
    return ownerPresenceChallenge(
      challengeId,
      `${verb} this Afternote vault to encrypted storage? ` +
        `The displaced live plaintext will be ${recoveryDecisionDescription(liveDecision)}. ` +
        `${approvalSnapshot.artifacts.length} discovered plaintext backup${approvalSnapshot.artifacts.length === 1 ? "" : "s"} ` +
        `will be ${recoveryArtifactDescription(artifactPolicy)}.`,
      challengeExpiresAt,
    );
  }

  #recoveryStatus(request: BrokerRequest): string {
    assertExactObject(request.params, []);
    return success(request.requestId, { state: this.#classifyRecoveryState() });
  }

  #classifyRecoveryState(): string {
    const { vaultPath } = this.#vaultConfiguration();
    let vaultEntry: "absent" | "regular";
    let migrationPending: boolean;
    let restorePending: boolean;
    try {
      vaultEntry = recoveryEntryKind(vaultPath, "vault");
      const migrationMarker = recoveryEntryKind(
        `${vaultPath}.encryption-migration.json`,
        "migration marker",
      );
      const restoreMarker = recoveryEntryKind(
        `${vaultPath}.restore-recovery.json`,
        "restore marker",
      );
      migrationPending = migrationMarker === "regular" &&
        encryptionMigrationRecoveryPending(vaultPath);
      restorePending = restoreMarker === "regular" &&
        cleanVaultRestoreRecoveryPending(vaultPath);
    } catch {
      throw new BrokerProtocolError(
        "recovery_state_invalid",
        "Vault recovery state is invalid",
      );
    }
    let state: string;
    if (restorePending && migrationPending) {
      state = "conflict";
    } else if (restorePending) {
      state = "restore-resume-required";
    } else if (migrationPending) {
      const preserveDigest = recoveryCoordinationDigest(
        { action: "keep" },
        { action: "keep", destinationDirectory: null },
      );
      state = encryptionMigrationRecoveryCoordinationDigest(vaultPath) ===
          preserveDigest
        ? "migration-resume-required"
        : "migration-manual-resume-required";
    } else if (vaultEntry === "absent") {
      state = "empty";
    } else {
      let migration: ReturnType<typeof encryptionMigrationReadiness>;
      try {
        migration = encryptionMigrationReadiness(vaultPath);
      } catch {
        throw new BrokerProtocolError(
          "recovery_state_invalid",
          "Vault recovery state is invalid",
        );
      }
      state = migration === "plaintext"
        ? "migration-required"
        : "encrypted-candidate";
      if (state === "encrypted-candidate" && this.#vaultKeyReader) {
        const key = this.#vaultKeyReader(this.#vaultConfiguration().vault.vaultId);
        if (key === null) {
          state = "vault-key-unavailable";
        } else {
          try {
            if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
              throw new BrokerProtocolError(
                "recovery_state_invalid",
                "Vault recovery state is invalid",
              );
            }
            let verification: SqlcipherDatabase | undefined;
            try {
              verification = new SqlcipherDatabase(vaultPath, {
                key,
                readonly: true,
              });
              verification.query<{ quick_check: string }, []>(
                "pragma quick_check",
              ).get();
            } catch (error) {
              if (error instanceof BrokerProtocolError) throw error;
              throw new BrokerProtocolError(
                "recovery_state_invalid",
                "Vault recovery state is invalid",
              );
            } finally {
              verification?.close();
            }
          } finally {
            key.fill(0);
          }
        }
      }
    }
    return state;
  }

  #executeApprovedRecoveryMigration(
    pending: Extract<PendingPresence, { kind: "recovery-migration" }>,
  ): string {
    const { vaultPath, vault } = this.#vaultConfiguration();
    if (vaultPath !== pending.vaultPath) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Vault recovery target changed before approval completed",
      );
    }
    const recoveryState = this.#classifyRecoveryState();
    if (
      recoveryState !== "migration-required" &&
      recoveryState !== "migration-resume-required" &&
      recoveryState !== "migration-manual-resume-required"
    ) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Vault recovery state changed before approval completed",
      );
    }
    let currentSnapshot: EncryptionMigrationApprovalSnapshot;
    try {
      currentSnapshot = encryptionMigrationApprovalSnapshot(vaultPath);
    } catch {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Vault recovery target changed before approval completed",
      );
    }
    if (
      recoveryApprovalSnapshotDigest(currentSnapshot) !== pending.approvalSnapshotDigest
    ) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Vault or plaintext backup inventory changed before approval completed",
      );
    }
    this.#onRecoveryApprovalRevalidatedForTest?.("migration");
    const legacyArtifactDecisions: LegacyArtifactDecision[] =
      pending.approvalSnapshot.artifacts.map((artifact) => ({
        path: artifact.path,
        decision: pending.artifactAction === "keep"
          ? { action: "keep" as const }
          : pending.artifactAction === "delete"
            ? { action: "delete" as const }
            : {
                action: "move" as const,
                destinationPath: join(
                  pending.artifactDestinationDirectory!,
                  basename(artifact.path),
                ),
              },
      }));
    try {
      validateLegacyArtifactDecisions(
        pending.approvalSnapshot.artifacts.map((artifact) => artifact.path),
        legacyArtifactDecisions,
      );
    } catch {
      throw new BrokerProtocolError(
        "transition_conflict",
        "The approved plaintext artifact move plan is unsafe",
      );
    }
    if (pending.artifactAction === "move") {
      mkdirSync(pending.artifactDestinationDirectory!, {
        recursive: true,
        mode: 0o700,
      });
    }
    const key = this.#retrieveVaultKey(vault);
    let result: ReturnType<typeof migratePlaintextVault>;
    try {
      const finalRecoveryState = this.#classifyRecoveryState();
      if (
        finalRecoveryState !== "migration-required" &&
        finalRecoveryState !== "migration-resume-required" &&
        finalRecoveryState !== "migration-manual-resume-required"
      ) {
        throw new BrokerProtocolError(
          "transition_conflict",
          "Vault recovery state changed immediately before migration",
        );
      }
      result = migratePlaintextVault({
        databasePath: vaultPath,
        key,
        legacyDecision: pending.liveDecision,
        legacyArtifactDecisions,
        injectFault: this.#onEncryptionMigrationPhaseForTest,
        coordinationDigest: pending.coordinationDigest,
        deferFinalization: true,
        lifecycleLock: this.#vaultLifecycleLock,
      });
    } catch (error) {
      if (error instanceof BrokerProtocolError) throw error;
      this.#terminateAfterResponse = true;
      throw new BrokerProtocolError(
        "recovery_failed",
        "Vault migration did not complete; rerun the same command to resume safely",
      );
    } finally {
      key.fill(0);
    }
    try {
      this.#openVault(false);
      const response = this.#authority().executeNativeOwnerAdmin(
        "recovery.migrate",
        () => success(pending.requestId, {
          migrated: true,
          state: "unlocked",
          epoch: this.#lifecycleEpoch,
          encryptedRollbackCreated: true,
          legacyPlaintextRetained: result.legacyPlaintextRetained,
          legacyArtifacts: {
            found: result.legacyArtifactsFound,
            retained: result.legacyArtifactsRetained,
          },
        }),
      );
      finalizePlaintextVaultMigration(
        vaultPath,
        pending.coordinationDigest,
        this.#vaultLifecycleLock,
      );
      return response;
    } catch {
      this.#terminateAfterResponse = true;
      try {
        this.#closeVaultHandles();
      } catch {
        // The worker is already marked for retirement.
      }
      throw new BrokerProtocolError(
        "recovery_failed",
        "Vault migration finished but broker reopen requires a restart",
      );
    }
  }

  #beginRecoveryRestore(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, ["source"]);
    const recoveryState = this.#classifyRecoveryState();
    if (
      recoveryState !== "empty" &&
      recoveryState !== "restore-resume-required"
    ) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "The vault is not eligible for clean restore",
      );
    }
    if (this.#authorization || this.#database || this.#lifecycleLoaded) {
      throw new BrokerProtocolError(
        "conflict",
        "The active vault is not eligible for clean restore",
      );
    }
    if (this.#pendingLifecycleChallengeId) {
      throw new BrokerProtocolError(
        "transition_in_progress",
        "A vault lifecycle decision is already pending",
      );
    }
    if (this.#pendingRecoveryChallengeId) {
      const pending = this.#pendingPresence.get(this.#pendingRecoveryChallengeId);
      if (isRecoveryPresence(pending) && pending.challengeExpiresAt <= this.#currentTime()) {
        this.#pendingPresence.delete(this.#pendingRecoveryChallengeId);
        this.#pendingRecoveryChallengeId = undefined;
      } else {
        throw new BrokerProtocolError(
          "transition_in_progress",
          "Another vault recovery decision is pending",
        );
      }
    }
    const source = boundedString(request.params.source, 4_096, "restore source");
    if (!isAbsolute(source) || /[\p{Cc}\p{Cf}]/u.test(source)) {
      throw new BrokerProtocolError(
        "invalid_request",
        "Restore source must be an absolute path",
      );
    }
    const { vaultPath, vault } = this.#vaultConfiguration();
    let approvalSnapshot: CleanVaultRestoreApprovalSnapshot;
    try {
      approvalSnapshot = cleanVaultRestoreApprovalSnapshot(
        resolve(source),
        vaultPath,
        this.#applicationVersion,
      );
    } catch {
      throw new BrokerProtocolError(
        "conflict",
        "The export is not eligible for clean restore",
      );
    }
    const coordinationDigest = cleanVaultRestoreCoordinationDigest(
      approvalSnapshot,
      vaultPath,
      vault,
    );
    const challengeId = randomUUID();
    const challengeExpiresAt = this.#currentTime() + OWNER_CHALLENGE_TTL_MS;
    this.#pendingRecoveryChallengeId = challengeId;
    this.#pendingPresence.set(challengeId, {
      kind: "recovery-restore",
      requestId: request.requestId,
      vaultPath,
      approvalSnapshot,
      approvalSnapshotDigest: cleanVaultRestoreApprovalSnapshotDigest(approvalSnapshot),
      coordinationDigest,
      challengeExpiresAt,
      binding: transportBinding,
    });
    const verb = approvalSnapshot.readiness === "resumable" ? "Resume restoring" : "Restore";
    const noun = approvalSnapshot.noteCount === 1 ? "note" : "notes";
    return ownerPresenceChallenge(
      challengeId,
      `${verb} export SHA-256 ${approvalSnapshot.sourceDigest} ` +
        `(${approvalSnapshot.noteCount} ${noun}) from ${approvalSnapshot.sourcePath} ` +
        "into a clean encrypted Afternote vault?",
      challengeExpiresAt,
    );
  }

  #executeApprovedRecoveryRestore(
    pending: Extract<PendingPresence, { kind: "recovery-restore" }>,
  ): string {
    const { vaultPath, vault } = this.#vaultConfiguration();
    if (vaultPath !== pending.vaultPath) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Vault restore target changed before approval completed",
      );
    }
    const recoveryState = this.#classifyRecoveryState();
    if (
      recoveryState !== "empty" &&
      recoveryState !== "restore-resume-required"
    ) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Vault recovery state changed before approval completed",
      );
    }
    let currentSnapshot: CleanVaultRestoreApprovalSnapshot;
    try {
      currentSnapshot = cleanVaultRestoreApprovalSnapshot(
        pending.approvalSnapshot.sourcePath,
        vaultPath,
        this.#applicationVersion,
      );
    } catch {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Restore source or target changed before approval completed",
      );
    }
    if (
      cleanVaultRestoreApprovalSnapshotDigest(currentSnapshot) !==
        pending.approvalSnapshotDigest
    ) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Restore source or target changed before approval completed",
      );
    }
    this.#onRecoveryApprovalRevalidatedForTest?.("restore");
    const key = this.#retrieveVaultKey(vault);
    try {
      const finalRecoveryState = this.#classifyRecoveryState();
      if (
        finalRecoveryState !== "empty" &&
        finalRecoveryState !== "restore-resume-required"
      ) {
        throw new BrokerProtocolError(
          "transition_conflict",
          "Vault recovery state changed immediately before restore",
        );
      }
      const result = restoreCleanEncryptedVault({
        approvalSnapshot: pending.approvalSnapshot,
        applicationVersion: this.#applicationVersion,
        coordinationDigest: pending.coordinationDigest,
        databasePath: vaultPath,
        injectFault: this.#onCleanVaultRestorePhaseForTest,
        key,
        lifecycleLock: this.#vaultLifecycleLock,
        vault,
      });
      let response: string;
      if (result.auditComplete) {
        finalizeCleanVaultRestore(
          vaultPath,
          pending.coordinationDigest,
          key,
          this.#onCleanVaultRestorePhaseForTest,
          this.#vaultLifecycleLock,
        );
        this.#openVault(false);
        response = success(pending.requestId, {
          restored: true,
          state: "unlocked",
          epoch: this.#lifecycleEpoch,
          noteCount: result.noteCount,
          format: "afternote-vault-v1",
        });
      } else {
        this.#openVault(false);
        response = this.#authority().executeNativeOwnerAdmin(
          "recovery.restore",
          () => success(pending.requestId, {
            restored: true,
            state: "unlocked",
            epoch: this.#lifecycleEpoch,
            noteCount: result.noteCount,
            format: "afternote-vault-v1",
          }),
        );
        this.#closeVaultHandles();
        sealAuditedCleanVaultRestore(
          vaultPath,
          pending.coordinationDigest,
          key,
          this.#vaultLifecycleLock,
        );
        this.#onCleanVaultRestorePhaseForTest?.("after_audit_sealed");
        finalizeCleanVaultRestore(
          vaultPath,
          pending.coordinationDigest,
          key,
          this.#onCleanVaultRestorePhaseForTest,
          this.#vaultLifecycleLock,
        );
        this.#openVault(false);
      }
      return response;
    } catch (error) {
      if (error instanceof BrokerProtocolError) throw error;
      this.#terminateAfterResponse = true;
      try {
        this.#closeVaultHandles();
      } catch {
        // The worker is already marked for retirement.
      }
      throw new BrokerProtocolError(
        "recovery_failed",
        "Vault restore finished but broker reopen requires a restart",
      );
    } finally {
      key.fill(0);
    }
  }

  #completeLifecycleTransition(
    pending: Extract<PendingPresence, { kind: "lifecycle" }>,
  ): string {
    if (
      this.#lifecycleState !== pending.expectedState ||
      this.#lifecycleEpoch !== pending.expectedEpoch
    ) {
      throw new BrokerProtocolError(
        "transition_conflict",
        "Vault lifecycle state changed before approval completed",
      );
    }
    if (pending.operation === "lock") {
      this.#lifecycleState = "locking";
      let lockCommitted = false;
      try {
        const authority = this.#authorization;
        if (!authority || !this.#database) {
          throw new BrokerProtocolError(
            "lifecycle_transition_failed",
            "Vault storage was unavailable during lock",
          );
        }
        this.#database.transaction(() => {
          authority.invalidateEphemeralAuthorityForLock();
          authority.executeNativeOwnerAdmin("lifecycle.lock", () => {
            const changed = this.#database!.query(
              "update broker_lifecycle_state set state = 'locked', updated_at = ? where singleton = 1 and state = 'unlocked' and epoch = ?",
            ).run(new Date(this.#currentTime()).toISOString(), pending.expectedEpoch).changes;
            if (changed !== 1) {
              throw new BrokerProtocolError(
                "transition_conflict",
                "Vault lifecycle state changed before lock completed",
              );
            }
          });
          this.#onLockTransactionForTest?.();
        })();
        lockCommitted = true;
        this.#ownerSessions.clear();
        this.#librarySessions.clear();
        this.#activationTtls.clear();
        this.#ownerRequestIds.clear();
        this.#pendingPresence.clear();
        this.#lifecycleState = "locked";
        try {
          this.#closeVaultHandles();
        } finally {
          this.#configuredVaultKey?.fill(0);
          this.#configuredVaultKey = undefined;
        }
        return success(pending.requestId, {
          state: "locked",
          epoch: this.#lifecycleEpoch,
        });
      } catch {
        if (!lockCommitted) {
          this.#lifecycleState = "locking";
          try {
            this.#closeVaultHandles();
          } catch {
            this.#terminateAfterResponse = true;
          } finally {
            this.#configuredVaultKey?.fill(0);
            this.#configuredVaultKey = undefined;
            this.#terminateAfterResponse = true;
          }
          throw new BrokerProtocolError(
            "lifecycle_transition_failed",
            "Vault lock outcome is uncertain and the broker is restarting",
          );
        }
        this.#lifecycleState = "locked";
        try {
          this.#closeVaultHandles();
        } catch {
          this.#terminateAfterResponse = true;
        } finally {
          this.#configuredVaultKey?.fill(0);
          this.#configuredVaultKey = undefined;
        }
        throw new BrokerProtocolError(
          "lifecycle_transition_failed",
          "Afternote vault is locked after a lifecycle failure",
        );
      }
    }

    this.#lifecycleState = "unlocking";
    const priorEpoch = this.#lifecycleEpoch;
    const priorBootId = this.bootId;
    const nextEpoch = randomUUID();
    this.bootId = nextEpoch;
    try {
      this.#openVault(true);
      this.#lifecycleState = "unlocking";
      const authority = this.#authorization;
      if (!authority || !this.#database) {
        throw new BrokerProtocolError("unlock_failed", "Afternote vault remains locked");
      }
      while (this.#deferredLifecycleAudit.length > 0) {
        const event = this.#deferredLifecycleAudit[0]!;
        authority.recordNativeOwnerAdminOutcome(
          event.operation,
          event.outcome,
          event.errorCode,
        );
        this.#deferredLifecycleAudit.shift();
      }
      this.#database.transaction(() => {
        authority.executeNativeOwnerAdmin("lifecycle.unlock", () => {
          const changed = this.#database!.query(
            "update broker_lifecycle_state set state = 'unlocked', epoch = ?, updated_at = ? where singleton = 1 and state = 'locked' and epoch = ?",
          ).run(nextEpoch, new Date(this.#currentTime()).toISOString(), priorEpoch).changes;
          if (changed !== 1) {
            throw new BrokerProtocolError(
              "transition_conflict",
              "Vault lifecycle state changed before unlock completed",
            );
          }
        });
      })();
      this.#lifecycleEpoch = nextEpoch;
      this.#lifecycleState = "unlocked";
      return success(pending.requestId, { state: "unlocked", epoch: nextEpoch });
    } catch {
      try {
        this.#closeVaultHandles();
      } catch {
        this.#terminateAfterResponse = true;
      } finally {
        this.bootId = priorBootId;
        this.#lifecycleEpoch = priorEpoch;
        this.#lifecycleState = "locked";
        this.#deferLifecycleAudit("error", "unlock_failed");
      }
      throw new BrokerProtocolError("unlock_failed", "Afternote vault remains locked");
    }
  }

  #recordLifecycleOutcome(
    operation: "lock" | "unlock",
    outcome: "denied" | "error",
    errorCode: string,
  ): void {
    if (operation === "unlock" && this.#lifecycleState !== "unlocked") {
      this.#deferLifecycleAudit(outcome, errorCode);
      return;
    }
    try {
      this.#authority().recordNativeOwnerAdminOutcome(
        `lifecycle.${operation}`,
        outcome,
        errorCode,
      );
    } catch {
      if (operation === "unlock") this.#deferLifecycleAudit(outcome, errorCode);
    }
  }

  #deferLifecycleAudit(outcome: "denied" | "error", errorCode: string): void {
    if (this.#deferredLifecycleAudit.length >= 64) this.#deferredLifecycleAudit.shift();
    this.#deferredLifecycleAudit.push({
      operation: "lifecycle.unlock",
      outcome,
      errorCode,
    });
  }

  #executeApprovedAdmin(
    pending: Extract<PendingPresence, { kind: "admin" }>,
  ): string {
    const operation = pending.operation;
    if (
      operation.kind === "client-rotation" ||
      operation.kind === "revoked-client-replacement"
    ) {
      const target = operation.target;
      if (operation.kind === "client-rotation") {
        this.#authority().revokeClientForRotation(
          target,
          operation.replacementInstallIdentity,
        );
      } else {
        this.#authority().prepareRevokedClientReplacement(
          target,
          operation.replacementInstallIdentity,
        );
      }
      return success(pending.requestId, {
        prepared: true,
        kind: target.kind,
        installIdentity: target.installIdentity,
        replacementInstallIdentity: operation.replacementInstallIdentity,
        clientId: target.clientId,
      });
    }
    return this.#authority().executeNativeOwnerAdmin(
      adminOperationMethod(operation),
      () => {
        if (operation.kind === "export") {
          const memory = this.#localMemory();
          const vault = this.#vaultContext();
          const operationDeadline = this.#currentTime() + ADMIN_EXPORT_OPERATION_TIMEOUT_MS;
          const assertCanContinue = () => {
            if (this.#currentTime() >= operationDeadline) {
              throw new BrokerProtocolError(
                "unavailable",
                "Export exceeded its bounded operation window",
              );
            }
          };
          if (operation.format === "json") {
            memory.exportInterchange(
              vault,
              operation.destination,
              this.#applicationVersion,
              assertCanContinue,
            );
          } else {
            memory.exportMarkdown(
              vault,
              operation.destination,
              this.#applicationVersion,
              assertCanContinue,
            );
          }
          return success(pending.requestId, {
            exported: true,
            destination: operation.destination,
            format: operation.format === "json"
              ? "afternote-vault-v1"
              : "afternote-markdown-v1",
          });
        }
        return success(pending.requestId, buildDiagnosticBundle({
          applicationVersion: this.#applicationVersion,
          standalone: this.#standalone,
          ownerPresenceMode: this.#ownerPresenceMode,
          apiVersion: LOCAL_DIAGNOSTICS_API_VERSION,
          runtimeStatus: "running",
          networkBoundary: "broker-only",
          vault: this.#localMemory().diagnosticSnapshot(this.#vaultContext()),
        }));
      }
    );
  }

  #beginOwnerSession(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, ["requestedScopes", "ttlMs"]);
    const scopes = ownerInspectionScopes(request.params.requestedScopes);
    ownerSessionTtl(request.params.ttlMs, this.#trustPath);
    const ttlMs = this.#authority().routineAuthenticationTtlMilliseconds();
    const challengeId = randomUUID();
    const now = this.#currentTime();
    const challengeExpiresAt = now + OWNER_CHALLENGE_TTL_MS;
    const sessionExpiresAt = now + ttlMs;
    const ownerTranscript = canonicalBrokerTranscript({
      action: "owner-begin-inspection",
      protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
      brokerBootId: this.bootId,
      vaultId: this.#vaultContext().vaultId,
      connectionId: transportBinding.connectionId,
      peerPid: transportBinding.peerPid,
      challengeId,
      challengeExpiresAt: new Date(challengeExpiresAt).toISOString(),
      sessionExpiresAt: new Date(sessionExpiresAt).toISOString(),
      scopes,
    });
    this.#pendingPresence.set(challengeId, {
      kind: "owner-session",
      requestId: request.requestId,
      scopes,
      ownerTranscript,
      challengeExpiresAt,
      sessionExpiresAt,
      binding: transportBinding,
    });
    return ownerPresenceChallenge(
      challengeId,
      `Inspect Afternote connections and redacted audit history for ${formatSessionDuration(
        ttlMs,
      )}?`,
      challengeExpiresAt,
    );
  }

  #routineAuthentication(request: BrokerRequest): string {
    assertExactObject(request.params, []);
    return success(request.requestId, {
      ttlMs: this.#authority().routineAuthenticationTtlMilliseconds(),
    });
  }

  #setRoutineAuthentication(request: BrokerRequest): string {
    assertExactObject(request.params, ["ttlMs"]);
    const ttlMs = routineAuthenticationTtl(request.params.ttlMs);
    const previousTtlMs = this.#authority().routineAuthenticationTtlMilliseconds();
    this.#authority().configureRoutineAuthentication(ttlMs);
    if (ttlMs !== previousTtlMs) {
      this.#ownerSessions.clear();
      this.#librarySessions.clear();
      for (const [challengeId, pending] of this.#pendingPresence) {
        if (pending.kind !== "owner-session" && pending.kind !== "library-session" &&
            pending.kind !== "activation") continue;
        this.#pendingPresence.delete(challengeId);
        if (pending.kind === "activation") {
          this.#activationTtls.delete(pending.activationId);
        }
      }
    }
    return success(request.requestId, { ttlMs });
  }

  #connectorOverview(request: BrokerRequest): string {
    assertExactObject(request.params, []);
    return success(
      request.requestId,
      this.#authority().connectorOverview(this.#trustPath),
    );
  }

  #inspectConnections(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, []);
    this.#ownerSession(transportBinding, [
      "owner.inspect_clients",
      "owner.inspect_grants",
      "owner.inspect_sessions",
    ]);
    return success(request.requestId, this.#authority().inspectConnections(this.#trustPath));
  }

  #inspectAudit(
    request: BrokerRequest,
    transportBinding: BrokerTransportBinding,
  ): string {
    assertExactObject(request.params, ["cursor", "pageSize"]);
    this.#ownerSession(transportBinding, ["owner.inspect_audit"]);
    if (request.params.cursor !== null && typeof request.params.cursor !== "string") {
      throw new BrokerProtocolError("invalid_request", "Audit cursor is invalid");
    }
    return success(request.requestId, this.#authority().inspectAudit({
      pageSize: positiveInteger(request.params.pageSize, "audit page size"),
      ...(typeof request.params.cursor === "string"
        ? { cursor: boundedString(request.params.cursor, 2_048, "audit cursor") }
        : {}),
    }));
  }

  #ownerSession(
    transportBinding: BrokerTransportBinding,
    scopes: OwnerInspectionScope[],
  ): OwnerInspectionSession {
    const key = ownerSessionKey(transportBinding);
    const session = this.#ownerSessions.get(key);
    if (!session) {
      throw new BrokerProtocolError(
        "owner_session_required",
        "Owner inspection requires native owner authentication",
      );
    }
    if (session.expiresAt <= this.#currentTime()) {
      this.#ownerSessions.delete(key);
      throw new BrokerProtocolError("owner_session_expired", "Owner inspection session expired");
    }
    if (!bindingsEqual(session.binding, transportBinding)) {
      this.#ownerSessions.delete(key);
      throw new BrokerProtocolError("identity_mismatch", "Owner session peer changed");
    }
    if (scopes.some((scope) => !session.scopes.includes(scope))) {
      throw new BrokerProtocolError("scope_denied", "Owner inspection scope is not granted");
    }
    return session;
  }

  #currentTime(): number {
    return this.#now?.() ?? Date.now();
  }

  #consumeOwnerRequestId(requestId: string): void {
    const now = this.#currentTime();
    for (const [tracked, expiresAt] of this.#ownerRequestIds) {
      if (expiresAt <= now) this.#ownerRequestIds.delete(tracked);
    }
    if (this.#ownerRequestIds.has(requestId)) {
      throw new BrokerProtocolError("replayed", "Owner-control request was replayed");
    }
    if (this.#ownerRequestIds.size >= MAX_TRACKED_OWNER_REQUESTS) {
      throw new BrokerProtocolError("rate_limited", "Owner-control replay window is full");
    }
    this.#ownerRequestIds.set(
      requestId,
      now + (this.#trustPath === "development-only"
        ? DEVELOPMENT_OWNER_SESSION_MAX_TTL_MS
        : OWNER_SESSION_MAX_TTL_MS),
    );
  }

  async #completeOwnerPresence(gateway: GatewayEnvelope): Promise<string> {
    assertExactObject(gateway.payload, ["approved", "challengeId", "outcome"]);
    const payload = gateway.payload as Record<string, unknown>;
    const challengeId = uuid(payload.challengeId, "owner-presence challenge ID");
    if (typeof payload.approved !== "boolean") {
      throw new BrokerProtocolError("invalid_request", "Owner-presence result is invalid");
    }
    const outcome = ownerPresenceOutcome(payload.outcome);
    if (payload.approved !== (outcome === "approved")) {
      throw new BrokerProtocolError(
        "invalid_request",
        "Owner-presence result is inconsistent",
      );
    }
    let pending: PendingPresence;
    let claimIssue: "role_mismatch" | "binding_mismatch" | "expired" | null;
    try {
      ({ pending, issue: claimIssue } = this.#pendingPresence.claim({
        challengeId,
        peerRole: gateway.peerRole,
        binding: binding(gateway),
        now: this.#currentTime(),
        expectedRole: expectedOwnerPresenceRole,
      }));
    } catch (error) {
      if (error instanceof OwnerPresenceCoordinatorError) {
        throw new BrokerProtocolError(error.code, error.message);
      }
      throw error;
    }
    if (pending.kind === "lifecycle") this.#pendingLifecycleChallengeId = undefined;
    if (isRecoveryPresence(pending)) this.#pendingRecoveryChallengeId = undefined;
    this.#removeSiblingAuthorityChallenges(pending);
    if (claimIssue === "role_mismatch" || claimIssue === "binding_mismatch") {
      if (pending.kind === "library-session" || pending.kind === "library-delete") {
        this.#librarySessions.delete(ownerSessionKey(pending.binding));
      }
      if (pending.kind === "library-delete") {
        this.#authority().recordNativeLibraryOutcome(
          pending.sessionId,
          "library.delete",
          "error",
          "identity_mismatch",
          [{ noteId: pending.noteId, revision: pending.noteRevision }],
        );
      }
      if (pending.kind === "admin") {
        this.#authority().recordNativeOwnerAdminOutcome(
          adminOperationMethod(pending.operation),
          "error",
          "identity_mismatch",
        );
      }
      if (pending.kind === "lifecycle") {
        this.#recordLifecycleOutcome(pending.operation, "error", "identity_mismatch");
      }
      throw new BrokerProtocolError(
        "identity_mismatch",
        claimIssue === "role_mismatch"
          ? "Owner presence came from the wrong trusted client role"
          : "Owner presence belongs to another connection",
      );
    }
    if (claimIssue === "expired") {
      if (pending.kind === "pairing") {
        this.#authority().denyPairing(pending.pairingRequestId, "owner_timeout");
      } else if (pending.kind === "activation") {
        this.#authority().denyActivation(pending.activationId, "owner_timeout");
        this.#activationTtls.delete(pending.activationId);
      } else if (pending.kind === "library-delete") {
        this.#librarySessions.delete(ownerSessionKey(pending.binding));
        this.#authority().recordNativeLibraryOutcome(
          pending.sessionId,
          "library.delete",
          "denied",
          "owner_timeout",
          [{ noteId: pending.noteId, revision: pending.noteRevision }],
        );
      } else if (pending.kind === "library-session") {
        this.#librarySessions.delete(ownerSessionKey(pending.binding));
      } else if (pending.kind === "admin") {
        this.#authority().recordNativeOwnerAdminOutcome(
          adminOperationMethod(pending.operation),
          "denied",
          "owner_timeout",
        );
      } else if (pending.kind === "lifecycle") {
        this.#recordLifecycleOutcome(pending.operation, "denied", "owner_timeout");
      }
      throw new BrokerProtocolError("owner_timeout", "Owner authentication challenge expired");
    }
    if (!payload.approved) {
      if (outcome === "approved") {
        throw new BrokerProtocolError(
          "invalid_request",
          "Owner-presence result is inconsistent",
        );
      }
      const failure = ownerPresenceFailure(outcome);
      if (pending.kind === "pairing") {
        this.#authority().denyPairing(pending.pairingRequestId, failure.code);
      } else if (pending.kind === "activation") {
        this.#authority().denyActivation(pending.activationId, failure.code);
      } else if (pending.kind === "library-delete") {
        this.#librarySessions.delete(ownerSessionKey(pending.binding));
        this.#authority().recordNativeLibraryOutcome(
          pending.sessionId,
          "library.delete",
          "denied",
          failure.code,
          [{ noteId: pending.noteId, revision: pending.noteRevision }],
        );
      } else if (pending.kind === "library-session") {
        this.#librarySessions.delete(ownerSessionKey(pending.binding));
      } else if (pending.kind === "admin") {
        this.#authority().recordNativeOwnerAdminOutcome(
          adminOperationMethod(pending.operation),
          "denied",
          failure.code,
        );
      } else if (pending.kind === "lifecycle") {
        this.#recordLifecycleOutcome(pending.operation, "denied", failure.code);
      }
      return serializedError(pending.requestId, failure.code, failure.message);
    }
    if (pending.kind === "pairing") {
      this.#authority().approvePairing(
        pending.pairingRequestId,
        ownerSignature(pending.ownerTranscript, this.#ownerPrivateKey),
      );
      return success(
        pending.requestId,
        this.#authority().exchangePairing(
          pending.pairingRequestId,
          pending.clientSignature,
        ),
      );
    }
    if (pending.kind === "activation") {
      const activated = this.#authority().approveActivation({
        activationId: pending.activationId,
        ownerSignature: ownerSignature(pending.ownerTranscript, this.#ownerPrivateKey),
        clientSignature: pending.clientSignature,
        sessionSignature: pending.sessionSignature,
      });
      return success(
        pending.requestId,
        {
          ...activated,
          brokerBootId: this.bootId,
          vaultId: this.#vaultContext().vaultId,
        },
      );
    }
    if (pending.kind === "owner-session") {
      if (pending.sessionExpiresAt <= this.#currentTime()) {
        throw new BrokerProtocolError("owner_timeout", "Owner inspection approval expired");
      }
      this.#ownerSessions.set(ownerSessionKey(pending.binding), {
        scopes: pending.scopes,
        expiresAt: pending.sessionExpiresAt,
        binding: pending.binding,
      });
      return success(pending.requestId, {
        scopes: pending.scopes,
        expiresAt: new Date(pending.sessionExpiresAt).toISOString(),
      });
    }
    if (pending.kind === "library-session") {
      if (pending.sessionExpiresAt <= this.#currentTime()) {
        throw new BrokerProtocolError("owner_timeout", "Library approval expired");
      }
      this.#librarySessions.set(ownerSessionKey(pending.binding), {
        sessionId: pending.sessionId,
        scopes: pending.scopes,
        expiresAt: pending.sessionExpiresAt,
        brokerBootId: this.bootId,
        vaultId: this.#vaultContext().vaultId,
        binding: pending.binding,
      });
      return success(pending.requestId, {
        sessionId: pending.sessionId,
        scopes: pending.scopes,
        brokerBootId: this.bootId,
        vaultId: this.#vaultContext().vaultId,
        expiresAt: new Date(pending.sessionExpiresAt).toISOString(),
        searchMode: librarySearchMode(
          this.#localMemory().derivedIndexStatus(this.#vaultContext()),
          this.#semanticDiscoveryFailed,
        ),
      });
    }
    if (pending.kind === "library-delete") {
      let memory: SqliteMemory;
      let vault: VaultContext;
      try {
        const session = this.#librarySession(pending.binding, [
          "library.get_note",
          "library.inspect_source",
        ]);
        if (session.sessionId !== pending.sessionId) {
          throw new BrokerProtocolError("identity_mismatch", "Delete session changed");
        }
        memory = this.#localMemory();
        vault = this.#vaultContext();
        const current = memory.getNoteInCurrentTransaction(vault, pending.noteId);
        if (
          !current ||
          current.revision !== pending.noteRevision ||
          libraryDeleteTarget(current) !== pending.targetDescription
        ) {
          throw new BrokerProtocolError(
            "conflict",
            "Note changed while deletion approval was pending",
          );
        }
      } catch (error) {
        this.#authority().recordNativeLibraryOutcome(
          pending.sessionId,
          "library.delete",
          "error",
          brokerAuditErrorCode(error),
          [{ noteId: pending.noteId, revision: pending.noteRevision }],
        );
        throw error;
      }
      const deleted = this.#authority().executeNativeLibraryMutation(
        pending.sessionId,
        "library.delete",
        () => {
          const removed = memory.forgetInCurrentTransaction(
            vault,
            pending.noteId,
            pending.noteRevision,
          );
          if (!removed) {
            throw new BrokerProtocolError(
              "conflict",
              "Note changed while deletion approval was pending",
            );
          }
          return {
            result: true,
            noteRefs: [{ noteId: pending.noteId, revision: pending.noteRevision }],
          };
        },
      );
      return success(pending.requestId, {
        deleted,
        noteId: pending.noteId,
        revision: pending.noteRevision,
      });
    }
    if (pending.kind === "admin") {
      return this.#executeApprovedAdmin(pending);
    }
    if (pending.kind === "lifecycle") {
      return this.#completeLifecycleTransition(pending);
    }
    if (pending.kind === "recovery-migration") {
      return this.#executeApprovedRecoveryMigration(pending);
    }
    if (pending.kind === "recovery-restore") {
      return this.#executeApprovedRecoveryRestore(pending);
    }
    if (pending.kind === "connector-revocation") {
      const clientIds = this.#authority().revokeConnector(pending.target);
      return success(pending.requestId, {
        revoked: true,
        kind: pending.target.kind,
        clientIds,
      });
    }
    this.#authority().revokeClient(pending.target);
    return success(pending.requestId, {
      revoked: true,
      clientId: pending.target.clientId,
    });
  }
}

function formatSessionDuration(ttlMs: number): string {
  const minutes = Math.ceil(ttlMs / 60_000);
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

type OwnerPresenceOutcome =
  | "approved"
  | "denied"
  | "cancelled"
  | "timed_out"
  | "unavailable";

function ownerPresenceOutcome(value: unknown): OwnerPresenceOutcome {
  if (
    value === "approved" ||
    value === "denied" ||
    value === "cancelled" ||
    value === "timed_out" ||
    value === "unavailable"
  ) {
    return value;
  }
  throw new BrokerProtocolError("invalid_request", "Owner-presence outcome is invalid");
}

function ownerPresenceFailure(
  outcome: Exclude<OwnerPresenceOutcome, "approved">,
): { code: string; message: string } {
  switch (outcome) {
    case "cancelled":
      return { code: "owner_cancelled", message: "Owner authentication was cancelled" };
    case "timed_out":
      return { code: "owner_timeout", message: "Owner authentication timed out" };
    case "unavailable":
      return {
        code: "owner_auth_unavailable",
        message: "Owner authentication is unavailable",
      };
    case "denied":
      return { code: "owner_denied", message: "The owner denied access" };
  }
}

export async function runVaultBrokerWorker(
  options: string | VaultBrokerWorkerOptions,
): Promise<void> {
  const worker = new VaultBrokerWorker(options);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      const response = await worker.handleSerialized(line);
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(`${response}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      if (worker.shouldTerminateAfterResponse()) process.exit(70);
    }
  } finally {
    worker.close();
  }
}

export async function runVaultBrokerWorkerXpc(
  options: string | VaultBrokerWorkerOptions,
  transport: { service: string; gatewayCodeRequirement: string },
): Promise<void> {
  const worker = new VaultBrokerWorker(options);
  let responseTo = 0;
  let response: string | null = null;
  let terminate = false;
  let terminateAfterDelivery = false;
  try {
    while (true) {
      const delivery = pollVaultBrokerGatewayXpc(
        transport.service,
        transport.gatewayCodeRequirement,
        JSON.stringify({
          protocolVersion: 1,
          responseTo,
          response,
          terminate,
        }),
      );
      if (terminate) {
        const acknowledgement = JSON.parse(delivery) as unknown;
        assertExactObject(acknowledgement, ["protocolVersion", "shutdown"]);
        const value = acknowledgement as Record<string, unknown>;
        if (value.protocolVersion !== 1 || value.shutdown !== true) {
          throw new Error("Private gateway shutdown acknowledgement is invalid");
        }
        terminateAfterDelivery = true;
        break;
      }
      const parsed = JSON.parse(delivery) as unknown;
      assertExactObject(parsed, ["protocolVersion", "request", "requestId"]);
      const value = parsed as Record<string, unknown>;
      if (
        value.protocolVersion !== 1 ||
        !Number.isSafeInteger(value.requestId) ||
        (value.requestId as number) <= 0 ||
        typeof value.request !== "string" ||
        !value.request ||
        Buffer.byteLength(value.request) > MAXIMUM_MESSAGE_BYTES
      ) {
        throw new Error("Private gateway delivery is invalid");
      }
      responseTo = value.requestId as number;
      response = await worker.handleSerialized(value.request);
      terminate = worker.shouldTerminateAfterResponse();
    }
  } finally {
    worker.close();
  }
  if (terminateAfterDelivery) process.exit(70);
}

class BrokerProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function parseGatewayEnvelope(value: unknown): GatewayEnvelope {
  assertExactObject(value, ["connectionId", "kind", "payload", "peerPid", "peerRole"]);
  const envelope = value as Record<string, unknown>;
  if (
    envelope.kind !== "client" &&
    envelope.kind !== "owner-presence" &&
    envelope.kind !== "connection-closed"
  ) {
    throw new BrokerProtocolError("invalid_request", "Broker gateway kind is invalid");
  }
  if (
    envelope.peerRole !== "memory-client" &&
    envelope.peerRole !== "owner-control"
  ) {
    throw new BrokerProtocolError("invalid_request", "Broker gateway peer role is invalid");
  }
  binding(envelope as GatewayEnvelope);
  return envelope as GatewayEnvelope;
}

function parseBrokerRequest(value: unknown): BrokerRequest {
  assertExactObject(value, ["method", "params", "protocolVersion", "requestId"]);
  const request = value as Record<string, unknown>;
  if (request.protocolVersion !== VAULT_BROKER_PROTOCOL_VERSION) {
    throw new BrokerProtocolError("unsupported_version", "Broker protocol version is invalid");
  }
  uuid(request.requestId, "request ID");
  if (typeof request.method !== "string" || !/^[a-z._]{1,64}$/.test(request.method)) {
    throw new BrokerProtocolError("invalid_request", "Broker method is invalid");
  }
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new BrokerProtocolError("invalid_request", "Broker request parameters are invalid");
  }
  return request as BrokerRequest;
}

function binding(value: GatewayEnvelope): BrokerTransportBinding {
  if (
    typeof value.connectionId !== "string" ||
    !/^[0-9A-F-]{36}$/i.test(value.connectionId) ||
    !Number.isSafeInteger(value.peerPid) ||
    value.peerPid <= 0
  ) {
    throw new BrokerProtocolError("invalid_request", "Broker connection identity is invalid");
  }
  return { connectionId: value.connectionId, peerPid: value.peerPid };
}

function success(requestId: string, result: unknown): string {
  return JSON.stringify({
    protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: true,
    result,
  });
}

function ownerPresenceChallenge(
  challengeId: string,
  reason: string,
  expiresAt: number,
  context: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ownerPresenceChallenge: {
      challengeId,
      reason,
      expiresAt: new Date(expiresAt).toISOString(),
      ...context,
    },
  });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function serializedError(requestId: string | null, code: string, message: string): string {
  return JSON.stringify({
    protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  });
}

function requestIdFromEnvelope(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = (value as Record<string, unknown>).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" && /^[0-9a-f-]{36}$/i.test(requestId)
    ? requestId
    : null;
}

function assertExactObject(value: unknown, keys: string[]): asserts value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerProtocolError("invalid_request", "Broker request object is invalid");
  }
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new BrokerProtocolError("invalid_request", "Broker request fields are invalid");
  }
}

function boundedString(value: unknown, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new BrokerProtocolError("invalid_request", `${name} is invalid`);
  }
  return value;
}

function boundedIdentifier(value: unknown, maximum: number, name: string): string {
  const parsed = boundedString(value, maximum, name);
  if (!/^[A-Za-z0-9._:-]+$/.test(parsed)) {
    throw new BrokerProtocolError("invalid_request", `${name} is invalid`);
  }
  return parsed;
}

function uuid(value: unknown, name: string): string {
  const parsed = boundedString(value, 36, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new BrokerProtocolError("invalid_request", `${name} is invalid`);
  }
  return parsed;
}

function clientKind(value: unknown): BrokerClientKind {
  if (value !== "codex" && value !== "claude" && value !== "claude-desktop") {
    throw new BrokerProtocolError("invalid_request", "Broker client kind is invalid");
  }
  return value;
}

function fixedClientDisplayName(kind: BrokerClientKind): string {
  switch (kind) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    case "claude-desktop":
      return "Claude Desktop";
    case "local_ui":
      return "Afternote";
  }
}

function ownerClientKind(value: unknown): BrokerClientKind {
  if (value === "local_ui") return value;
  return clientKind(value);
}

function mcpClientKind(value: unknown): "codex" | "claude" | "claude-desktop" {
  const kind = clientKind(value);
  if (kind !== "codex" && kind !== "claude" && kind !== "claude-desktop") {
    throw new BrokerProtocolError(
      "invalid_request",
      "MCP client identity kind is invalid",
    );
  }
  return kind;
}

function capabilities(value: unknown): BrokerCapability[] {
  const supported: readonly BrokerCapability[] = MEMORY_CAPABILITIES;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > supported.length ||
    new Set(value).size !== value.length ||
    value.some((entry) =>
      typeof entry !== "string" ||
      !(supported as readonly string[]).includes(entry)
    )
  ) {
    throw new BrokerProtocolError("invalid_request", "Broker capabilities are invalid");
  }
  return supported.filter((entry) => value.includes(entry));
}

function ownerInspectionScopes(value: unknown): OwnerInspectionScope[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > OWNER_INSPECTION_SCOPES.length ||
    new Set(value).size !== value.length ||
    value.some((entry) =>
      typeof entry !== "string" ||
      !(OWNER_INSPECTION_SCOPES as readonly string[]).includes(entry)
    )
  ) {
    throw new BrokerProtocolError("invalid_request", "Owner inspection scopes are invalid");
  }
  return OWNER_INSPECTION_SCOPES.filter((scope) => value.includes(scope));
}

function libraryScopes(value: unknown): LibraryScope[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > LIBRARY_SCOPES.length ||
    new Set(value).size !== value.length ||
    value.some((entry) =>
      typeof entry !== "string" ||
      !(LIBRARY_SCOPES as readonly string[]).includes(entry)
    )
  ) {
    throw new BrokerProtocolError("invalid_request", "Library scopes are invalid");
  }
  return LIBRARY_SCOPES.filter((scope) => value.includes(scope));
}

function librarySessionTtl(value: unknown): number {
  if (value === undefined) return LIBRARY_SESSION_DEFAULT_TTL_MS;
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > LIBRARY_SESSION_MAX_TTL_MS
  ) {
    throw new BrokerProtocolError(
      "invalid_request",
      `Library session lifetime must be between one millisecond and ${formatSessionDuration(LIBRARY_SESSION_MAX_TTL_MS)}`,
    );
  }
  return value as number;
}

function adminDestination(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BrokerProtocolError("invalid_request", "Admin export destination is invalid");
  }
  return resolve(value);
}

type RecoveryArtifactPolicy = {
  action: "keep" | "delete" | "move";
  destinationDirectory: string | null;
};

function recoveryLiveDecision(
  action: unknown,
  destination: unknown,
): LegacyPlaintextDecision {
  if (action === "keep" || action === "delete") {
    if (destination !== null) {
      throw new BrokerProtocolError(
        "invalid_request",
        "Live plaintext destination is valid only for move",
      );
    }
    return { action };
  }
  if (action === "move") {
    return {
      action,
      destinationPath: recoveryDestination(destination, "Live plaintext destination"),
    };
  }
  throw new BrokerProtocolError("invalid_request", "Live plaintext action is invalid");
}

function recoveryArtifactPolicy(
  action: unknown,
  destinationDirectory: unknown,
): RecoveryArtifactPolicy {
  if (action === "keep" || action === "delete") {
    if (destinationDirectory !== null) {
      throw new BrokerProtocolError(
        "invalid_request",
        "Artifact destination is valid only for move",
      );
    }
    return { action, destinationDirectory: null };
  }
  if (action === "move") {
    return {
      action,
      destinationDirectory: recoveryDestination(
        destinationDirectory,
        "Artifact destination directory",
      ),
    };
  }
  throw new BrokerProtocolError("invalid_request", "Artifact action is invalid");
}

function recoveryCoordinationDigest(
  liveDecision: LegacyPlaintextDecision,
  artifactPolicy: RecoveryArtifactPolicy,
): string {
  return createHash("sha256").update(canonicalBrokerTranscript({
    liveAction: liveDecision.action,
    liveDestination: liveDecision.action === "move"
      ? resolve(liveDecision.destinationPath)
      : null,
    artifactAction: artifactPolicy.action,
    artifactDestinationDirectory: artifactPolicy.action === "move"
      ? resolve(artifactPolicy.destinationDirectory!)
      : null,
  })).digest("hex");
}

function recoveryApprovalSnapshotDigest(
  snapshot: EncryptionMigrationApprovalSnapshot,
): string {
  return createHash("sha256")
    .update(canonicalBrokerTranscript(snapshot))
    .digest("hex");
}

function privateRecoveryFileSnapshot(
  path: string,
  label: string,
  requireKeyLength: boolean,
): { bytes: number; digest: string; inode: number } {
  if (!isAbsolute(path)) {
    throw new BrokerProtocolError(
      "recovery_state_invalid",
      `${label} state is invalid`,
    );
  }
  const status = lstatSync(path);
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0 ||
    (requireKeyLength && status.size !== 32)
  ) {
    throw new BrokerProtocolError(
      "recovery_state_invalid",
      `${label} state is invalid`,
    );
  }
  return {
    bytes: status.size,
    digest: createHash("sha256").update(readFileSync(path)).digest("hex"),
    inode: status.ino,
  };
}

function recoveryDestination(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BrokerProtocolError("invalid_request", `${label} is invalid`);
  }
  return resolve(value);
}

function recoveryEntryKind(
  path: string,
  label: string,
): "absent" | "regular" {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} is unsafe`);
    }
    return "regular";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

function recoveryDecisionDescription(decision: LegacyPlaintextDecision): string {
  return decision.action === "keep"
    ? "kept in an owner-only sibling file"
    : decision.action === "delete"
      ? "permanently deleted after verification"
      : `moved to ${basename(decision.destinationPath)}`;
}

function recoveryArtifactDescription(policy: RecoveryArtifactPolicy): string {
  return policy.action === "keep"
    ? "kept in place"
    : policy.action === "delete"
      ? "permanently deleted after verification"
      : `moved into ${basename(policy.destinationDirectory!)}`;
}

function adminExportFormat(value: unknown): "json" | "markdown" {
  if (value !== "json" && value !== "markdown") {
    throw new BrokerProtocolError("invalid_request", "Admin export format is invalid");
  }
  return value;
}

function adminOperationMethod(
  operation: Extract<PendingPresence, { kind: "admin" }>["operation"],
): "admin.export" | "admin.diagnostics" | "admin.prepare_client_rotation" {
  return operation.kind === "client-rotation" ||
      operation.kind === "revoked-client-replacement"
    ? "admin.prepare_client_rotation"
    : operation.kind === "export"
    ? "admin.export"
    : "admin.diagnostics";
}

function boundedLibraryLimit(value: unknown, maximum: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new BrokerProtocolError("invalid_request", `${name} is invalid`);
  }
  return value as number;
}

function nullablePositiveInteger(value: unknown, name: string): number | null {
  return value === null ? null : positiveInteger(value, name);
}

function nullableLibraryView(value: unknown): null | "decisions" | "commitments" | "meetings" {
  if (value === null) return null;
  if (value === "decisions" || value === "commitments" || value === "meetings") {
    return value;
  }
  throw new BrokerProtocolError("invalid_request", "Library smart view is invalid");
}

function libraryQuery(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    countCharacters(value) > MAX_RECALL_QUERY_CHARACTERS ||
    Buffer.byteLength(value) > MAX_LIBRARY_QUERY_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new BrokerProtocolError("invalid_request", "Library search query is invalid");
  }
  return value;
}

function libraryNoteContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    countCharacters(value) > MAX_NOTE_CHARACTERS ||
    Buffer.byteLength(value) > 512 * 1_024
  ) {
    throw new BrokerProtocolError("invalid_request", "Library note content is invalid");
  }
  return value;
}

function nullableLibrarySource(value: unknown): SourceContext | null {
  if (value === null) return null;
  validateSource(value);
  return value;
}

function ownerSessionTtl(value: unknown, trustPath: OwnerTrustPath): number {
  if (value === undefined) return OWNER_SESSION_DEFAULT_TTL_MS;
  const maximum = trustPath === "development-only"
    ? DEVELOPMENT_OWNER_SESSION_MAX_TTL_MS
    : OWNER_SESSION_MAX_TTL_MS;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new BrokerProtocolError(
      "invalid_request",
      `Owner inspection lifetime must be between one millisecond and ${formatSessionDuration(maximum)}`,
    );
  }
  return value as number;
}

function routineAuthenticationTtl(value: unknown): number {
  if (!Number.isInteger(value) || !ROUTINE_AUTHENTICATION_TTLS_MS.includes(
    value as (typeof ROUTINE_AUTHENTICATION_TTLS_MS)[number],
  )) {
    throw new BrokerProtocolError(
      "invalid_request",
      "Routine authentication window is invalid",
    );
  }
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new BrokerProtocolError("invalid_request", `${name} is invalid`);
  }
  return value as number;
}

function ownerSessionKey(value: BrokerTransportBinding): string {
  return `${value.connectionId}:${value.peerPid}`;
}

function bindingsEqual(
  left: BrokerTransportBinding,
  right: BrokerTransportBinding,
): boolean {
  return left.connectionId === right.connectionId && left.peerPid === right.peerPid;
}

function assertPeerRole(actual: GatewayPeerRole, expected: GatewayPeerRole): void {
  if (actual !== expected) {
    throw new BrokerProtocolError(
      "identity_mismatch",
      "Broker method is unavailable to this trusted client role",
    );
  }
}

function assertOrdinaryPeerRole(
  role: GatewayPeerRole,
): asserts role is "memory-client" {
  if (role !== "memory-client") {
    throw new BrokerProtocolError(
      "identity_mismatch",
      "Broker method is unavailable to this trusted client role",
    );
  }
}

function assertClientKindForRole(
  kind: BrokerClientKind,
  role: GatewayPeerRole,
): void {
  const valid = role === "memory-client" && kind !== "local_ui";
  if (!valid) {
    throw new BrokerProtocolError(
      "identity_mismatch",
      "Broker client kind does not match the authenticated executable role",
    );
  }
}

function forgetPolicyValue(value: unknown): ForgetPolicy {
  if (value !== "never" && value !== "confirm_each" && value !== "session") {
    throw new BrokerProtocolError("invalid_request", "Forget policy is invalid");
  }
  return value;
}

function sessionTtl(value: unknown): number {
  if (value === undefined) return DEFAULT_SESSION_TTL_MS;
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 12 * 60 * 60 * 1_000) {
    throw new BrokerProtocolError("invalid_request", "Session lifetime is invalid");
  }
  return value as number;
}

function transportBindingDigest(value: BrokerTransportBinding): string {
  return createHash("sha256")
    .update(`${value.connectionId}:${value.peerPid}`)
    .digest("hex");
}

function ownerSignature(transcript: string, privateKey: KeyObject): string {
  return sign("sha256", Buffer.from(transcript), privateKey).toString("base64url");
}

function validateMemoryBody(operation: string, value: unknown): Record<string, unknown> {
  const keys = operation === "memory.remember"
    ? [
        "content",
        ...(value && typeof value === "object" && !Array.isArray(value) &&
            Object.prototype.hasOwnProperty.call(value, "source")
          ? ["source"]
          : []),
      ]
    : operation === "memory.recall"
      ? ["limit", "query"]
      : ["id"];
  assertExactObject(value, keys);
  const body = value as Record<string, unknown>;
  switch (operation) {
    case "memory.remember":
      if (
        typeof body.content !== "string" ||
        body.content.trim().length === 0 ||
        countCharacters(body.content) > MAX_NOTE_CHARACTERS
      ) {
        throw new BrokerProtocolError("invalid_request", "Remember content is invalid");
      }
      if (body.source !== undefined) validateSource(body.source);
      return body;
    case "memory.recall":
      if (
        typeof body.query !== "string" ||
        body.query.trim().length === 0 ||
        countCharacters(body.query) > MAX_RECALL_QUERY_CHARACTERS ||
        !Number.isInteger(body.limit) ||
        (body.limit as number) < 1 ||
        (body.limit as number) > MAX_RECALL_RESULTS
      ) {
        throw new BrokerProtocolError("invalid_request", "Recall request is invalid");
      }
      return body;
    case "memory.get_note":
    case "memory.forget":
      uuid(body.id, "note ID");
      return body;
    default:
      throw new BrokerProtocolError("scope_denied", "Memory operation is not supported");
  }
}

function librarySearchMode(
  status: DerivedIndexStatus,
  discoveryFailed: boolean,
): EffectiveSearchMode {
  if (discoveryFailed || status.state === "degraded") return "degraded";
  if (status.state === "indexing") return "indexing";
  return status.state === "ready" ? "hybrid" : "exact";
}

function formatCapabilities(capabilities: BrokerCapability[]): string {
  return capabilities
    .map((capability) => capability.slice("memory.".length))
    .map((name) => name === "get_note" ? "Get" : `${name[0]?.toUpperCase()}${name.slice(1)}`)
    .join(", ");
}

function validateSource(value: unknown): asserts value is SourceContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerProtocolError("invalid_request", "Source context is invalid");
  }
  const limits: Record<string, number> = {
    application: MAX_SOURCE_APPLICATION_CHARACTERS,
    url: MAX_SOURCE_URL_CHARACTERS,
    author: MAX_SOURCE_AUTHOR_CHARACTERS,
    timestamp: MAX_SOURCE_TIMESTAMP_CHARACTERS,
    label: MAX_SOURCE_LABEL_CHARACTERS,
  };
  for (const [name, child] of Object.entries(value)) {
    const maximum = limits[name];
    if (
      maximum === undefined ||
      typeof child !== "string" ||
      countCharacters(child) > maximum
    ) {
      throw new BrokerProtocolError("invalid_request", "Source context is invalid");
    }
  }
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Broker request failed";
  const message = error.message.replace(/[\r\n]/g, " ");
  return message.length <= 300 ? message : "Broker request failed";
}

const SAFE_UNTYPED_PEER_ERRORS = new Set([
  "Broker boot does not match",
  "Client is revoked",
  "Client signature is invalid",
  "Grant is revoked",
  "Revoked MCP client public keys cannot be paired again",
  "Codex requires explicit reconnect preparation",
  "Claude Code requires explicit reconnect preparation",
  "Claude Desktop requires explicit reconnect preparation",
  "Request signature is invalid",
  "Request was replayed",
  "Request transport does not match the active session",
  "Session was not found",
  "Session is expired",
  "Session is disconnected",
  "Session is revoked",
  "Session signature is invalid",
  "Trusted work session is expired",
  "Vault encryption migration recovery state is invalid",
  "Vault restore recovery state is invalid",
]);

const SAFE_UNTYPED_PEER_ERROR_PATTERNS = [
  /^Session does not grant memory\.(?:remember|recall|get_note|forget)$/,
] as const;

function peerSafeErrorMessage(error: unknown): string {
  if (error instanceof BrokerProtocolError || error instanceof MemoryError) {
    return safeErrorMessage(error);
  }
  const message = safeErrorMessage(error);
  return SAFE_UNTYPED_PEER_ERRORS.has(message) ||
      SAFE_UNTYPED_PEER_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    ? message
    : "Broker request failed";
}

function brokerAuditErrorCode(error: unknown): string {
  if (error instanceof BrokerProtocolError || error instanceof MemoryError) {
    return error.code;
  }
  return "operation_failed";
}
