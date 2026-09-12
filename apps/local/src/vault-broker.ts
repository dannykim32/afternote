import {
  createHmac,
  createPublicKey,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from "node:crypto";
import type { MemoryCapability } from "@afternote/memory";
import { MEMORY_CAPABILITIES } from "@afternote/memory";
import { SqlcipherDatabase } from "./sqlcipher-database";
import { canonicalBrokerTranscript } from "./vault-broker-canonical";
export { canonicalBrokerTranscript } from "./vault-broker-canonical";

const PROTOCOL_VERSION = 1;
const PAIRING_TTL_MS = 5 * 60 * 1_000;
const DECISION_TTL_MS = 2 * 60 * 1_000;
// Native session activation can remain open for 120 seconds. Keep its cleanup
// state alive beyond that window so a timeout can still be recorded and
// returned with the original request context. Other one-use decisions retain
// their existing two-minute lifetime.
const ACTIVATION_DECISION_TTL_MS = 3 * 60 * 1_000;
const MAX_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
export const TRUSTED_MCP_CONNECTION_TTL_MS = 15 * 60 * 1_000;
export const TRUSTED_MCP_WORK_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
export const TRUSTED_MCP_WORK_SESSION_IDLE_MS = 24 * 60 * 60 * 1_000;
export const ROUTINE_AUTHENTICATION_TTLS_MS = [
  15 * 60 * 1_000,
  4 * 60 * 60 * 1_000,
  TRUSTED_MCP_WORK_SESSION_TTL_MS,
] as const;
const MAX_CLOCK_SKEW_MS = 60 * 1_000;
const REPLAY_RETENTION_MS = 5 * MAX_CLOCK_SKEW_MS;
const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const AUDIT_FLOOR = 10_000;
const MAX_NOTE_REFS = 20;
const MAX_OWNER_RECORDS = 256;
const MAX_AUDIT_PAGE_SIZE = 100;
const DEFAULT_AUDIT_PAGE_SIZE = 50;
const MAX_AUDIT_RESPONSE_BYTES = 256_000;
const AUDIT_CURSOR_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_PAIRING_REQUESTS = 16;
const MAX_RETAINED_PAIRING_REQUESTS = 1_000;
const PAIRING_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type BrokerCapability = MemoryCapability;
const BROKER_CAPABILITIES: readonly BrokerCapability[] = MEMORY_CAPABILITIES;

export type BrokerClientKind =
  | "codex"
  | "claude"
  | "claude-desktop"
  | "local_ui";
export type ForgetPolicy = "never" | "confirm_each" | "session";
export type AuditOutcome = "authorized" | "success" | "denied" | "error";

export class NativeLibraryAuditCommitError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Native Library mutation audit could not commit", options);
    this.name = "NativeLibraryAuditCommitError";
  }
}

export type BrokerRequestEnvelope = {
  protocolVersion: number;
  brokerBootId: string;
  vaultId: string;
  clientId: string;
  grantId: string;
  sessionId: string;
  requestId: string;
  issuedAt: string;
  operation: string;
  bodySha256: string;
  signature: string;
};

type UnsignedBrokerRequestEnvelope = Omit<BrokerRequestEnvelope, "signature">;

export type BrokerAuthorization = {
  eventId: string;
  clientId: string;
  grantId: string;
  sessionId: string;
  operation: string;
};

type BrokerAuditAuthorization = Omit<
  BrokerAuthorization,
  "grantId" | "sessionId"
> & {
  grantId: string | null;
  sessionId: string | null;
};

type PairingRow = {
  id: string;
  vault_id: string;
  boot_id: string;
  kind: BrokerClientKind;
  display_name: string;
  install_identity: string;
  public_key: string;
  code_requirement: string;
  requested_capabilities: string;
  forget_policy: ForgetPolicy;
  nonce: string;
  status: "pending" | "approved" | "paired" | "denied" | "expired";
  created_at: string;
  expires_at: string;
};

type ClientRow = {
  id: string;
  vault_id: string;
  kind: BrokerClientKind;
  display_name: string;
  install_identity: string;
  public_key: string;
  code_requirement: string;
  status: "paired" | "revoked";
  paired_at: string;
  revoked_at: string | null;
  authority_revision: number;
};

type ConnectorReconnectRow = {
  status: "required" | "prepared";
  replacement_install_identity: string | null;
};

type GrantRow = {
  id: string;
  client_id: string;
  capabilities: string;
  forget_policy: ForgetPolicy;
  status: "active" | "revoked";
  expires_at: string | null;
};

export type OwnerTrustPath = "production-signed" | "development-only";

export type OwnerRevocationTarget = {
  clientId: string;
  kind: BrokerClientKind;
  displayLabel: string;
  authorityRevision: number;
  scopes: BrokerCapability[];
};

export type OwnerConnectorRevocationTarget = {
  kind: BrokerClientKind;
  displayLabel: string;
  clients: OwnerRevocationTarget[];
};

export type OwnerClientRotationTarget = Omit<OwnerRevocationTarget, "clientId"> & {
  clientId: string | null;
  kind: "codex" | "claude" | "claude-desktop";
  installIdentity: string;
};

type ActivationRow = {
  id: string;
  vault_id: string;
  broker_boot_id: string;
  client_id: string;
  grant_id: string;
  session_public_key: string;
  capabilities: string;
  forget_policy: ForgetPolicy;
  nonce: string;
  status: "pending" | "active" | "disconnected" | "expired" | "revoked";
  activated_at: string | null;
  decision_expires_at: string;
  expires_at: string;
  transport_connection_id: string | null;
  transport_peer_pid: number | null;
  work_session_id: string | null;
};

type TrustedMcpWorkSession = {
  id: string;
  startedAt: number;
  expiresAt: number;
  lastActivityAt: number;
  lastObservedAt: number;
};

export type BrokerTransportBinding = {
  connectionId: string;
  peerPid: number;
};

type SessionRow = ActivationRow & {
  activated_at: string;
};

type ForgetDecisionRow = {
  id: string;
  event_id: string;
  client_id: string;
  grant_id: string;
  session_id: string;
  note_id: string;
  note_revision: number;
  nonce: string;
  status: "pending" | "approved" | "consumed" | "expired";
  expires_at: string;
};

export class VaultBrokerAuthorization {
  readonly #database: SqlcipherDatabase;
  readonly #ownsDatabase: boolean;
  readonly #vaultId: string;
  readonly #bootId: string;
  readonly #ownerPublicKey: string;
  readonly #now: () => number;
  readonly #auditCursorKey = randomBytes(32);
  readonly #expiryTimer: ReturnType<typeof setInterval>;
  #maintenanceError: unknown;
  #trustedMcpWorkSession: TrustedMcpWorkSession | undefined;
  #closed = false;

  constructor(options: {
    path: string;
    key: Uint8Array;
    vaultId: string;
    bootId: string;
    ownerPublicKey: string;
    database?: SqlcipherDatabase;
    now?: () => number;
    expirySweepIntervalMs?: number;
  }) {
    assertBounded("vault ID", options.vaultId, 128);
    assertBounded("broker boot ID", options.bootId, 128);
    validatePublicKey(options.ownerPublicKey);
    this.#vaultId = options.vaultId;
    this.#bootId = options.bootId;
    this.#ownerPublicKey = options.ownerPublicKey;
    this.#now = options.now ?? Date.now;
    this.#ownsDatabase = options.database === undefined;
    this.#database = options.database ?? new SqlcipherDatabase(options.path, { key: options.key });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
    this.#database.exec(BROKER_SCHEMA);
    this.#ensureTransportBindingColumns();
    this.#ensureOwnerControlColumns();
    this.#invalidatePriorBootSessions();
    const expirySweepIntervalMs = options.expirySweepIntervalMs ?? 30_000;
    if (!Number.isInteger(expirySweepIntervalMs) || expirySweepIntervalMs < 1) {
      if (this.#ownsDatabase) this.#database.close();
      throw new Error("Expiry sweep interval must be a positive integer");
    }
    this.#expireForgetDecisions();
    this.#expiryTimer = setInterval(() => {
      try {
        this.#expireForgetDecisions();
        this.#maintenanceError = undefined;
      } catch (error) {
        this.#maintenanceError = error;
      }
    }, expirySweepIntervalMs);
    this.#expiryTimer.unref();
  }

  get vaultId(): string {
    return this.#vaultId;
  }

  get bootId(): string {
    return this.#bootId;
  }

  routineAuthenticationTtlMilliseconds(): number {
    const stored = this.#database.query<{ ttl_ms: number }, [string]>(`
      select ttl_ms from broker_preferences where key = ?
    `).get("routine_authentication_ttl_ms")?.ttl_ms;
    if (typeof stored === "number" && ROUTINE_AUTHENTICATION_TTLS_MS.includes(
      stored as (typeof ROUTINE_AUTHENTICATION_TTLS_MS)[number],
    )) return stored;
    return TRUSTED_MCP_WORK_SESSION_TTL_MS;
  }

  configureRoutineAuthentication(ttlMs: number): void {
    if (!ROUTINE_AUTHENTICATION_TTLS_MS.includes(
      ttlMs as (typeof ROUTINE_AUTHENTICATION_TTLS_MS)[number],
    )) {
      throw new Error("Routine authentication window is invalid");
    }
    if (ttlMs === this.routineAuthenticationTtlMilliseconds()) return;
    this.#expireTrustedMcpWorkSession("work_session_policy_changed");
    this.#database.query(`
      insert into broker_preferences (key, ttl_ms) values (?, ?)
      on conflict(key) do update set ttl_ms = excluded.ttl_ms
    `).run("routine_authentication_ttl_ms", ttlMs);
  }

  requestPairing(input: {
    kind: BrokerClientKind;
    displayName: string;
    installIdentity: string;
    publicKey: string;
    signingMode: string;
    requestedCapabilities: BrokerCapability[];
    forgetPolicy: ForgetPolicy;
  }): {
    requestId: string;
    ownerDecisionTranscript: string;
    clientProofTranscript: string;
    expiresAt: string;
  } {
    this.#assertOpen();
    this.#prunePairingRequests();
    const pendingPairings = this.#database.query<{ count: number }, []>(`
      select count(*) as count from broker_pairing_requests
      where status in ('pending', 'approved')
    `).get()?.count ?? 0;
    if (pendingPairings >= MAX_PENDING_PAIRING_REQUESTS) {
      throw new Error("Pairing request window is full");
    }
    assertClientKind(input.kind);
    assertBounded("display name", input.displayName, 120);
    assertBounded("install identity", input.installIdentity, 128);
    assertBounded("signing mode", input.signingMode, 2_048);
    validatePublicKey(input.publicKey);
    this.#assertConnectorPairingAllowed(input.kind, input.installIdentity);
    const priorKey = this.#database.query<{
      kind: BrokerClientKind;
      status: "paired" | "revoked";
    }, [string, string]>(`
      select kind, status from broker_clients where vault_id = ? and public_key = ?
    `).get(this.#vaultId, input.publicKey);
    if (priorKey?.status === "revoked" && isMcpClientKind(priorKey.kind)) {
      throw new Error("Revoked MCP client public keys cannot be paired again");
    }
    const capabilities = normalizeCapabilities(input.requestedCapabilities);
    assertForgetPolicy(input.forgetPolicy);
    if (input.forgetPolicy !== "never" && !capabilities.includes("memory.forget")) {
      throw new Error("A non-never Forget policy requires memory.forget");
    }
    const requestId = randomUUID();
    const nonce = randomBytes(32).toString("base64url");
    const createdAt = new Date(this.#now()).toISOString();
    const expiresAt = new Date(this.#now() + PAIRING_TTL_MS).toISOString();
    this.#database.query(`
      insert into broker_pairing_requests (
        id, vault_id, boot_id, kind, display_name, install_identity, public_key,
        code_requirement, requested_capabilities, forget_policy, nonce, status,
        created_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      requestId,
      this.#vaultId,
      this.#bootId,
      input.kind,
      input.displayName,
      input.installIdentity,
      input.publicKey,
      input.signingMode,
      JSON.stringify(capabilities),
      input.forgetPolicy,
      nonce,
      createdAt,
      expiresAt,
    );
    const row = this.#pairing(requestId);
    return {
      requestId,
      ownerDecisionTranscript: pairingOwnerTranscript(row),
      clientProofTranscript: pairingClientTranscript(row),
      expiresAt,
    };
  }

  #prunePairingRequests(): void {
    const now = this.#now();
    const timestamp = new Date(now).toISOString();
    const retentionBoundary = new Date(
      now - PAIRING_HISTORY_RETENTION_MS,
    ).toISOString();
    this.#database.query(`
      update broker_pairing_requests
      set status = 'expired', nonce = ''
      where status in ('pending', 'approved') and expires_at <= ?
    `).run(timestamp);
    this.#database.query(`
      delete from broker_pairing_requests
      where status not in ('pending', 'approved') and created_at < ?
    `).run(retentionBoundary);
    this.#database.query(`
      delete from broker_pairing_requests
      where id in (
        select id from broker_pairing_requests
        where status not in ('pending', 'approved')
        order by created_at desc, id desc
        limit -1 offset ?
      )
    `).run(MAX_RETAINED_PAIRING_REQUESTS);
  }

  approvePairing(requestId: string, ownerSignature: string): void {
    const row = this.#activePairing(requestId, "pending");
    verifyTranscript(pairingOwnerTranscript(row), ownerSignature, this.#ownerPublicKey, "owner");
    this.#database.query(
      "update broker_pairing_requests set status = 'approved' where id = ? and status = 'pending'",
    ).run(requestId);
  }

  verifyPairingClientProof(requestId: string, clientSignature: string): void {
    const row = this.#activePairing(requestId, "pending");
    verifyTranscript(
      pairingClientTranscript(row),
      clientSignature,
      row.public_key,
      "client",
    );
  }

  pairingOwnerTranscriptForPending(requestId: string): string {
    return pairingOwnerTranscript(this.#activePairing(requestId, "pending"));
  }

  denyPairing(requestId: string, errorCode = "owner_denied"): void {
    const row = this.#pairing(requestId);
    if (row.vault_id !== this.#vaultId || row.boot_id !== this.#bootId) {
      throw new Error("Pairing request is not active for this broker boot and vault");
    }
    const changed = this.#database.query(
      "update broker_pairing_requests set status = 'denied', nonce = '' where id = ? and status in ('pending', 'expired')",
    ).run(requestId).changes;
    if (changed !== 1) return;
    this.#appendAudit({
      eventId: randomUUID(),
      occurredAt: new Date(this.#now()).toISOString(),
      clientId: `pending:${row.id}`,
      grantId: null,
      sessionId: null,
      operation: "client.pair",
      outcome: "denied",
      errorCode,
      noteRefs: [],
    });
  }

  exchangePairing(requestId: string, clientSignature: string): {
    clientId: string;
    grantId: string;
    capabilities: BrokerCapability[];
    forgetPolicy: ForgetPolicy;
  } {
    const row = this.#activePairing(requestId, "approved");
    verifyTranscript(pairingClientTranscript(row), clientSignature, row.public_key, "client");
    const existing = this.#database.query<{
      id: string;
      kind: BrokerClientKind;
      install_identity: string;
      status: "paired" | "revoked";
    }, [string, string]>(
      `select id, kind, install_identity, status from broker_clients
       where vault_id = ? and public_key = ?`,
    ).get(this.#vaultId, row.public_key);
    if (existing?.status === "paired") {
      throw new Error("Client public key is already paired to this vault");
    }
    if (existing?.status === "revoked" && isMcpClientKind(row.kind)) {
      throw new Error("Revoked MCP client public keys cannot be paired again");
    }
    if (
      existing &&
      (existing.kind !== row.kind || existing.install_identity !== row.install_identity)
    ) {
      throw new Error("Revoked client identity does not match this pairing request");
    }
    const clientId = existing?.id ?? randomUUID();
    const grantId = randomUUID();
    const capabilities = parseCapabilities(row.requested_capabilities);
    const now = new Date(this.#now()).toISOString();
    const transaction = this.#database.transaction(() => {
      this.#consumeConnectorReconnect(row.kind, row.install_identity);
      if (existing) {
        this.#database.query(`
          update broker_clients
          set display_name = ?, code_requirement = ?, status = 'paired',
              paired_at = ?, revoked_at = null,
              authority_revision = authority_revision + 1
          where id = ? and status = 'revoked'
        `).run(row.display_name, row.code_requirement, now, clientId);
      } else {
        this.#database.query(`
          insert into broker_clients (
            id, vault_id, kind, display_name, install_identity, public_key,
            code_requirement, status, paired_at, revoked_at
          ) values (?, ?, ?, ?, ?, ?, ?, 'paired', ?, null)
        `).run(
          clientId,
          this.#vaultId,
          row.kind,
          row.display_name,
          row.install_identity,
          row.public_key,
          row.code_requirement,
          now,
        );
      }
      this.#database.query(`
        insert into broker_grants (
          id, client_id, capabilities, forget_policy, status, created_at,
          expires_at, revoked_at
        ) values (?, ?, ?, ?, 'active', ?, null, null)
      `).run(grantId, clientId, row.requested_capabilities, row.forget_policy, now);
      this.#database.query(
        "update broker_pairing_requests set status = 'paired', nonce = '' where id = ?",
      ).run(requestId);
      this.#appendAudit({
        eventId: randomUUID(),
        occurredAt: now,
        clientId,
        grantId,
        sessionId: null,
        operation: "client.pair",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      });
    });
    transaction();
    return { clientId, grantId, capabilities, forgetPolicy: row.forget_policy };
  }

  findPairedClient(input: {
    kind: BrokerClientKind;
    installIdentity: string;
    publicKey: string;
  }): {
    clientId: string;
    grantId: string;
    capabilities: BrokerCapability[];
    forgetPolicy: ForgetPolicy;
  } | null {
    assertClientKind(input.kind);
    assertBounded("install identity", input.installIdentity, 128);
    validatePublicKey(input.publicKey);
    const row = this.#database.query<{
      client_id: string;
      grant_id: string;
      capabilities: string;
      forget_policy: ForgetPolicy;
    }, [string, BrokerClientKind, string, string]>(`
      select c.id as client_id, g.id as grant_id, g.capabilities, g.forget_policy
      from broker_clients c
      join broker_grants g on g.client_id = c.id
      where c.vault_id = ? and c.kind = ? and c.install_identity = ?
        and c.public_key = ? and c.status = 'paired' and g.status = 'active'
      order by g.created_at desc limit 1
    `).get(this.#vaultId, input.kind, input.installIdentity, input.publicKey);
    return row
      ? {
          clientId: row.client_id,
          grantId: row.grant_id,
          capabilities: parseCapabilities(row.capabilities),
          forgetPolicy: row.forget_policy,
        }
      : null;
  }

  assertRevocableClient(clientId: string): void {
    assertIdentifier("client ID", clientId);
    const client = this.#client(clientId);
    if (client.vault_id !== this.#vaultId || client.status !== "paired") {
      throw new Error("Client is not available for revocation");
    }
  }

  requestActivation(input: {
    clientId: string;
    grantId: string;
    sessionPublicKey: string;
    requestedCapabilities: BrokerCapability[];
    ttlMs: number;
    transportBinding?: BrokerTransportBinding;
  }): {
    activationId: string;
    ownerDecisionTranscript: string;
    clientProofTranscript: string;
    sessionProofTranscript: string;
    authenticationPhrase: string;
    expiresAt: string;
  } {
    this.#assertOpen();
    validatePublicKey(input.sessionPublicKey);
    const requested = normalizeCapabilities(input.requestedCapabilities);
    if (input.transportBinding) assertTransportBinding(input.transportBinding);
    if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_SESSION_TTL_MS) {
      throw new Error("Session lifetime must be between one millisecond and 12 hours");
    }
    const client = this.#client(input.clientId);
    const grant = this.#grant(input.grantId);
    assertLiveClientGrant(client, grant, this.#vaultId, this.#now());
    if (isTrustedMcpClient(client) && input.ttlMs > TRUSTED_MCP_CONNECTION_TTL_MS) {
      throw new Error("Trusted MCP connection lifetime cannot exceed 15 minutes");
    }
    const trustedWorkSession = isTrustedMcpClient(client)
      ? this.#liveTrustedMcpWorkSession()
      : undefined;
    const granted = parseCapabilities(grant.capabilities);
    let effective = requested.filter((capability) => granted.includes(capability));
    if (grant.forget_policy === "never") {
      effective = effective.filter((capability) => capability !== "memory.forget");
    }
    if (effective.length === 0) throw new Error("Activation has no granted capabilities");
    const activationId = randomUUID();
    const nonce = randomBytes(32).toString("base64url");
    const decisionExpiresAt = new Date(
      this.#now() + ACTIVATION_DECISION_TTL_MS,
    ).toISOString();
    const expiresAt = new Date(Math.min(
      this.#now() + input.ttlMs,
      trustedWorkSession?.expiresAt ?? Number.POSITIVE_INFINITY,
    )).toISOString();
    this.#database.query(`
      insert into broker_sessions (
        id, vault_id, broker_boot_id, client_id, grant_id, session_public_key,
        capabilities, forget_policy, nonce, status, activated_at,
        decision_expires_at, expires_at, last_seen_at, transport_connection_id,
        transport_peer_pid, work_session_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', null, ?, ?, null, ?, ?, ?)
    `).run(
      activationId,
      this.#vaultId,
      this.#bootId,
      input.clientId,
      input.grantId,
      input.sessionPublicKey,
      JSON.stringify(effective),
      grant.forget_policy,
      nonce,
      decisionExpiresAt,
      expiresAt,
      input.transportBinding?.connectionId ?? null,
      input.transportBinding?.peerPid ?? null,
      trustedWorkSession?.id ?? null,
    );
    const row = this.#activation(activationId);
    const ownerDecisionTranscript = activationTranscript("owner-approve-activation", row);
    const digest = createHash("sha256").update(ownerDecisionTranscript).digest("hex");
    return {
      activationId,
      ownerDecisionTranscript,
      clientProofTranscript: activationTranscript("installed-client-activation-proof", row),
      sessionProofTranscript: activationTranscript("ephemeral-session-activation-proof", row),
      authenticationPhrase: `${digest.slice(0, 4)} ${digest.slice(4, 8)} ${digest.slice(8, 12)}`,
      expiresAt,
    };
  }

  approveActivation(input: {
    activationId: string;
    ownerSignature: string;
    clientSignature: string;
    sessionSignature: string;
  }): {
    sessionId: string;
    clientId: string;
    grantId: string;
    capabilities: BrokerCapability[];
    forgetPolicy: ForgetPolicy;
    expiresAt: string;
  } {
    const row = this.#activeActivation(input.activationId);
    const client = this.#client(row.client_id);
    const grant = this.#grant(row.grant_id);
    assertLiveClientGrant(client, grant, this.#vaultId, this.#now());
    verifyTranscript(
      activationTranscript("owner-approve-activation", row),
      input.ownerSignature,
      this.#ownerPublicKey,
      "owner",
    );
    verifyTranscript(
      activationTranscript("installed-client-activation-proof", row),
      input.clientSignature,
      client.public_key,
      "client",
    );
    verifyTranscript(
      activationTranscript("ephemeral-session-activation-proof", row),
      input.sessionSignature,
      row.session_public_key,
      "session",
    );
    const existingWorkSession = isTrustedMcpClient(client)
      ? this.#liveTrustedMcpWorkSession()
      : undefined;
    const workSession = isTrustedMcpClient(client)
      ? existingWorkSession ?? this.#startTrustedMcpWorkSession()
      : undefined;
    try {
      return this.#activateSession(row, workSession);
    } catch (error) {
      if (
        !existingWorkSession &&
        workSession &&
        this.#trustedMcpWorkSession?.id === workSession.id
      ) {
        this.#trustedMcpWorkSession = undefined;
      }
      throw error;
    }
  }

  canSilentlyActivateTrustedMcp(activationId: string): boolean {
    const row = this.#activeActivation(activationId);
    const client = this.#client(row.client_id);
    const grant = this.#grant(row.grant_id);
    assertLiveClientGrant(client, grant, this.#vaultId, this.#now());
    if (!isTrustedMcpClient(client)) return false;
    assertTrustedMcpCapabilities(row);
    const workSession = this.#liveTrustedMcpWorkSession();
    return workSession !== undefined && row.work_session_id === workSession.id;
  }

  approveTrustedMcpActivation(input: {
    activationId: string;
    clientSignature: string;
    sessionSignature: string;
  }): {
    sessionId: string;
    clientId: string;
    grantId: string;
    capabilities: BrokerCapability[];
    forgetPolicy: ForgetPolicy;
    expiresAt: string;
  } {
    const row = this.#activeActivation(input.activationId);
    const client = this.#client(row.client_id);
    const grant = this.#grant(row.grant_id);
    assertLiveClientGrant(client, grant, this.#vaultId, this.#now());
    if (!isTrustedMcpClient(client)) {
      throw new Error("Only a trusted MCP client can use the work session");
    }
    assertTrustedMcpCapabilities(row);
    verifyTranscript(
      activationTranscript("installed-client-activation-proof", row),
      input.clientSignature,
      client.public_key,
      "client",
    );
    verifyTranscript(
      activationTranscript("ephemeral-session-activation-proof", row),
      input.sessionSignature,
      row.session_public_key,
      "session",
    );
    const workSession = this.#liveTrustedMcpWorkSession();
    if (!workSession || row.work_session_id !== workSession.id) {
      throw new Error("Trusted work session is expired");
    }
    return this.#activateSession(row, workSession);
  }

  #activateSession(
    row: ActivationRow,
    workSession?: TrustedMcpWorkSession,
  ): {
    sessionId: string;
    clientId: string;
    grantId: string;
    capabilities: BrokerCapability[];
    forgetPolicy: ForgetPolicy;
    expiresAt: string;
  } {
    const currentTime = this.#now();
    const now = new Date(currentTime).toISOString();
    const expiresAt = new Date(Math.min(
      Date.parse(row.expires_at),
      workSession?.expiresAt ?? Number.POSITIVE_INFINITY,
    )).toISOString();
    this.#database.transaction(() => {
      const changed = this.#database.query(`
        update broker_sessions
        set status = 'active', activated_at = ?, last_seen_at = ?, nonce = '',
            expires_at = ?, work_session_id = ?
        where id = ? and status = 'pending'
      `).run(now, now, expiresAt, workSession?.id ?? null, row.id).changes;
      if (changed !== 1) throw new Error("Activation request is no longer available");
      this.#appendAudit({
        eventId: randomUUID(),
        occurredAt: now,
        clientId: row.client_id,
        grantId: row.grant_id,
        sessionId: row.id,
        operation: "session.activate",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      });
    })();
    if (workSession) this.#touchTrustedMcpWorkSession(workSession, currentTime);
    return {
      sessionId: row.id,
      clientId: row.client_id,
      grantId: row.grant_id,
      capabilities: parseCapabilities(row.capabilities),
      forgetPolicy: row.forget_policy,
      expiresAt,
    };
  }

  verifyActivationProofs(input: {
    activationId: string;
    clientSignature: string;
    sessionSignature: string;
  }): void {
    const row = this.#activeActivation(input.activationId);
    const client = this.#client(row.client_id);
    const grant = this.#grant(row.grant_id);
    assertLiveClientGrant(client, grant, this.#vaultId, this.#now());
    verifyTranscript(
      activationTranscript("installed-client-activation-proof", row),
      input.clientSignature,
      client.public_key,
      "client",
    );
    verifyTranscript(
      activationTranscript("ephemeral-session-activation-proof", row),
      input.sessionSignature,
      row.session_public_key,
      "session",
    );
  }

  activationOwnerTranscriptForPending(activationId: string): string {
    return activationTranscript(
      "owner-approve-activation",
      this.#activeActivation(activationId),
    );
  }

  activationClientKind(activationId: string): BrokerClientKind {
    const row = this.#activeActivation(activationId);
    return this.#client(row.client_id).kind;
  }

  denyActivation(activationId: string, errorCode = "owner_denied"): void {
    const row = this.#activation(activationId);
    if (row.vault_id !== this.#vaultId || row.broker_boot_id !== this.#bootId) {
      throw new Error("Activation request is no longer available");
    }
    const changed = this.#database.query(
      "update broker_sessions set status = 'revoked', nonce = '' where id = ? and status in ('pending', 'expired')",
    ).run(activationId).changes;
    if (changed !== 1) return;
    this.#appendAudit({
      eventId: randomUUID(),
      occurredAt: new Date(this.#now()).toISOString(),
      clientId: row.client_id,
      grantId: row.grant_id,
      sessionId: row.id,
      operation: "session.activate",
      outcome: "denied",
      errorCode,
      noteRefs: [],
    });
  }

  unsignedEnvelope(input: {
    clientId: string;
    grantId: string;
    sessionId: string;
    requestId: string;
    operation: string;
    body: Uint8Array;
    vaultId?: string;
    brokerBootId?: string;
    issuedAt?: string;
  }): UnsignedBrokerRequestEnvelope {
    return {
      protocolVersion: PROTOCOL_VERSION,
      brokerBootId: input.brokerBootId ?? this.#bootId,
      vaultId: input.vaultId ?? this.#vaultId,
      clientId: input.clientId,
      grantId: input.grantId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      issuedAt: input.issuedAt ?? new Date(this.#now()).toISOString(),
      operation: input.operation,
      bodySha256: createHash("sha256").update(input.body).digest("hex"),
    };
  }

  authorize(
    envelope: BrokerRequestEnvelope,
    body: Uint8Array,
    transportBinding?: BrokerTransportBinding,
  ): BrokerAuthorization {
    return this.#authorize(envelope, body, false, transportBinding);
  }

  requestForgetDecision(
    envelope: BrokerRequestEnvelope,
    body: Uint8Array,
  ): { decisionId: string; ownerDecisionTranscript: string; expiresAt: string } {
    if (envelope.operation !== "memory.forget") {
      throw new Error("Forget decision requires a memory.forget request");
    }
    const authorization = this.#authorize(envelope, body, true);
    try {
      const noteId = forgetNoteId(body);
      assertIdentifier("note ID", noteId);
      const noteRevision = this.#database.query<{ current_revision: number }, [string]>(
        "select current_revision from notes where id = ?",
      ).get(noteId)?.current_revision ?? null;
      if (noteRevision === null) throw new Error("Forget note was not found");
      const session = this.#session(authorization.sessionId);
      if (session.forget_policy !== "confirm_each") {
        throw new Error("Session does not use confirm-each Forget");
      }
      const decisionId = randomUUID();
      const nonce = randomBytes(32).toString("base64url");
      const expiresAt = new Date(this.#now() + DECISION_TTL_MS).toISOString();
      this.#database.query(`
        insert into broker_forget_decisions (
          id, event_id, client_id, grant_id, session_id, note_id, note_revision,
          nonce, status, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        decisionId,
        authorization.eventId,
        authorization.clientId,
        authorization.grantId,
        authorization.sessionId,
        noteId,
        noteRevision,
        nonce,
        expiresAt,
      );
      const row = this.#forgetDecision(decisionId);
      return {
        decisionId,
        ownerDecisionTranscript: forgetDecisionTranscript(row, this.#vaultId, this.#bootId),
        expiresAt,
      };
    } catch (error) {
      this.recordAudit(authorization, "error", [], "forget_decision_failed");
      throw error;
    }
  }

  approveForgetDecision(decisionId: string, ownerSignature: string): void {
    const row = this.#activeForgetDecision(decisionId, "pending");
    verifyTranscript(
      forgetDecisionTranscript(row, this.#vaultId, this.#bootId),
      ownerSignature,
      this.#ownerPublicKey,
      "owner",
    );
    this.#database.query(
      "update broker_forget_decisions set status = 'approved' where id = ? and status = 'pending'",
    ).run(decisionId);
  }

  expireForgetDecisions(): number {
    this.#assertOpen();
    return this.#expireForgetDecisions();
  }

  #expireForgetDecisions(): number {
    const now = new Date(this.#now()).toISOString();
    const expired = this.#database.query<
      Pick<ForgetDecisionRow, "id" | "event_id">,
      [string]
    >(`
      select id, event_id
      from broker_forget_decisions
      where status in ('pending', 'approved') and expires_at <= ?
      order by id
    `).all(now);
    if (expired.length === 0) return 0;

    return this.#database.transaction(() => {
      let count = 0;
      for (const decision of expired) {
        const changed = this.#database.query(`
          update broker_forget_decisions
          set status = 'expired', nonce = ''
          where id = ? and status in ('pending', 'approved') and expires_at <= ?
        `).run(decision.id, now).changes;
        if (changed !== 1) continue;
        const auditChanged = this.#database.query(`
          update broker_audit_events
          set occurred_at = ?, outcome = 'error', error_code = 'forget_decision_expired',
              note_refs = '[]'
          where event_id = ? and outcome = 'authorized'
        `).run(now, decision.event_id).changes;
        if (auditChanged !== 1) throw new Error("Forget audit intent was not available");
        count += 1;
      }
      return count;
    })();
  }

  executeApprovedForget(decisionId: string): boolean {
    const row = this.#activeForgetDecision(decisionId, "approved");
    const authorization: BrokerAuthorization = {
      eventId: row.event_id,
      clientId: row.client_id,
      grantId: row.grant_id,
      sessionId: row.session_id,
      operation: "memory.forget",
    };
    try {
      const session = this.#session(row.session_id);
      const client = this.#client(row.client_id);
      const grant = this.#grant(row.grant_id);
      assertLiveClientGrant(client, grant, this.#vaultId, this.#now());
      if (
        session.status !== "active" ||
        session.broker_boot_id !== this.#bootId ||
        Date.parse(session.expires_at) <= this.#now()
      ) {
        throw new Error("Forget session is no longer active");
      }
    } catch (error) {
      this.#database.transaction(() => {
        const changed = this.#database.query(`
          update broker_forget_decisions
          set status = 'expired', nonce = ''
          where id = ? and status = 'approved'
        `).run(decisionId).changes;
        if (changed !== 1) throw new Error("Forget decision was not available");
        this.recordAudit(authorization, "error", [], "forget_session_inactive");
      })();
      throw error;
    }
    const transaction = this.#database.transaction(() => {
      const deleted = this.#database.query(
        "delete from notes where id = ? and current_revision = ?",
      ).run(row.note_id, row.note_revision).changes;
      if (deleted !== 1) {
        this.#database.query(
          "update broker_forget_decisions set status = 'expired', nonce = '' where id = ?",
        ).run(decisionId);
        this.#database.query(`
          update broker_audit_events
          set occurred_at = ?, outcome = 'error', error_code = 'stale_revision', note_refs = '[]'
          where event_id = ? and outcome = 'authorized'
        `).run(new Date(this.#now()).toISOString(), row.event_id);
        return false;
      }
      this.#database.query(
        "update broker_forget_decisions set status = 'consumed', nonce = '' where id = ? and status = 'approved'",
      ).run(decisionId);
      const auditUpdated = this.#database.query(`
        update broker_audit_events
        set occurred_at = ?, outcome = 'success', error_code = null, note_refs = ?
        where event_id = ? and outcome = 'authorized'
      `).run(
        new Date(this.#now()).toISOString(),
        JSON.stringify([{ noteId: row.note_id, revision: row.note_revision }]),
        row.event_id,
      ).changes;
      if (auditUpdated !== 1) throw new Error("Forget audit intent was not available");
      return true;
    });
    const deleted = transaction();
    if (!deleted) throw new Error("Note revision changed after Forget approval");
    return true;
  }

  #authorize(
    envelope: BrokerRequestEnvelope,
    body: Uint8Array,
    allowConfirmEachForget: boolean,
    transportBinding?: BrokerTransportBinding,
  ): BrokerAuthorization {
    this.#assertOpen();
    const eventId = randomUUID();
    try {
      assertEnvelopeShape(envelope);
      if (envelope.protocolVersion !== PROTOCOL_VERSION) throw new Error("Protocol version is invalid");
      if (envelope.brokerBootId !== this.#bootId) throw new Error("Broker boot does not match");
      if (envelope.vaultId !== this.#vaultId) throw new Error("Request vault does not match");
      const bodyHash = createHash("sha256").update(body).digest("hex");
      if (bodyHash !== envelope.bodySha256) throw new Error("Request body hash does not match");
      const issued = Date.parse(envelope.issuedAt);
      if (!Number.isFinite(issued) || Math.abs(this.#now() - issued) > MAX_CLOCK_SKEW_MS) {
        throw new Error("Request timestamp is outside the allowed window");
      }
      const session = this.#session(envelope.sessionId);
      if (
        session.client_id !== envelope.clientId ||
        session.grant_id !== envelope.grantId ||
        session.vault_id !== envelope.vaultId ||
        session.broker_boot_id !== envelope.brokerBootId
      ) {
        throw new Error("Request context does not match the active session");
      }
      if (session.transport_connection_id !== null) {
        if (!transportBinding) {
          throw new Error("Request is missing its transport binding");
        }
        assertTransportBinding(transportBinding);
        if (
          session.transport_connection_id !== transportBinding.connectionId ||
          session.transport_peer_pid !== transportBinding.peerPid
        ) {
          throw new Error("Request transport does not match the active session");
        }
      }
      const client = this.#client(envelope.clientId);
      const grant = this.#grant(envelope.grantId);
      assertLiveClientGrant(client, grant, this.#vaultId, this.#now());
      if (session.status !== "active") throw new Error(`Session is ${session.status}`);
      if (Date.parse(session.expires_at) <= this.#now()) {
        this.#expireSession(session, "session_expired");
        throw new Error("Session is expired");
      }
      const required = operationCapability(envelope.operation);
      if (!parseCapabilities(session.capabilities).includes(required)) {
        throw new Error(`Session does not grant ${required}`);
      }
      if (
        required === "memory.forget" &&
        session.forget_policy === "confirm_each" &&
        !allowConfirmEachForget
      ) {
        throw new Error("Forget requires owner confirmation");
      }
      verifyTranscript(
        canonicalBrokerTranscript(unsignedEnvelope(envelope)),
        envelope.signature,
        session.session_public_key,
        "session",
      );
      this.#database.query(
        "delete from broker_request_replays where consumed_at < ?",
      ).run(new Date(this.#now() - REPLAY_RETENTION_MS).toISOString());
      try {
        this.#database.query(`
          insert into broker_request_replays (request_id, session_id, consumed_at)
          values (?, ?, ?)
        `).run(envelope.requestId, envelope.sessionId, new Date(this.#now()).toISOString());
      } catch (error) {
        throw new Error("Request was replayed", { cause: error });
      }
      const trustedWorkSession = isTrustedMcpClient(client)
        ? this.#liveTrustedMcpWorkSession()
        : undefined;
      if (
        isTrustedMcpClient(client) &&
        (!trustedWorkSession || session.work_session_id !== trustedWorkSession.id)
      ) {
        throw new Error("Trusted work session is expired");
      }
      this.#database.query(
        "update broker_sessions set last_seen_at = ? where id = ?",
      ).run(new Date(this.#now()).toISOString(), session.id);
      const authorization = {
        eventId,
        clientId: client.id,
        grantId: grant.id,
        sessionId: session.id,
        operation: envelope.operation,
      };
      this.#appendAudit({
        eventId,
        occurredAt: new Date(this.#now()).toISOString(),
        clientId: client.id,
        grantId: grant.id,
        sessionId: session.id,
        operation: envelope.operation,
        outcome: "authorized",
        errorCode: null,
        noteRefs: [],
      });
      if (trustedWorkSession) {
        this.#touchTrustedMcpWorkSession(trustedWorkSession, this.#now());
      }
      return authorization;
    } catch (error) {
      if (this.#knownClient(envelope.clientId)) {
        this.#appendAudit({
          eventId,
          occurredAt: new Date(this.#now()).toISOString(),
          clientId: envelope.clientId,
          grantId: safeIdentifier(envelope.grantId),
          sessionId: safeIdentifier(envelope.sessionId),
          operation: safeOperation(envelope.operation),
          outcome: "denied",
          errorCode: "unauthorized",
          noteRefs: [],
        });
      }
      throw error;
    }
  }

  recordAudit(
    authorization: BrokerAuditAuthorization,
    outcome: Exclude<AuditOutcome, "authorized">,
    noteRefs: Array<{ noteId: string; revision: number }>,
    errorCode: string | null = null,
  ): void {
    if (!(["success", "denied", "error"] as const).includes(outcome)) {
      throw new Error("Audit outcome is invalid");
    }
    if (noteRefs.length > MAX_NOTE_REFS) throw new Error("Audit note reference limit exceeded");
    const normalized = noteRefs.map((reference) => {
      assertIdentifier("note ID", reference.noteId);
      if (!Number.isInteger(reference.revision) || reference.revision <= 0) {
        throw new Error("Audit note revision is invalid");
      }
      return { noteId: reference.noteId, revision: reference.revision };
    });
    const changed = this.#database.query(`
      update broker_audit_events
      set occurred_at = ?, outcome = ?, error_code = ?, note_refs = ?
      where event_id = ? and client_id = ? and grant_id is ? and session_id is ?
        and operation = ? and outcome = 'authorized'
    `).run(
      new Date(this.#now()).toISOString(),
      outcome,
      errorCode ? safeErrorCode(errorCode) : null,
      JSON.stringify(normalized),
      authorization.eventId,
      authorization.clientId,
      authorization.grantId,
      authorization.sessionId,
      safeOperation(authorization.operation),
    ).changes;
    if (changed !== 1) throw new Error("Authorized audit event was not available");
  }

  async executeAuthorizedRead<Result>(
    envelope: BrokerRequestEnvelope,
    body: Uint8Array,
    dispatch: (authorization: BrokerAuthorization) => Promise<{
      result: Result;
      noteRefs: Array<{ noteId: string; revision: number }>;
    }>,
    transportBinding?: BrokerTransportBinding,
  ): Promise<Result> {
    const authorization = this.authorize(envelope, body, transportBinding);
    try {
      const completed = await dispatch(authorization);
      this.recordAudit(authorization, "success", completed.noteRefs);
      return completed.result;
    } catch (error) {
      this.recordAudit(authorization, "error", [], "operation_failed");
      throw error;
    }
  }

  executeAuthorizedMutation<Result>(
    envelope: BrokerRequestEnvelope,
    body: Uint8Array,
    dispatch: (
      database: SqlcipherDatabase,
      authorization: BrokerAuthorization,
    ) => {
      result: Result;
      noteRefs: Array<{ noteId: string; revision: number }>;
    },
    transportBinding?: BrokerTransportBinding,
  ): Result {
    const authorization = this.authorize(envelope, body, transportBinding);
    try {
      const transaction = this.#database.transaction(() => {
        const completed = dispatch(this.#database, authorization);
        this.recordAudit(authorization, "success", completed.noteRefs);
        return completed.result;
      });
      return transaction();
    } catch (error) {
      try {
        this.recordAudit(authorization, "error", [], "operation_failed");
      } catch {
        // Preserve the typed mutation failure when the audit ledger itself is unavailable.
      }
      throw error;
    }
  }

  async executeNativeLibraryRead<Result>(
    sessionId: string,
    operation: string,
    dispatch: () => Promise<{
      result: Result;
      noteRefs: Array<{ noteId: string; revision: number }>;
    }>,
  ): Promise<Result> {
    const authorization = this.#beginNativeLibraryAudit(sessionId, operation);
    try {
      const completed = await dispatch();
      this.recordAudit(authorization, "success", completed.noteRefs);
      return completed.result;
    } catch (error) {
      this.recordAudit(authorization, "error", [], "operation_failed");
      throw error;
    }
  }

  executeNativeLibraryMutation<Result>(
    sessionId: string,
    operation: string,
    dispatch: (database: SqlcipherDatabase) => {
      result: Result;
      noteRefs: Array<{ noteId: string; revision: number }>;
    },
  ): Result {
    const authorization = this.#beginNativeLibraryAudit(sessionId, operation);
    try {
      return this.#database.transaction(() => {
        const completed = dispatch(this.#database);
        try {
          this.recordAudit(authorization, "success", completed.noteRefs);
        } catch (error) {
          throw new NativeLibraryAuditCommitError({ cause: error });
        }
        return completed.result;
      })();
    } catch (error) {
      try {
        this.recordAudit(authorization, "error", [], "operation_failed");
      } catch {
        // Preserve audit_commit_failed when the terminal error audit cannot update either.
      }
      throw error;
    }
  }

  recordNativeLibraryOutcome(
    sessionId: string,
    operation: string,
    outcome: "denied" | "error",
    errorCode: string,
    noteRefs: Array<{ noteId: string; revision: number }> = [],
  ): void {
    const authorization = this.#beginNativeLibraryAudit(sessionId, operation);
    this.recordAudit(authorization, outcome, noteRefs, errorCode);
  }

  executeNativeOwnerAdmin<Result>(
    operation: string,
    dispatch: () => Result,
  ): Result {
    const authorization = this.#beginNativeOwnerAdminAudit(operation);
    try {
      const result = dispatch();
      this.recordAudit(authorization, "success", []);
      return result;
    } catch (error) {
      try {
        this.recordAudit(authorization, "error", [], "operation_failed");
      } catch {
        // Preserve the operation failure if the terminal audit update also fails.
      }
      throw error;
    }
  }

  recordNativeOwnerAdminOutcome(
    operation: string,
    outcome: "denied" | "error",
    errorCode: string,
  ): void {
    const authorization = this.#beginNativeOwnerAdminAudit(operation);
    this.recordAudit(authorization, outcome, [], errorCode);
  }

  #beginNativeLibraryAudit(
    sessionId: string,
    operation: string,
  ): BrokerAuthorization {
    this.#assertOpen();
    assertIdentifier("native library session ID", sessionId);
    if (!/^library\.[a-z_]{1,48}$/.test(operation)) {
      throw new Error("Native library operation is invalid");
    }
    const authorization = {
      eventId: randomUUID(),
      clientId: "native-library",
      grantId: "native-library",
      sessionId,
      operation,
    };
    this.#appendAudit({
      eventId: authorization.eventId,
      occurredAt: new Date(this.#now()).toISOString(),
      clientId: authorization.clientId,
      grantId: authorization.grantId,
      sessionId,
      operation,
      outcome: "authorized",
      errorCode: null,
      noteRefs: [],
    });
    return authorization;
  }

  #beginNativeOwnerAdminAudit(operation: string): BrokerAuditAuthorization {
    this.#assertOpen();
    if (!/^(admin\.(export|diagnostics|prepare_client_rotation)|lifecycle\.(lock|unlock)|recovery\.(migrate|restore))$/.test(operation)) {
      throw new Error("Native owner administration operation is invalid");
    }
    const authorization: BrokerAuditAuthorization = {
      eventId: randomUUID(),
      clientId: "owner",
      grantId: null,
      sessionId: null,
      operation,
    };
    this.#appendAudit({
      eventId: authorization.eventId,
      occurredAt: new Date(this.#now()).toISOString(),
      clientId: authorization.clientId,
      grantId: null,
      sessionId: null,
      operation,
      outcome: "authorized",
      errorCode: null,
      noteRefs: [],
    });
    return authorization;
  }

  inspectConnections(trust: OwnerTrustPath): {
    clients: Array<{
      clientId: string;
      kind: BrokerClientKind;
      displayLabel: string;
      status: "paired" | "active" | "revoked" | "expired";
      trust: OwnerTrustPath;
      pairedAt: string;
      revokedAt: string | null;
      lastActivityAt: string | null;
      authorityRevision: number;
      activeScopes: BrokerCapability[];
      sessionSummary: {
        activeCount: number;
        latestStatus: "active" | "expired" | "disconnected" | "revoked" | "none";
      };
    }>;
    grants: Array<{
      grantId: string;
      clientId: string;
      scopes: BrokerCapability[];
      status: "active" | "revoked" | "expired";
      createdAt: string;
      expiresAt: string | null;
      revokedAt: string | null;
    }>;
    sessions: Array<{
      sessionId: string;
      clientId: string;
      grantId: string;
      status: "active" | "expired" | "disconnected" | "revoked";
      startedAt: string;
      expiresAt: string;
      lastActivityAt: string | null;
    }>;
  } {
    this.#assertOpen();
    if (trust !== "production-signed" && trust !== "development-only") {
      throw new Error("Owner trust path is invalid");
    }
    this.#liveTrustedMcpWorkSession();
    const clients = this.#database.query<{
      id: string;
      kind: BrokerClientKind;
      status: "paired" | "revoked";
      paired_at: string;
      revoked_at: string | null;
      authority_revision: number;
      last_activity_at: string | null;
      live_sessions: number;
      live_grants: number;
    }, [string, string, string]>(`
      select c.id, c.kind, c.status, c.paired_at, c.revoked_at,
             c.authority_revision, max(s.last_seen_at) as last_activity_at,
             sum(case when s.status = 'active' and s.expires_at > ? then 1 else 0 end)
               as live_sessions,
             (select count(*) from broker_grants g
               where g.client_id = c.id and g.status = 'active'
                 and (g.expires_at is null or g.expires_at > ?)) as live_grants
      from broker_clients c
      left join broker_sessions s on s.client_id = c.id
      where c.vault_id = ?
      group by c.id
      order by c.paired_at desc, c.id desc
      limit ${MAX_OWNER_RECORDS}
    `).all(
      new Date(this.#now()).toISOString(),
      new Date(this.#now()).toISOString(),
      this.#vaultId,
    ).map((row) => {
      const latestSession = this.#database.query<{
        status: "active" | "disconnected" | "expired" | "revoked";
        expires_at: string;
      }, [string]>(`
        select status, expires_at from broker_sessions
        where client_id = ? and status <> 'pending' and activated_at is not null
        order by activated_at desc, id desc limit 1
      `).get(row.id);
      return {
        clientId: row.id,
        kind: row.kind,
        displayLabel: brokerClientDisplayLabel(row.kind),
        status: row.status === "revoked"
          ? "revoked" as const
          : row.live_sessions > 0
          ? "active" as const
          : row.live_grants > 0
          ? "paired" as const
          : "expired" as const,
        trust,
        pairedAt: row.paired_at,
        revokedAt: row.revoked_at,
        lastActivityAt: row.last_activity_at,
        authorityRevision: row.authority_revision,
        activeScopes: row.status === "paired" ? this.revocationTarget(row.id).scopes : [],
        sessionSummary: {
          activeCount: row.live_sessions,
          latestStatus: latestSession == null
            ? "none" as const
            : latestSession.status === "active" &&
                Date.parse(latestSession.expires_at) <= this.#now()
            ? "expired" as const
            : latestSession.status,
        },
      };
    });
    const grants = this.#database.query<{
      id: string;
      client_id: string;
      capabilities: string;
      status: "active" | "revoked";
      created_at: string;
      expires_at: string | null;
      revoked_at: string | null;
    }, [string]>(`
      select g.id, g.client_id, g.capabilities, g.status, g.created_at,
             g.expires_at, g.revoked_at
      from broker_grants g
      join broker_clients c on c.id = g.client_id
      where c.vault_id = ?
      order by g.created_at desc, g.id desc
      limit ${MAX_OWNER_RECORDS}
    `).all(this.#vaultId).map((row) => ({
      grantId: row.id,
      clientId: row.client_id,
      scopes: parseCapabilities(row.capabilities),
      status: row.status === "revoked"
        ? "revoked" as const
        : row.expires_at !== null && Date.parse(row.expires_at) <= this.#now()
        ? "expired" as const
        : "active" as const,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    }));
    const sessions = this.#database.query<{
      id: string;
      client_id: string;
      grant_id: string;
      status: "active" | "disconnected" | "expired" | "revoked";
      activated_at: string;
      expires_at: string;
      last_seen_at: string | null;
    }, [string]>(`
      select s.id, s.client_id, s.grant_id, s.status, s.activated_at,
             s.expires_at, s.last_seen_at
      from broker_sessions s
      where s.vault_id = ? and s.status <> 'pending' and s.activated_at is not null
      order by s.activated_at desc, s.id desc
      limit ${MAX_OWNER_RECORDS}
    `).all(this.#vaultId).map((row) => ({
      sessionId: row.id,
      clientId: row.client_id,
      grantId: row.grant_id,
      status: row.status === "active" && Date.parse(row.expires_at) <= this.#now()
        ? "expired" as const
        : row.status,
      startedAt: row.activated_at,
      expiresAt: row.expires_at,
      lastActivityAt: row.last_seen_at,
    }));
    return { clients, grants, sessions };
  }

  inspectAudit(input: { pageSize?: number; cursor?: string }): {
    events: Array<{
      eventId: string;
      occurredAt: string;
      clientId: string;
      clientKind: BrokerClientKind | null;
      clientDisplayLabel: string;
      grantId: string | null;
      sessionId: string | null;
      operation: string;
      outcome: AuditOutcome;
      errorCode: string | null;
      noteRefs: Array<{ noteId: string; revision: number }>;
    }>;
    nextCursor: string | null;
  } {
    this.#assertOpen();
    const pageSize = input.pageSize ?? DEFAULT_AUDIT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_AUDIT_PAGE_SIZE) {
      throw new Error(`Audit page size must be between 1 and ${MAX_AUDIT_PAGE_SIZE}`);
    }
    const cursor = input.cursor
      ? this.#decodeAuditCursor(input.cursor)
      : {
          snapshotRowId: this.#database.query<{ row_id: number }, []>(
            "select coalesce(max(rowid), 0) as row_id from broker_audit_events",
          ).get()!.row_id,
          beforeRowId: Number.MAX_SAFE_INTEGER,
          expiresAt: this.#now() + AUDIT_CURSOR_TTL_MS,
        };
    const rows = this.#database.query<{
      row_id: number;
      event_id: string;
      occurred_at: string;
      client_id: string;
      client_kind: BrokerClientKind | null;
      grant_id: string | null;
      session_id: string | null;
      operation: string;
      outcome: AuditOutcome;
      error_code: string | null;
      note_refs: string;
    }, [string, number, number]>(`
      select a.rowid as row_id, a.event_id, a.occurred_at, a.client_id,
             c.kind as client_kind, a.grant_id, a.session_id, a.operation,
             a.outcome, a.error_code, a.note_refs
      from broker_audit_events a
      left join broker_clients c on c.id = a.client_id and c.vault_id = ?
      where a.rowid <= ? and a.rowid < ?
      order by a.rowid desc
      limit ${pageSize + 1}
    `).all(this.#vaultId, cursor.snapshotRowId, cursor.beforeRowId);
    const visible = rows.slice(0, pageSize);
    const events = visible.map((row) => ({
      eventId: row.event_id,
      occurredAt: row.occurred_at,
      clientId: row.client_id,
      clientKind: row.client_kind,
      clientDisplayLabel: row.client_kind
        ? brokerClientDisplayLabel(row.client_kind)
        : row.client_id === "owner"
        ? "Owner"
        : row.client_id === "native-library"
        ? "Afternote Library"
        : row.client_id.startsWith("pending:")
        ? "Pending client"
        : "Unknown client",
      grantId: row.grant_id,
      sessionId: row.session_id,
      operation: row.operation,
      outcome: row.outcome,
      errorCode: row.error_code,
      noteRefs: parseAuditNoteRefs(row.note_refs),
    }));
    if (Buffer.byteLength(JSON.stringify(events)) > MAX_AUDIT_RESPONSE_BYTES) {
      throw new Error("Audit response exceeds the owner-inspection byte limit");
    }
    return {
      events,
      nextCursor: rows.length > pageSize && visible.length > 0
        ? this.#encodeAuditCursor({
            snapshotRowId: cursor.snapshotRowId,
            beforeRowId: visible.at(-1)!.row_id,
            expiresAt: cursor.expiresAt,
          })
        : null,
    };
  }

  revocationTarget(clientId: string): OwnerRevocationTarget {
    this.assertRevocableClient(clientId);
    const client = this.#client(clientId);
    const grants = this.#database.query<{ capabilities: string }, [string]>(`
      select capabilities from broker_grants
      where client_id = ? and status = 'active'
      order by created_at desc, id desc
    `).all(clientId);
    return {
      clientId,
      kind: client.kind,
      displayLabel: brokerClientDisplayLabel(client.kind),
      authorityRevision: client.authority_revision,
      scopes: normalizeCapabilities(grants.flatMap((grant) =>
        parseCapabilities(grant.capabilities)
      )),
    };
  }

  connectorRevocationTarget(kind: BrokerClientKind): OwnerConnectorRevocationTarget {
    assertClientKind(kind);
    const clients = this.#database.query<{ id: string }, [string, BrokerClientKind]>(`
      select id from broker_clients
      where vault_id = ? and kind = ? and status = 'paired'
      order by id asc
    `).all(this.#vaultId, kind).map((row) => this.revocationTarget(row.id));
    if (clients.length === 0) {
      throw new Error("Connector has no current authority to revoke");
    }
    return {
      kind,
      displayLabel: brokerClientDisplayLabel(kind),
      clients,
    };
  }

  clientRotationTarget(
    kind: "codex" | "claude" | "claude-desktop",
    installIdentity: string,
  ): OwnerClientRotationTarget {
    assertClientKind(kind);
    assertBounded("install identity", installIdentity, 128);
    const matches = this.#database.query<{
      id: string;
      status: string;
    }, [string, string, string]>(`
      select id, status from broker_clients
      where vault_id = ? and kind = ? and install_identity = ?
      order by paired_at desc, id desc limit 2
    `).all(this.#vaultId, kind, installIdentity);
    if (matches.length === 0) {
      return {
        clientId: null,
        kind,
        displayLabel: brokerClientDisplayLabel(kind),
        installIdentity,
        authorityRevision: 0,
        scopes: [],
      };
    }
    if (matches.length !== 1) {
      throw new Error("MCP client identity is ambiguous and cannot be rotated");
    }
    const match = matches[0]!;
    if (match.status !== "paired" && match.status !== "revoked") {
      throw new Error("MCP client identity status is unsafe for rotation");
    }
    const target = match.status === "paired"
      ? this.revocationTarget(match.id)
      : this.#revokedClientRotationTarget(match.id);
    return {
      ...target,
      kind,
      installIdentity,
    };
  }

  revokeClientForRotation(
    target: OwnerClientRotationTarget,
    replacementInstallIdentity: string,
  ): void {
    assertBounded("replacement install identity", replacementInstallIdentity, 128);
    if (replacementInstallIdentity === target.installIdentity) {
      throw new Error("Replacement MCP client identity must be new");
    }
    const current = this.clientRotationTarget(target.kind, target.installIdentity);
    if (canonicalBrokerTranscript(current) !== canonicalBrokerTranscript(target)) {
      throw new Error("Client rotation target changed before approval");
    }
    const clientId = target.clientId;
    if (clientId === null) {
      this.#database.transaction(() => {
        this.#setConnectorReconnect(
          target.kind,
          "prepared",
          replacementInstallIdentity,
          new Date(this.#now()).toISOString(),
        );
      })();
      return;
    }
    const approvedTarget: OwnerRevocationTarget = { ...target, clientId };
    const client = this.#client(clientId);
    if (client.status === "paired") {
      this.#revokeClientWithAudit(
        approvedTarget,
        "client.rotate_identity",
        replacementInstallIdentity,
      );
      return;
    }
    if (client.status !== "revoked") {
      throw new Error("MCP client identity status is unsafe for rotation");
    }
    const transaction = this.#database.transaction(() => {
      const retryTarget = this.clientRotationTarget(target.kind, target.installIdentity);
      if (canonicalBrokerTranscript(retryTarget) !== canonicalBrokerTranscript(target)) {
        throw new Error("Client rotation target changed before commit");
      }
      const now = new Date(this.#now()).toISOString();
      this.#setConnectorReconnect(
        target.kind,
        "prepared",
        replacementInstallIdentity,
        now,
      );
      this.#appendAudit({
        eventId: randomUUID(),
        occurredAt: now,
        clientId,
        grantId: null,
        sessionId: null,
        operation: "client.rotate_identity",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      });
    });
    transaction();
  }

  revokedClientReplacementTarget(
    kind: "codex" | "claude" | "claude-desktop",
    installIdentity: string,
  ): OwnerClientRotationTarget {
    assertClientKind(kind);
    assertBounded("install identity", installIdentity, 128);
    const matches = this.#database.query<{
      id: string;
      status: string;
    }, [string, string, string]>(`
      select id, status from broker_clients
      where vault_id = ? and kind = ? and install_identity = ?
      order by paired_at desc, id desc limit 2
    `).all(this.#vaultId, kind, installIdentity);
    if (matches.length !== 1 || matches[0]!.status !== "revoked") {
      throw new Error("Revoked MCP client identity is unavailable or ambiguous");
    }
    const clientId = matches[0]!.id;
    const client = this.#client(clientId);
    const grants = this.#database.query<{
      capabilities: string;
      status: string;
    }, [string]>(`
      select capabilities, status from broker_grants
      where client_id = ? order by rowid desc
    `).all(clientId);
    const sessions = this.#database.query<{ status: string }, [string]>(`
      select status from broker_sessions where client_id = ?
    `).all(clientId);
    if (
      grants.length === 0 ||
      grants.some((grant) => grant.status !== "revoked") ||
      sessions.some((session) => session.status !== "revoked")
    ) {
      throw new Error("Revoked MCP client identity retains unsafe authority");
    }
    return {
      clientId,
      kind,
      displayLabel: brokerClientDisplayLabel(kind),
      installIdentity,
      authorityRevision: client.authority_revision,
      scopes: normalizeCapabilities(parseCapabilities(grants[0]!.capabilities)),
    };
  }

  prepareRevokedClientReplacement(
    target: OwnerClientRotationTarget,
    replacementInstallIdentity: string,
  ): void {
    assertBounded("replacement install identity", replacementInstallIdentity, 128);
    if (replacementInstallIdentity === target.installIdentity) {
      throw new Error("Replacement MCP client identity must be new");
    }
    if (target.clientId === null) {
      throw new Error("Revoked MCP client replacement target is invalid");
    }
    const transaction = this.#database.transaction(() => {
      const current = this.revokedClientReplacementTarget(
        target.kind,
        target.installIdentity,
      );
      if (canonicalBrokerTranscript(current) !== canonicalBrokerTranscript(target)) {
        throw new Error("Revoked MCP client replacement target changed before approval");
      }
      const now = new Date(this.#now()).toISOString();
      this.#setConnectorReconnect(
        target.kind,
        "prepared",
        replacementInstallIdentity,
        now,
      );
      this.#appendAudit({
        eventId: randomUUID(),
        occurredAt: now,
        clientId: target.clientId!,
        grantId: null,
        sessionId: null,
        operation: "client.replace_identity",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      });
    });
    transaction();
  }

  #revokedClientRotationTarget(clientId: string): OwnerRevocationTarget {
    const client = this.#client(clientId);
    if (client.vault_id !== this.#vaultId || client.status !== "revoked") {
      throw new Error("MCP client identity is not available for rotation retry");
    }
    const terminalRevocation = this.#database.query<{
      operation: string;
      outcome: string;
    }, [string]>(`
      select operation, outcome from broker_audit_events
      where client_id = ? and operation in ('client.rotate_identity', 'client.revoke')
      order by rowid desc limit 1
    `).get(clientId);
    if (
      terminalRevocation?.operation !== "client.rotate_identity" ||
      terminalRevocation.outcome !== "success"
    ) {
      throw new Error("MCP client identity was not revoked for rotation");
    }
    const grants = this.#database.query<{
      capabilities: string;
      status: string;
    }, [string]>(`
      select capabilities, status from broker_grants
      where client_id = ? order by rowid desc
    `).all(clientId);
    const sessions = this.#database.query<{ status: string }, [string]>(`
      select status from broker_sessions where client_id = ?
    `).all(clientId);
    if (
      grants.length === 0 ||
      grants.some((grant) => grant.status !== "revoked") ||
      sessions.some((session) => session.status !== "revoked")
    ) {
      throw new Error("MCP client identity retains unsafe authority after rotation");
    }
    return {
      clientId,
      kind: client.kind,
      displayLabel: brokerClientDisplayLabel(client.kind),
      authorityRevision: client.authority_revision,
      scopes: normalizeCapabilities(parseCapabilities(grants[0]!.capabilities)),
    };
  }

  revokeClient(target: OwnerRevocationTarget | string): void {
    const expected = typeof target === "string" ? this.revocationTarget(target) : target;
    assertIdentifier("client ID", expected.clientId);
    const current = this.revocationTarget(expected.clientId);
    if (
      current.kind !== expected.kind ||
      current.displayLabel !== expected.displayLabel ||
      current.authorityRevision !== expected.authorityRevision ||
      canonicalBrokerTranscript(current.scopes) !== canonicalBrokerTranscript(expected.scopes)
    ) {
      throw new Error("Revocation target changed before approval");
    }
    this.#revokeClientWithAudit(expected, "client.revoke");
  }

  revokeConnector(expected: OwnerConnectorRevocationTarget): string[] {
    const transaction = this.#database.transaction(() => {
      const current = this.connectorRevocationTarget(expected.kind);
      if (canonicalBrokerTranscript(current) !== canonicalBrokerTranscript(expected)) {
        throw new Error("Connector revocation target changed before commit");
      }
      const now = new Date(this.#now()).toISOString();
      if (isMcpClientKind(expected.kind)) {
        this.#setConnectorReconnect(expected.kind, "required", null, now);
      }
      for (const client of expected.clients) {
        const changed = this.#database.query(
          `update broker_clients
           set status = 'revoked', revoked_at = ?, authority_revision = authority_revision + 1
           where id = ? and status = 'paired' and authority_revision = ?`,
        ).run(now, client.clientId, client.authorityRevision).changes;
        if (changed !== 1) {
          throw new Error("Connector revocation target changed before commit");
        }
        this.#database.query(
          "update broker_grants set status = 'revoked', revoked_at = ? where client_id = ?",
        ).run(now, client.clientId);
        this.#database.query(
          "update broker_sessions set status = 'revoked' where client_id = ?",
        ).run(client.clientId);
        this.#appendAudit({
          eventId: randomUUID(),
          occurredAt: now,
          clientId: client.clientId,
          grantId: null,
          sessionId: null,
          operation: "client.revoke",
          outcome: "success",
          errorCode: null,
          noteRefs: [],
        });
      }
      return expected.clients.map((client) => client.clientId);
    });
    return transaction();
  }

  #revokeClientWithAudit(
    expected: OwnerRevocationTarget,
    operation: "client.revoke" | "client.rotate_identity",
    replacementInstallIdentity?: string,
  ): void {
    const client = this.#client(expected.clientId);
    if (client.vault_id !== this.#vaultId) throw new Error("Client belongs to another vault");
    const now = new Date(this.#now()).toISOString();
    const transaction = this.#database.transaction(() => {
      if (isMcpClientKind(expected.kind)) {
        if (operation === "client.rotate_identity") {
          if (!replacementInstallIdentity) {
            throw new Error("Replacement MCP client identity is required");
          }
          this.#setConnectorReconnect(
            expected.kind,
            "prepared",
            replacementInstallIdentity,
            now,
          );
        } else {
          this.#setConnectorReconnect(expected.kind, "required", null, now);
        }
      }
      const clientChanged = this.#database.query(
        `update broker_clients
         set status = 'revoked', revoked_at = ?, authority_revision = authority_revision + 1
         where id = ? and status = 'paired' and authority_revision = ?`,
      ).run(now, expected.clientId, expected.authorityRevision).changes;
      if (clientChanged !== 1) throw new Error("Revocation target changed before commit");
      this.#database.query(
        "update broker_grants set status = 'revoked', revoked_at = ? where client_id = ?",
      ).run(now, expected.clientId);
      this.#database.query(
        "update broker_sessions set status = 'revoked' where client_id = ?",
      ).run(expected.clientId);
      this.#appendAudit({
        eventId: randomUUID(),
        occurredAt: now,
        clientId: expected.clientId,
        grantId: null,
        sessionId: null,
        operation,
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      });
    });
    transaction();
  }

  #assertConnectorPairingAllowed(
    kind: BrokerClientKind,
    installIdentity: string,
  ): void {
    if (!isMcpClientKind(kind)) return;
    const reconnect = this.#database.query<ConnectorReconnectRow, [string, string]>(`
      select status, replacement_install_identity
      from broker_connector_reconnects
      where vault_id = ? and kind = ?
    `).get(this.#vaultId, kind);
    if (!reconnect) return;
    if (
      reconnect.status !== "prepared" ||
      reconnect.replacement_install_identity !== installIdentity
    ) {
      throw new Error(
        `${brokerClientDisplayLabel(kind)} requires explicit reconnect preparation`,
      );
    }
  }

  #consumeConnectorReconnect(
    kind: BrokerClientKind,
    installIdentity: string,
  ): void {
    if (!isMcpClientKind(kind)) return;
    const reconnect = this.#database.query<ConnectorReconnectRow, [string, string]>(`
      select status, replacement_install_identity
      from broker_connector_reconnects
      where vault_id = ? and kind = ?
    `).get(this.#vaultId, kind);
    if (!reconnect) return;
    if (
      reconnect.status !== "prepared" ||
      reconnect.replacement_install_identity !== installIdentity
    ) {
      throw new Error(
        `${brokerClientDisplayLabel(kind)} requires explicit reconnect preparation`,
      );
    }
    const changed = this.#database.query(`
      delete from broker_connector_reconnects
      where vault_id = ? and kind = ? and status = 'prepared'
        and replacement_install_identity = ?
    `).run(this.#vaultId, kind, installIdentity).changes;
    if (changed !== 1) {
      throw new Error("Connector reconnect preparation changed before pairing");
    }
  }

  #setConnectorReconnect(
    kind: "codex" | "claude" | "claude-desktop",
    status: "required" | "prepared",
    replacementInstallIdentity: string | null,
    now: string,
  ): void {
    this.#database.query(`
      insert into broker_connector_reconnects (
        vault_id, kind, status, replacement_install_identity, updated_at
      ) values (?, ?, ?, ?, ?)
      on conflict(vault_id, kind) do update set
        status = excluded.status,
        replacement_install_identity = excluded.replacement_install_identity,
        updated_at = excluded.updated_at
    `).run(this.#vaultId, kind, status, replacementInstallIdentity, now);
  }

  disconnectTransport(connectionId: string, peerPid: number): number {
    assertTransportBinding({ connectionId, peerPid });
    const sessions = this.#database.query<{
      id: string;
      client_id: string;
      grant_id: string;
    }, [string, number]>(`
      select id, client_id, grant_id from broker_sessions
      where transport_connection_id = ? and transport_peer_pid = ? and status = 'active'
    `).all(connectionId, peerPid);
    const now = new Date(this.#now()).toISOString();
    return this.#database.transaction(() => {
      for (const session of sessions) {
        this.#database.query(
          "update broker_sessions set status = 'disconnected' where id = ? and status = 'active'",
        ).run(session.id);
        this.#appendAudit({
          eventId: randomUUID(),
          occurredAt: now,
          clientId: session.client_id,
          grantId: session.grant_id,
          sessionId: session.id,
          operation: "session.disconnect",
          outcome: "success",
          errorCode: null,
          noteRefs: [],
        });
      }
      return sessions.length;
    })();
  }

  invalidateEphemeralAuthorityForLock(): void {
    this.#assertOpen();
    this.#trustedMcpWorkSession = undefined;
    const now = new Date(this.#now()).toISOString();
    this.#database.query(
      "update broker_sessions set status = 'disconnected', nonce = '' where status in ('pending', 'active')",
    ).run();
    this.#database.query(
      "update broker_pairing_requests set status = 'expired', nonce = '' where status in ('pending', 'approved')",
    ).run();
    this.#database.query(
      "update broker_forget_decisions set status = 'expired' where status in ('pending', 'approved')",
    ).run();
    this.#appendAudit({
      eventId: randomUUID(),
      occurredAt: now,
      clientId: "owner",
      grantId: null,
      sessionId: null,
      operation: "lifecycle.authority_invalidate",
      outcome: "success",
      errorCode: null,
      noteRefs: [],
    });
  }

  readAuditForTest(): Array<{
    eventId: string;
    occurredAt: string;
    clientId: string;
    grantId: string | null;
    sessionId: string | null;
    operation: string;
    outcome: AuditOutcome;
    errorCode: string | null;
    noteRefs: Array<{ noteId: string; revision: number }>;
  }> {
    return this.#database.query<{
      event_id: string;
      occurred_at: string;
      client_id: string;
      grant_id: string | null;
      session_id: string | null;
      operation: string;
      outcome: AuditOutcome;
      error_code: string | null;
      note_refs: string;
    }>("select * from broker_audit_events order by rowid").all().map((row) => ({
      eventId: row.event_id,
      occurredAt: row.occurred_at,
      clientId: row.client_id,
      grantId: row.grant_id,
      sessionId: row.session_id,
      operation: row.operation,
      outcome: row.outcome,
      errorCode: row.error_code,
      noteRefs: JSON.parse(row.note_refs) as Array<{ noteId: string; revision: number }>,
    }));
  }

  requestAuditPrune(): {
    decisionId: string;
    ownerDecisionTranscript: string;
    expiresAt: string;
  } {
    const decisionId = randomUUID();
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.#now() + DECISION_TTL_MS).toISOString();
    const transcript = canonicalBrokerTranscript({
      action: "owner-prune-audit",
      protocolVersion: PROTOCOL_VERSION,
      decisionId,
      vaultId: this.#vaultId,
      brokerBootId: this.#bootId,
      retentionDays: 90,
      retainedEventFloor: AUDIT_FLOOR,
      nonce,
      expiresAt,
    });
    this.#database.query(`
      insert into broker_owner_decisions (
        id, kind, vault_id, broker_boot_id, transcript, status, expires_at
      ) values (?, 'audit_prune', ?, ?, ?, 'pending', ?)
    `).run(decisionId, this.#vaultId, this.#bootId, transcript, expiresAt);
    return { decisionId, ownerDecisionTranscript: transcript, expiresAt };
  }

  approveAndPruneAudit(decisionId: string, ownerSignature: string): number {
    const decision = this.#database.query<{
      transcript: string;
      status: string;
      expires_at: string;
      vault_id: string;
      broker_boot_id: string;
    }, [string]>(`
      select transcript, status, expires_at, vault_id, broker_boot_id
      from broker_owner_decisions
      where id = ? and kind = 'audit_prune'
    `).get(decisionId);
    if (!decision || decision.status !== "pending") {
      throw new Error("Audit-prune decision is no longer available");
    }
    if (
      decision.vault_id !== this.#vaultId ||
      decision.broker_boot_id !== this.#bootId
    ) {
      throw new Error("Audit-prune decision belongs to another broker boot or vault");
    }
    if (Date.parse(decision.expires_at) <= this.#now()) {
      this.#database.query(
        "update broker_owner_decisions set status = 'expired' where id = ?",
      ).run(decisionId);
      throw new Error("Audit-prune decision is expired");
    }
    verifyTranscript(decision.transcript, ownerSignature, this.#ownerPublicKey, "owner");
    const transaction = this.#database.transaction(() => {
      const deleted = this.#database.query(`
        delete from broker_audit_events
        where occurred_at < ? and event_id not in (
          select event_id from broker_audit_events
          order by occurred_at desc, event_id desc limit ?
        )
      `).run(new Date(this.#now() - AUDIT_RETENTION_MS).toISOString(), AUDIT_FLOOR).changes;
      this.#database.query(
        "update broker_owner_decisions set status = 'consumed' where id = ? and status = 'pending'",
      ).run(decisionId);
      this.#appendAudit({
        eventId: randomUUID(),
        occurredAt: new Date(this.#now()).toISOString(),
        clientId: "owner",
        grantId: null,
        sessionId: null,
        operation: "audit.prune",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      });
      return deleted;
    });
    return transaction();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#trustedMcpWorkSession = undefined;
    clearInterval(this.#expiryTimer);
    if (this.#ownsDatabase) this.#database.close();
  }

  #ensureTransportBindingColumns(): void {
    const columns = new Set(
      this.#database.query<{ name: string }>("pragma table_info(broker_sessions)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("transport_connection_id")) {
      this.#database.exec(
        "alter table broker_sessions add column transport_connection_id text",
      );
    }
    if (!columns.has("transport_peer_pid")) {
      this.#database.exec(
        "alter table broker_sessions add column transport_peer_pid integer",
      );
    }
    if (!columns.has("work_session_id")) {
      this.#database.exec(
        "alter table broker_sessions add column work_session_id text",
      );
    }
  }

  #startTrustedMcpWorkSession(): TrustedMcpWorkSession {
    const now = this.#now();
    const ttlMs = this.routineAuthenticationTtlMilliseconds();
    const workSession = {
      id: randomUUID(),
      startedAt: now,
      expiresAt: now + ttlMs,
      lastActivityAt: now,
      lastObservedAt: now,
    };
    this.#trustedMcpWorkSession = workSession;
    return workSession;
  }

  #liveTrustedMcpWorkSession(): TrustedMcpWorkSession | undefined {
    const workSession = this.#trustedMcpWorkSession;
    if (!workSession) return undefined;
    const now = this.#now();
    const idleMs = this.routineAuthenticationTtlMilliseconds();
    const clockMovedBackward = now < workSession.lastObservedAt;
    workSession.lastObservedAt = Math.max(workSession.lastObservedAt, now);
    if (
      clockMovedBackward ||
      now >= workSession.expiresAt ||
      now - workSession.lastActivityAt >= idleMs
    ) {
      this.#expireTrustedMcpWorkSession(
        clockMovedBackward
          ? "work_session_clock_rollback"
          : now >= workSession.expiresAt
          ? "work_session_expired"
          : "work_session_idle",
      );
      return undefined;
    }
    return workSession;
  }

  #touchTrustedMcpWorkSession(
    workSession: TrustedMcpWorkSession,
    now: number,
  ): void {
    if (this.#trustedMcpWorkSession?.id !== workSession.id) {
      throw new Error("Trusted work session is expired");
    }
    workSession.lastActivityAt = now;
    workSession.lastObservedAt = Math.max(workSession.lastObservedAt, now);
  }

  #expireTrustedMcpWorkSession(errorCode: string): void {
    const workSession = this.#trustedMcpWorkSession;
    if (!workSession) return;
    this.#trustedMcpWorkSession = undefined;
    const sessions = this.#database.query<{
      id: string;
      client_id: string;
      grant_id: string;
    }, [string]>(`
      select id, client_id, grant_id from broker_sessions
      where work_session_id = ? and status = 'active'
    `).all(workSession.id);
    const now = new Date(this.#now()).toISOString();
    this.#database.transaction(() => {
      for (const session of sessions) {
        this.#database.query(
          "update broker_sessions set status = 'expired' where id = ? and status = 'active'",
        ).run(session.id);
        this.#appendAudit({
          eventId: randomUUID(),
          occurredAt: now,
          clientId: session.client_id,
          grantId: session.grant_id,
          sessionId: session.id,
          operation: "session.expire",
          outcome: "success",
          errorCode,
          noteRefs: [],
        });
      }
    })();
  }

  #ensureOwnerControlColumns(): void {
    const columns = new Set(
      this.#database.query<{ name: string }>("pragma table_info(broker_clients)")
        .all()
        .map((column) => column.name),
    );
    if (!columns.has("authority_revision")) {
      this.#database.exec(
        "alter table broker_clients add column authority_revision integer not null default 1",
      );
    }
  }

  #encodeAuditCursor(value: {
    snapshotRowId: number;
    beforeRowId: number;
    expiresAt: number;
  }): string {
    const payload = Buffer.from(canonicalBrokerTranscript({
      version: 1,
      vaultId: this.#vaultId,
      brokerBootId: this.#bootId,
      snapshotRowId: value.snapshotRowId,
      beforeRowId: value.beforeRowId,
      expiresAt: value.expiresAt,
    })).toString("base64url");
    const signature = createHmac("sha256", this.#auditCursorKey)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  #decodeAuditCursor(cursor: string): {
    snapshotRowId: number;
    beforeRowId: number;
    expiresAt: number;
  } {
    assertBounded("audit cursor", cursor, 2_048);
    const [payload, suppliedSignature, extra] = cursor.split(".");
    if (!payload || !suppliedSignature || extra !== undefined) {
      throw new Error("Audit cursor is malformed");
    }
    const expectedSignature = createHmac("sha256", this.#auditCursorKey)
      .update(payload)
      .digest();
    let signature: Buffer;
    try {
      signature = Buffer.from(suppliedSignature, "base64url");
    } catch {
      throw new Error("Audit cursor is malformed");
    }
    if (
      signature.toString("base64url") !== suppliedSignature ||
      signature.length !== expectedSignature.length ||
      !timingSafeEqual(signature, expectedSignature)
    ) {
      throw new Error("Audit cursor signature is invalid");
    }
    let decoded: unknown;
    try {
      const payloadBytes = Buffer.from(payload, "base64url");
      if (payloadBytes.toString("base64url") !== payload) {
        throw new Error("non-canonical payload");
      }
      decoded = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      throw new Error("Audit cursor payload is invalid");
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Audit cursor payload is invalid");
    }
    const record = decoded as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\n") !==
        ["beforeRowId", "brokerBootId", "expiresAt", "snapshotRowId", "vaultId", "version"]
          .sort().join("\n") ||
      record.version !== 1 ||
      record.vaultId !== this.#vaultId ||
      record.brokerBootId !== this.#bootId ||
      !Number.isSafeInteger(record.snapshotRowId) ||
      !Number.isSafeInteger(record.beforeRowId) ||
      !Number.isSafeInteger(record.expiresAt) ||
      (record.snapshotRowId as number) < 0 ||
      (record.beforeRowId as number) < 1
    ) {
      throw new Error("Audit cursor context is invalid");
    }
    if ((record.expiresAt as number) <= this.#now()) {
      throw new Error("Audit cursor is stale");
    }
    return {
      snapshotRowId: record.snapshotRowId as number,
      beforeRowId: record.beforeRowId as number,
      expiresAt: record.expiresAt as number,
    };
  }

  #invalidatePriorBootSessions(): void {
    const sessions = this.#database.query<{
      id: string;
      client_id: string;
      grant_id: string;
    }, [string]>(`
      select id, client_id, grant_id from broker_sessions
      where status = 'active' and broker_boot_id <> ?
    `).all(this.#bootId);
    if (sessions.length === 0) return;
    const now = new Date(this.#now()).toISOString();
    this.#database.transaction(() => {
      for (const session of sessions) {
        this.#database.query(
          "update broker_sessions set status = 'disconnected' where id = ? and status = 'active'",
        ).run(session.id);
        this.#appendAudit({
          eventId: randomUUID(),
          occurredAt: now,
          clientId: session.client_id,
          grantId: session.grant_id,
          sessionId: session.id,
          operation: "session.restart_invalidate",
          outcome: "success",
          errorCode: null,
          noteRefs: [],
        });
      }
    })();
  }

  #expireSession(session: SessionRow, errorCode: string): void {
    const changed = this.#database.query(
      "update broker_sessions set status = 'expired' where id = ? and status = 'active'",
    ).run(session.id).changes;
    if (changed !== 1) return;
    this.#appendAudit({
      eventId: randomUUID(),
      occurredAt: new Date(this.#now()).toISOString(),
      clientId: session.client_id,
      grantId: session.grant_id,
      sessionId: session.id,
      operation: "session.expire",
      outcome: "success",
      errorCode,
      noteRefs: [],
    });
  }

  #pairing(id: string): PairingRow {
    const row = this.#database.query<PairingRow, [string]>(
      "select * from broker_pairing_requests where id = ?",
    ).get(id);
    if (!row) throw new Error("Pairing request was not found");
    return row;
  }

  #activePairing(id: string, status: PairingRow["status"]): PairingRow {
    const row = this.#pairing(id);
    if (row.vault_id !== this.#vaultId || row.boot_id !== this.#bootId) {
      throw new Error("Pairing request is not active for this broker boot and vault");
    }
    if (Date.parse(row.expires_at) <= this.#now()) {
      this.#database.query(
        "update broker_pairing_requests set status = 'expired', nonce = '' where id = ?",
      ).run(id);
      throw new Error("Pairing request is expired");
    }
    if (row.status !== status) throw new Error("Pairing request is no longer available");
    return row;
  }

  #activation(id: string): ActivationRow {
    const row = this.#database.query<ActivationRow, [string]>(
      "select * from broker_sessions where id = ?",
    ).get(id);
    if (!row) throw new Error("Activation request was not found");
    return row;
  }

  #activeActivation(id: string): ActivationRow {
    const row = this.#activation(id);
    if (
      row.vault_id !== this.#vaultId ||
      row.broker_boot_id !== this.#bootId ||
      row.status !== "pending"
    ) {
      throw new Error("Activation request is no longer available");
    }
    if (Date.parse(row.decision_expires_at) <= this.#now()) {
      this.#database.query(
        "update broker_sessions set status = 'expired', nonce = '' where id = ?",
      ).run(id);
      throw new Error("Activation request is expired");
    }
    return row;
  }

  #client(id: string): ClientRow {
    const row = this.#database.query<ClientRow, [string]>(
      "select * from broker_clients where id = ?",
    ).get(id);
    if (!row) throw new Error("Client was not found");
    return row;
  }

  #knownClient(id: unknown): boolean {
    return typeof id === "string" && Boolean(this.#database.query<{ id: string }, [string]>(
      "select id from broker_clients where id = ?",
    ).get(id));
  }

  #grant(id: string): GrantRow {
    const row = this.#database.query<GrantRow, [string]>(
      "select id, client_id, capabilities, forget_policy, status, expires_at from broker_grants where id = ?",
    ).get(id);
    if (!row) throw new Error("Grant was not found");
    return row;
  }

  #session(id: string): SessionRow {
    const row = this.#database.query<SessionRow, [string]>(
      "select * from broker_sessions where id = ?",
    ).get(id);
    if (!row) throw new Error("Session was not found");
    return row;
  }

  #forgetDecision(id: string): ForgetDecisionRow {
    const row = this.#database.query<ForgetDecisionRow, [string]>(
      "select * from broker_forget_decisions where id = ?",
    ).get(id);
    if (!row) throw new Error("Forget decision was not found");
    return row;
  }

  #activeForgetDecision(
    id: string,
    status: ForgetDecisionRow["status"],
  ): ForgetDecisionRow {
    const row = this.#forgetDecision(id);
    if (row.status === "expired") throw new Error("Forget decision is expired");
    if (row.status !== status) throw new Error("Forget decision is no longer available");
    if (Date.parse(row.expires_at) <= this.#now()) {
      this.expireForgetDecisions();
      throw new Error("Forget decision is expired");
    }
    return row;
  }

  #appendAudit(event: {
    eventId: string;
    occurredAt: string;
    clientId: string;
    grantId: string | null;
    sessionId: string | null;
    operation: string;
    outcome: AuditOutcome;
    errorCode: string | null;
    noteRefs: Array<{ noteId: string; revision: number }>;
  }): void {
    this.#database.query(`
      insert into broker_audit_events (
        event_id, occurred_at, client_id, grant_id, session_id, operation,
        outcome, error_code, note_refs
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.occurredAt,
      event.clientId,
      event.grantId,
      event.sessionId,
      event.operation,
      event.outcome,
      event.errorCode,
      JSON.stringify(event.noteRefs),
    );
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Vault broker is closed");
    if (this.#maintenanceError) {
      throw new Error("Vault broker maintenance failed", {
        cause: this.#maintenanceError,
      });
    }
  }
}

function unsignedEnvelope(envelope: BrokerRequestEnvelope): UnsignedBrokerRequestEnvelope {
  return {
    protocolVersion: envelope.protocolVersion,
    brokerBootId: envelope.brokerBootId,
    vaultId: envelope.vaultId,
    clientId: envelope.clientId,
    grantId: envelope.grantId,
    sessionId: envelope.sessionId,
    requestId: envelope.requestId,
    issuedAt: envelope.issuedAt,
    operation: envelope.operation,
    bodySha256: envelope.bodySha256,
  };
}

function pairingOwnerTranscript(row: PairingRow): string {
  return canonicalBrokerTranscript({
    action: "owner-approve-pairing",
    protocolVersion: PROTOCOL_VERSION,
    requestId: row.id,
    vaultId: row.vault_id,
    brokerBootId: row.boot_id,
    kind: row.kind,
    displayName: row.display_name,
    installIdentity: row.install_identity,
    publicKeySha256: createHash("sha256").update(row.public_key).digest("hex"),
    signingMode: row.code_requirement,
    requestedCapabilities: parseCapabilities(row.requested_capabilities),
    forgetPolicy: row.forget_policy,
    nonce: row.nonce,
    expiresAt: row.expires_at,
  });
}

function pairingClientTranscript(row: PairingRow): string {
  return canonicalBrokerTranscript({
    action: "installed-client-pairing-proof",
    protocolVersion: PROTOCOL_VERSION,
    requestId: row.id,
    vaultId: row.vault_id,
    brokerBootId: row.boot_id,
    requestedCapabilities: parseCapabilities(row.requested_capabilities),
    forgetPolicy: row.forget_policy,
    publicKeySha256: createHash("sha256").update(row.public_key).digest("hex"),
    nonce: row.nonce,
    expiresAt: row.expires_at,
  });
}

function activationTranscript(action: string, row: ActivationRow): string {
  return canonicalBrokerTranscript({
    action,
    protocolVersion: PROTOCOL_VERSION,
    activationId: row.id,
    vaultId: row.vault_id,
    brokerBootId: row.broker_boot_id,
    clientId: row.client_id,
    grantId: row.grant_id,
    sessionPublicKeySha256: createHash("sha256").update(row.session_public_key).digest("hex"),
    capabilities: parseCapabilities(row.capabilities),
    forgetPolicy: row.forget_policy,
    nonce: row.nonce,
    decisionExpiresAt: row.decision_expires_at,
    expiresAt: row.expires_at,
    transportConnectionId: row.transport_connection_id,
    transportPeerPid: row.transport_peer_pid,
    workSessionId: row.work_session_id,
  });
}

function forgetDecisionTranscript(
  row: ForgetDecisionRow,
  vaultId: string,
  bootId: string,
): string {
  return canonicalBrokerTranscript({
    action: "owner-approve-forget",
    protocolVersion: PROTOCOL_VERSION,
    decisionId: row.id,
    eventId: row.event_id,
    vaultId,
    brokerBootId: bootId,
    clientId: row.client_id,
    grantId: row.grant_id,
    sessionId: row.session_id,
    noteId: row.note_id,
    noteRevision: row.note_revision,
    nonce: row.nonce,
    expiresAt: row.expires_at,
  });
}

function verifyTranscript(
  transcript: string,
  encodedSignature: string,
  publicKey: string,
  actor: string,
): void {
  let signature: Buffer;
  try {
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new Error(`${actor} signature is invalid`);
  }
  if (!verify("sha256", Buffer.from(transcript), publicKey, signature)) {
    throw new Error(`${actor} signature is invalid`);
  }
}

function assertLiveClientGrant(
  client: ClientRow,
  grant: GrantRow,
  vaultId: string,
  now: number,
): void {
  if (client.vault_id !== vaultId) throw new Error("Client belongs to another vault");
  if (client.status !== "paired") throw new Error("Client is revoked");
  if (grant.client_id !== client.id) throw new Error("Grant belongs to another client");
  if (grant.status !== "active") throw new Error("Grant is revoked");
  if (grant.expires_at && Date.parse(grant.expires_at) <= now) throw new Error("Grant is expired");
}

function normalizeCapabilities(value: readonly BrokerCapability[]): BrokerCapability[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Capabilities must be nonempty");
  const unique = [...new Set(value)];
  if (unique.some((capability) => !BROKER_CAPABILITIES.includes(capability))) {
    throw new Error("Capability is unsupported");
  }
  return BROKER_CAPABILITIES.filter((capability) => unique.includes(capability));
}

function parseCapabilities(value: string): BrokerCapability[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Stored capabilities are invalid");
  return normalizeCapabilities(parsed as BrokerCapability[]);
}

function brokerClientDisplayLabel(kind: BrokerClientKind): string {
  switch (kind) {
    case "codex":
      return "Codex";
    case "claude":
      return "Claude Code";
    case "claude-desktop":
      return "Claude Desktop";
    case "local_ui":
      return "Afternote Local";
  }
}

function isMcpClientKind(
  kind: BrokerClientKind,
): kind is "codex" | "claude" | "claude-desktop" {
  return kind === "codex" || kind === "claude" || kind === "claude-desktop";
}

function parseAuditNoteRefs(value: string): Array<{ noteId: string; revision: number }> {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length > MAX_NOTE_REFS) {
    throw new Error("Stored audit note references are invalid");
  }
  return parsed.map((reference) => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      throw new Error("Stored audit note reference is invalid");
    }
    const record = reference as Record<string, unknown>;
    if (
      Object.keys(record).sort().join("\n") !== "noteId\nrevision" ||
      typeof record.noteId !== "string" ||
      !Number.isInteger(record.revision)
    ) {
      throw new Error("Stored audit note reference is invalid");
    }
    assertIdentifier("note ID", record.noteId);
    if ((record.revision as number) <= 0) {
      throw new Error("Stored audit note revision is invalid");
    }
    return { noteId: record.noteId, revision: record.revision as number };
  });
}

function operationCapability(operation: string): BrokerCapability {
  switch (operation) {
    case "memory.remember": return "memory.remember";
    case "memory.recall": return "memory.recall";
    case "memory.get_note": return "memory.get_note";
    case "memory.forget": return "memory.forget";
    default: throw new Error("Operation is not authorized by a Memory grant");
  }
}

function isTrustedMcpClient(client: ClientRow): boolean {
  return isMcpClientKind(client.kind);
}

function assertTrustedMcpCapabilities(row: ActivationRow): void {
  const capabilities = parseCapabilities(row.capabilities);
  const allowed: readonly BrokerCapability[] = [
    "memory.remember",
    "memory.recall",
    "memory.get_note",
  ];
  if (
    row.forget_policy !== "never" ||
    capabilities.includes("memory.forget") ||
    capabilities.some((capability) => !allowed.includes(capability))
  ) {
    throw new Error("Trusted MCP activation exceeds its allowed scope");
  }
}

function forgetNoteId(body: Uint8Array): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error("Forget body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Forget body is invalid");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== "id" || typeof entries[0][1] !== "string") {
    throw new Error("Forget body must contain exactly one note ID");
  }
  return entries[0][1];
}

function validatePublicKey(value: string): void {
  assertBounded("public key", value, 4_096);
  try {
    const key = createPublicKey(value);
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Error("wrong key type");
    }
  } catch {
    throw new Error("Public key must be a P-256 signing key");
  }
}

function assertEnvelopeShape(envelope: BrokerRequestEnvelope): void {
  if (!envelope || typeof envelope !== "object") throw new Error("Request envelope is invalid");
  for (const [name, value, maximum] of [
    ["broker boot ID", envelope.brokerBootId, 128],
    ["vault ID", envelope.vaultId, 128],
    ["client ID", envelope.clientId, 128],
    ["grant ID", envelope.grantId, 128],
    ["session ID", envelope.sessionId, 128],
    ["request ID", envelope.requestId, 128],
    ["issued at", envelope.issuedAt, 64],
    ["operation", envelope.operation, 128],
    ["body SHA-256", envelope.bodySha256, 64],
    ["signature", envelope.signature, 512],
  ] as const) assertBounded(name, value, maximum);
}

function assertClientKind(value: string): asserts value is BrokerClientKind {
  if (!( ["codex", "claude", "claude-desktop", "local_ui"] as string[]).includes(value)) {
    throw new Error("Client kind is invalid");
  }
}

function assertForgetPolicy(value: string): asserts value is ForgetPolicy {
  if (!( ["never", "confirm_each", "session"] as string[]).includes(value)) {
    throw new Error("Forget policy is invalid");
  }
}

function assertBounded(name: string, value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${name} is invalid`);
  }
}

function assertIdentifier(name: string, value: string): void {
  assertBounded(name, value, 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) throw new Error(`${name} is invalid`);
}

function assertTransportBinding(value: BrokerTransportBinding): void {
  assertIdentifier("transport connection ID", value.connectionId);
  if (!Number.isSafeInteger(value.peerPid) || value.peerPid <= 0) {
    throw new Error("Transport peer PID is invalid");
  }
}

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function safeOperation(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : "invalid";
}

function safeErrorCode(value: string): string {
  return /^[a-z0-9_.:-]{1,64}$/.test(value) ? value : "error";
}

const BROKER_SCHEMA = `
  create table if not exists broker_preferences (
    key text primary key,
    ttl_ms integer not null
  );
  create table if not exists broker_pairing_requests (
    id text primary key,
    vault_id text not null,
    boot_id text not null,
    kind text not null,
    display_name text not null,
    install_identity text not null,
    public_key text not null,
    code_requirement text not null,
    requested_capabilities text not null,
    forget_policy text not null,
    nonce text not null,
    status text not null,
    created_at text not null,
    expires_at text not null
  );
  create table if not exists broker_clients (
    id text primary key,
    vault_id text not null,
    kind text not null,
    display_name text not null,
    install_identity text not null,
    public_key text not null,
    code_requirement text not null,
    status text not null,
    paired_at text not null,
    revoked_at text,
    authority_revision integer not null default 1,
    unique(vault_id, public_key)
  );
  create table if not exists broker_connector_reconnects (
    vault_id text not null,
    kind text not null,
    status text not null,
    replacement_install_identity text,
    updated_at text not null,
    primary key(vault_id, kind)
  );
  create table if not exists broker_grants (
    id text primary key,
    client_id text not null references broker_clients(id),
    capabilities text not null,
    forget_policy text not null,
    status text not null,
    created_at text not null,
    expires_at text,
    revoked_at text
  );
  create table if not exists broker_sessions (
    id text primary key,
    vault_id text not null,
    broker_boot_id text not null,
    client_id text not null references broker_clients(id),
    grant_id text not null references broker_grants(id),
    session_public_key text not null,
    capabilities text not null,
    forget_policy text not null,
    nonce text not null,
    status text not null,
    activated_at text,
    decision_expires_at text not null,
    expires_at text not null,
    last_seen_at text,
    transport_connection_id text,
    transport_peer_pid integer,
    work_session_id text
  );
  create table if not exists broker_request_replays (
    request_id text primary key,
    session_id text not null references broker_sessions(id),
    consumed_at text not null
  );
  create index if not exists broker_request_replays_consumed_at
  on broker_request_replays(consumed_at);
  create table if not exists broker_forget_decisions (
    id text primary key,
    event_id text not null,
    client_id text not null references broker_clients(id),
    grant_id text not null references broker_grants(id),
    session_id text not null references broker_sessions(id),
    note_id text not null,
    note_revision integer not null,
    nonce text not null,
    status text not null,
    expires_at text not null
  );
  create table if not exists broker_owner_decisions (
    id text primary key,
    kind text not null,
    vault_id text not null,
    broker_boot_id text not null,
    transcript text not null,
    status text not null,
    expires_at text not null
  );
  create table if not exists broker_audit_events (
    event_id text primary key,
    occurred_at text not null,
    client_id text not null,
    grant_id text,
    session_id text,
    operation text not null,
    outcome text not null,
    error_code text,
    note_refs text not null
  );
  create index if not exists broker_audit_occurred_at
    on broker_audit_events(occurred_at, event_id);
`;
