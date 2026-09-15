import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
/* eslint-disable @typescript-eslint/no-explicit-any -- protocol fixtures decode untyped JSON */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { MemoryCapability, VaultContext } from "@afternote/memory";
import {
  canonicalBrokerTranscript,
  type BrokerRequestEnvelope,
} from "./vault-broker";
import { ExclusiveFileLock, SqlcipherDatabase } from "./sqlcipher-database";
import { VaultBrokerWorker } from "./vault-broker-worker";

const directories: string[] = [];
const workers: VaultBrokerWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("vault broker worker protocol", () => {
  it("preserves lock and replay precedence before method/role dispatch", async () => {
    const { worker } = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 39001 };
    await ownerRequest(worker, connection, "lifecycle.status", {});
    worker.closeLifecycleAdmissionForTest();
    const envelope = (method: string, peerRole = "owner-control", id = randomUUID()) => JSON.stringify({
      kind: "client", peerRole, ...connection,
      payload: { protocolVersion: 1, requestId: id, method, params: {} },
    });
    const blockedOwnerRequest = envelope("owner.unknown");
    expect(JSON.parse(await worker.handleSerialized(blockedOwnerRequest)).error.code).toBe("vault_locked");
    expect(JSON.parse(await worker.handleSerialized(blockedOwnerRequest)).error.code).toBe("replayed");
    // Wrong role and unknown route still see the existing lock-first error.
    expect(JSON.parse(await worker.handleSerialized(envelope("client.begin"))).error.code).toBe("vault_locked");
    expect(JSON.parse(await worker.handleSerialized(envelope("memory.unknown", "memory-client"))).error.code)
      .toBe("vault_locked");
    expect(JSON.parse(await worker.handleSerialized(envelope("health"))).ok).toBe(true);
    expect(JSON.parse(await worker.handleSerialized(envelope("lifecycle.unknown"))).error.code).toBe("not_found");
    expect(JSON.parse(await worker.handleSerialized(envelope("recovery.unknown"))).error.code).toBe("not_found");
    expect(JSON.parse(await worker.handleSerialized(envelope("lifecycle.status", "memory-client"))).error.code)
      .toBe("identity_mismatch");
  });

  it("preserves malformed-request correlation and health transport limits", async () => {
    const { worker } = workerFixture();
    for (const text of ["", "not JSON", "x".repeat(1_048_577)]) {
      expect(JSON.parse(await worker.handleSerialized(text))).toMatchObject({
        requestId: null, ok: false, error: { code: "invalid_request" },
      });
    }
    const requestId = randomUUID();
    const response = JSON.parse(await worker.handleSerialized(JSON.stringify({
      kind: "client", peerRole: "owner-control", connectionId: randomUUID(), peerPid: 39002,
      payload: { protocolVersion: 2, requestId, method: "health", params: {} },
    })));
    expect(response).toMatchObject({ requestId, ok: false, error: { code: "unsupported_version" } });
  });

  it("owns the retired runtime lock for the full worker lifetime", () => {
    const fixture = workerFixture();
    const lockPath = join(fixture.path.replace(/\/vault\.db$/, ""), ".vault.db.afternote.lock");
    let competingLock: ExclusiveFileLock | undefined;
    let competingError: unknown;
    try {
      competingLock = new ExclusiveFileLock(
        lockPath,
        "The broker already owns the retired runtime lock",
      );
    } catch (error) {
      competingError = error;
    } finally {
      competingLock?.release();
    }
    expect(competingError).toBeInstanceOf(Error);
    expect((competingError as Error).message).toBe(
      "The broker already owns the retired runtime lock",
    );

    fixture.worker.close();
    const afterClose = new ExclusiveFileLock(lockPath);
    afterClose.release();
  });

  it("does not expose internal owner-control errors", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-owner-error-"));
    directories.push(directory);
    const canary = join(directory, "private-sql-canary", "vault.db");
    const worker = new VaultBrokerWorker({
      applicationVersion: "test-worker",
      vaultPath: canary,
      vaultKeyProvider: () => {
        throw new Error(canary);
      },
      vault: { vaultId: "8".repeat(64), deployment: "local" },
    });
    workers.push(worker);
    const response = await rawOwnerRequest(
      worker,
      { connectionId: randomUUID(), peerPid: 39990 },
      "owner.session.begin",
      { requestedScopes: ["owner.inspect_clients"], ttlMs: 300_000 },
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "denied", message: "Broker request failed" },
    });
    expect(JSON.stringify(response)).not.toContain(canary);
    expect(JSON.stringify(response)).not.toContain("SQL");
  });

  it("does not expose internal errors to ordinary connector peers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-peer-error-"));
    directories.push(directory);
    const canary = join(directory, "private-storage-canary", "vault.db");
    const worker = new VaultBrokerWorker({
      applicationVersion: "test-worker",
      vaultPath: canary,
      vaultKeyProvider: () => {
        throw new Error(canary);
      },
      vault: { vaultId: "9".repeat(64), deployment: "local" },
    });
    workers.push(worker);
    const response = await rawRequest(
      worker,
      { connectionId: randomUUID(), peerPid: 39989 },
      "client.begin",
      {
        kind: "codex",
        displayName: "Codex",
        installIdentity: randomUUID(),
        publicKey: p256().publicKey,
        signingMode: "development-exact-build",
        requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
        forgetPolicy: "never",
      },
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "denied", message: "Broker request failed" },
    });
    expect(JSON.stringify(response)).not.toContain(canary);
  });

  it("rejects a connector label that does not match its authenticated kind", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 39990 };
    const durable = p256();
    const response = await rawRequest(fixture.worker, connection, "client.begin", {
      kind: "codex",
      displayName: "Claude Code",
      installIdentity: randomUUID(),
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: ["memory.remember", "memory.recall"],
      forgetPolicy: "never",
    });
    expect(response).toMatchObject({
      ok: false,
      error: { code: "identity_mismatch" },
    });
  });

  it("keeps owner inspection connection-bound and requires fresh presence for exact revocation", async () => {
    const fixture = workerFixture();
    const memoryConnection = { connectionId: randomUUID(), peerPid: 40001 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 40002 };
    const copiedOwnerConnection = { connectionId: randomUUID(), peerPid: 40003 };
    const durable = p256();
    const session = p256();
    const activated = await pairAndActivate(
      fixture,
      memoryConnection,
      durable,
      session,
      ["memory.remember", "memory.recall"],
    );

    const cookieShaped = await rawRequest(
      fixture.worker,
      memoryConnection,
      "owner.session.begin",
      {
        requestedScopes: [
          "owner.inspect_clients",
          "owner.inspect_grants",
          "owner.inspect_sessions",
          "owner.inspect_audit",
        ],
        ttlMs: 5 * 60 * 1_000,
      },
    );
    expect(cookieShaped.ownerPresenceChallenge).toBeUndefined();
    expect(cookieShaped.error.code).toBe("identity_mismatch");

    const ownerSession = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.session.begin",
      {
        requestedScopes: [
          "owner.inspect_clients",
          "owner.inspect_grants",
          "owner.inspect_sessions",
          "owner.inspect_audit",
        ],
        ttlMs: 5 * 60 * 1_000,
      },
      true,
    );
    expect(ownerSession).toMatchObject({
      scopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
        "owner.inspect_audit",
      ],
      expiresAt: expect.any(String),
    });
    expect(ownerSession.sessionId).toBeUndefined();
    expect(ownerSession.token).toBeUndefined();

    const snapshot = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    expect(snapshot.clients).toEqual([
      expect.objectContaining({
        clientId: activated.clientId,
        displayLabel: "Codex",
        status: "active",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("PUBLIC KEY");
    const auditPage = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_audit",
      { cursor: null, pageSize: 2 },
    );
    expect(auditPage.events.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(auditPage)).not.toContain(durable.publicKey);
    const replayRequestId = randomUUID();
    const replayEnvelope = JSON.stringify({
      kind: "client",
      peerRole: "owner-control",
      ...ownerConnection,
      payload: {
        protocolVersion: 1,
        requestId: replayRequestId,
        method: "owner.inspect_connections",
        params: {},
      },
    });
    expect(JSON.parse(await fixture.worker.handleSerialized(replayEnvelope)).ok).toBe(true);
    expect(JSON.parse(await fixture.worker.handleSerialized(replayEnvelope))).toMatchObject({
      ok: false,
      error: { code: "replayed" },
    });
    const unknownField = await rawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      { cookie: "browser-cookie-cannot-authorize" },
    );
    expect(unknownField.error.code).toBe("invalid_request");
    const copied = await rawOwnerRequest(
      fixture.worker,
      copiedOwnerConnection,
      "owner.inspect_connections",
      {},
    );
    expect(copied.error.code).toBe("owner_session_required");

    const target = snapshot.clients[0];
    const revocationFirst = JSON.parse(await fixture.worker.handleSerialized(JSON.stringify({
      kind: "client",
      peerRole: "owner-control",
      ...ownerConnection,
      payload: {
        protocolVersion: 1,
        requestId: randomUUID(),
        method: "owner.revoke_client",
        params: {
          clientId: target.clientId,
          kind: target.kind,
          displayLabel: target.displayLabel,
          authorityRevision: target.authorityRevision,
          scopes: snapshot.grants[0].scopes,
        },
      },
    })));
    expect(revocationFirst.error).toBeUndefined();
    expect(revocationFirst.ownerPresenceChallenge.reason).toContain("Revoke Codex");
    expect(revocationFirst.ownerPresenceChallenge.reason).toContain("Remember, Recall");
    const revoked = JSON.parse(await fixture.worker.handleSerialized(JSON.stringify({
      kind: "owner-presence",
      peerRole: "owner-control",
      ...ownerConnection,
      payload: {
        challengeId: revocationFirst.ownerPresenceChallenge.challengeId,
        approved: true,
        outcome: "approved",
      },
    })));
    expect(revoked).toMatchObject({
      ok: true,
      result: { revoked: true, clientId: activated.clientId },
    });

    const body = { content: "revoked clients cannot write" };
    const denied = await rawMemoryRequest(
      fixture.worker,
      memoryConnection,
      envelope(fixture, activated, "memory.remember", body, session.privateKey),
      body,
    );
    expect(denied.error.message).toContain("revoked");
    const refreshed = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    expect(refreshed.clients[0]).toMatchObject({ status: "revoked", authorityRevision: 2 });
    const alreadyRevoked = await rawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "owner.revoke_client",
      {
        clientId: target.clientId,
        kind: target.kind,
        displayLabel: target.displayLabel,
        authorityRevision: target.authorityRevision,
        scopes: target.activeScopes,
      },
    );
    expect(alreadyRevoked.ownerPresenceChallenge).toBeUndefined();
    expect(alreadyRevoked).toMatchObject({ ok: false, error: { code: "denied" } });
  });

  it("revokes every live identity hidden behind one connector row", async () => {
    const fixture = workerFixture();
    const firstConnection = { connectionId: randomUUID(), peerPid: 40021 };
    const secondConnection = { connectionId: randomUUID(), peerPid: 40022 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 40023 };
    const firstDurable = p256();
    const secondDurable = p256();
    const firstSession = p256();
    const secondSession = p256();
    const capabilities: MemoryCapability[] = ["memory.remember", "memory.recall"];
    const first = await pairAndActivate(
      fixture,
      firstConnection,
      firstDurable,
      firstSession,
      capabilities,
    );
    const second = await pairAndActivate(
      fixture,
      secondConnection,
      secondDurable,
      secondSession,
      capabilities,
    );

    await ownerRequest(fixture.worker, ownerConnection, "owner.session.begin", {
      requestedScopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
      ],
      ttlMs: 5 * 60 * 1_000,
    }, true);
    const before = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    expect(before.clients.filter((client: { kind: string }) => client.kind === "codex"))
      .toHaveLength(2);

    const revoked = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.revoke_connector",
      { kind: "codex" },
      true,
    );
    expect(new Set(revoked.clientIds)).toEqual(new Set([first.clientId, second.clientId]));

    for (const [connection, activated, session] of [
      [firstConnection, first, firstSession],
      [secondConnection, second, secondSession],
    ] as const) {
      const body = { content: "connector revocation must stop every hidden identity" };
      const denied = await rawMemoryRequest(
        fixture.worker,
        connection,
        envelope(fixture, activated, "memory.remember", body, session.privateKey),
        body,
      );
      expect(denied).toMatchObject({ ok: false, error: { code: "denied" } });
    }

    const after = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    expect(after.clients.filter((client: { kind: string }) => client.kind === "codex"))
      .toEqual([
        expect.objectContaining({ status: "revoked" }),
        expect.objectContaining({ status: "revoked" }),
      ]);
  });

  it.each(["development-only", "production-signed"] as const)("requires explicit reconnect preparation on %s before a revoked MCP connector can pair again", async (trustPath) => {
    const fixture = workerFixture({ trustPath });
    const clientConnection = { connectionId: randomUUID(), peerPid: 40031 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 40032 };
    const replacementConnection = { connectionId: randomUUID(), peerPid: 40033 };
    const durable = p256();
    const replacementDurable = p256();
    const installIdentity = randomUUID();
    const replacementInstallIdentity = randomUUID();
    const requestedCapabilities: MemoryCapability[] = [
      "memory.remember",
      "memory.recall",
      "memory.get_note",
    ];
    const pairing = await request(fixture.worker, clientConnection, "client.begin", {
      kind: "codex",
      displayName: "Codex",
      installIdentity,
      publicKey: durable.publicKey,
      signingMode: trustPath === "production-signed" ? "secure-enclave" : "development-exact-build",
      requestedCapabilities,
      forgetPolicy: "never",
    });
    const originalPaired = await request(fixture.worker, clientConnection, "client.complete_pairing", {
      requestId: pairing.requestId,
      clientSignature: signature(pairing.clientProofTranscript, durable.privateKey),
    }, true);

    const originalSession = p256();
    const originalActivation = await activateExisting(
      fixture, clientConnection, durable, originalSession, originalPaired,
    );

    await ownerRequest(fixture.worker, ownerConnection, "owner.session.begin", {
      requestedScopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
      ],
      ttlMs: 5 * 60 * 1_000,
    }, true);
    await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.revoke_connector",
      { kind: "codex" },
      true,
    );

    await expect(memoryRequest(fixture, clientConnection, originalActivation,
      "memory.remember", { content: "Revoked connection must not write" }, originalSession.privateKey))
      .rejects.toThrow();

    const blocked = await rawRequest(
      fixture.worker,
      replacementConnection,
      "client.begin",
      {
        kind: "codex",
        displayName: "Codex",
        installIdentity: replacementInstallIdentity,
        publicKey: replacementDurable.publicKey,
        signingMode: trustPath === "production-signed" ? "secure-enclave" : "development-exact-build",
        requestedCapabilities,
        forgetPolicy: "never",
      },
    );
    expect(blocked).toMatchObject({
      ok: false,
      error: {
        code: "denied",
        message: "Codex requires explicit reconnect preparation",
      },
    });

    const prepared = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_connector_reconnect",
      { kind: "codex", installIdentity, replacementInstallIdentity },
      true,
    );
    expect(prepared).toMatchObject({
      prepared: true,
      kind: "codex",
      installIdentity,
      replacementInstallIdentity,
    });
    const replacementPairing = await request(
      fixture.worker,
      replacementConnection,
      "client.begin",
      {
        kind: "codex",
        displayName: "Codex",
        installIdentity: replacementInstallIdentity,
        publicKey: replacementDurable.publicKey,
        signingMode: trustPath === "production-signed" ? "secure-enclave" : "development-exact-build",
        requestedCapabilities,
        forgetPolicy: "never",
      },
    );
    const replacement = await request(
      fixture.worker,
      replacementConnection,
      "client.complete_pairing",
      {
        requestId: replacementPairing.requestId,
        clientSignature: signature(
          replacementPairing.clientProofTranscript,
          replacementDurable.privateKey,
        ),
      },
      true,
    );
    expect(replacement.clientId).not.toBe(originalPaired.clientId);
    const replacementSession = p256();
    const replacementActivation = await activateExisting(
      fixture, replacementConnection, replacementDurable, replacementSession, replacement,
    );
    const saved = await memoryRequest(fixture, replacementConnection, replacementActivation,
      "memory.remember", { content: "Reconnected connector can save" }, replacementSession.privateKey);
    expect(saved.note.content).toBe("Reconnected connector can save");
    const fetched = await memoryRequest(fixture, replacementConnection, replacementActivation,
      "memory.get_note", { id: saved.note.id }, replacementSession.privateKey);
    expect(fetched.note.content).toBe("Reconnected connector can save");
    await expect(memoryRequest(fixture, clientConnection, originalActivation,
      "memory.remember", { content: "Old connection remains revoked" }, originalSession.privateKey))
      .rejects.toThrow();

    const staleIdentity = await rawRequest(
      fixture.worker,
      clientConnection,
      "client.begin",
      {
        kind: "codex",
        displayName: "Codex",
        installIdentity,
        publicKey: durable.publicKey,
        signingMode: trustPath === "production-signed" ? "secure-enclave" : "development-exact-build",
        requestedCapabilities,
        forgetPolicy: "never",
      },
    );
    expect(staleIdentity).toMatchObject({
      ok: false,
      error: {
        code: "denied",
        message: "Revoked MCP client public keys cannot be paired again",
      },
    });
  });

  it("allows a configurable daily owner inspection on the production trust path", async () => {
    const now = Date.now();
    const development = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 40004 };
    const requestedScopes = ["owner.inspect_clients"];
    const ttlMs = 24 * 60 * 60 * 1_000;

    const session = await ownerRequest(
      development.worker,
      connection,
      "owner.session.begin",
      { requestedScopes, ttlMs },
      true,
    );
    expect(session.expiresAt).toBe(new Date(now + ttlMs).toISOString());

    const production = workerFixture({
      now: () => now,
      trustPath: "production-signed",
    });
    const productionSession = await ownerRequest(
      production.worker,
      { connectionId: randomUUID(), peerPid: 40005 },
      "owner.session.begin",
      { requestedScopes, ttlMs },
      true,
    );
    expect(productionSession.expiresAt).toBe(new Date(now + ttlMs).toISOString());
  });

  it("lets the signed owner app configure routine connector authentication", async () => {
    const now = Date.now();
    const fixture = workerFixture({ now: () => now });
    const ownerConnection = { connectionId: randomUUID(), peerPid: 40006 };
    const daily = 24 * 60 * 60 * 1_000;
    const fifteenMinutes = 15 * 60 * 1_000;
    expect(await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.routine_authentication",
      {},
    )).toEqual({ ttlMs: daily });

    const staleShortOwner = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.session.begin",
      { requestedScopes: ["owner.inspect_clients"], ttlMs: fifteenMinutes },
      true,
    );
    const staleShortLibrary = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "library.session.begin",
      { requestedScopes: ["library.browse"], ttlMs: fifteenMinutes },
      true,
    );
    expect(staleShortOwner.expiresAt).toBe(new Date(now + daily).toISOString());
    expect(staleShortLibrary.expiresAt).toBe(new Date(now + daily).toISOString());

    const ownerSession = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.session.begin",
      {
        requestedScopes: [
          "owner.inspect_clients",
          "owner.inspect_grants",
          "owner.inspect_sessions",
        ],
        ttlMs: daily,
      },
      true,
    );
    const librarySession = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "library.session.begin",
      { requestedScopes: ["library.browse"], ttlMs: daily },
      true,
    );
    expect(ownerSession.expiresAt).toBe(new Date(now + daily).toISOString());
    expect(librarySession.expiresAt).toBe(new Date(now + daily).toISOString());

    expect(await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.set_routine_authentication",
      { ttlMs: fifteenMinutes },
    )).toEqual({ ttlMs: fifteenMinutes });
    expect(await rawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    )).toMatchObject({ ok: false, error: { code: "owner_session_required" } });
    expect(await rawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "library.views",
      {},
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });

    const cappedOwner = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.session.begin",
      { requestedScopes: ["owner.inspect_clients"], ttlMs: daily },
      true,
    );
    const cappedLibrary = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "library.session.begin",
      { requestedScopes: ["library.browse"], ttlMs: daily },
      true,
    );
    expect(cappedOwner.expiresAt).toBe(new Date(now + fifteenMinutes).toISOString());
    expect(cappedLibrary.expiresAt).toBe(new Date(now + fifteenMinutes).toISOString());

    const pendingOwner = await beginRawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "owner.session.begin",
      { requestedScopes: ["owner.inspect_clients"], ttlMs: daily },
    );
    const pendingLibrary = await beginRawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "library.session.begin",
      { requestedScopes: ["library.browse"], ttlMs: daily },
    );
    await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.set_routine_authentication",
      { ttlMs: 4 * 60 * 60 * 1_000 },
    );
    expect(await completeOwnerPresence(
      fixture.worker,
      ownerConnection,
      pendingOwner.ownerPresenceChallenge.challengeId,
    )).toMatchObject({ ok: false, error: { code: "replayed" } });
    expect(await completeOwnerPresence(
      fixture.worker,
      ownerConnection,
      pendingLibrary.ownerPresenceChallenge.challengeId,
    )).toMatchObject({ ok: false, error: { code: "replayed" } });

    expect(await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.routine_authentication",
      {},
    )).toEqual({ ttlMs: 4 * 60 * 60 * 1_000 });

    expect(await rawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "owner.set_routine_authentication",
      { ttlMs: 60_000 },
    )).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("revalidates the exact revocation target after owner presence", async () => {
    const fixture = workerFixture();
    const memoryConnection = { connectionId: randomUUID(), peerPid: 40011 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 40012 };
    const durable = p256();
    const session = p256();
    await pairAndActivate(
      fixture,
      memoryConnection,
      durable,
      session,
      ["memory.remember"],
    );
    await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.session.begin",
      {
        requestedScopes: [
          "owner.inspect_clients",
          "owner.inspect_grants",
          "owner.inspect_sessions",
          "owner.inspect_audit",
        ],
        ttlMs: 300_000,
      },
      true,
    );
    const snapshot = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    const target = snapshot.clients[0];
    const first = JSON.parse(await fixture.worker.handleSerialized(JSON.stringify({
      kind: "client",
      peerRole: "owner-control",
      ...ownerConnection,
      payload: {
        protocolVersion: 1,
        requestId: randomUUID(),
        method: "owner.revoke_client",
        params: {
          clientId: target.clientId,
          kind: target.kind,
          displayLabel: target.displayLabel,
          authorityRevision: target.authorityRevision,
          scopes: target.activeScopes,
        },
      },
    })));
    expect(first.ownerPresenceChallenge).toBeDefined();

    const fault = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    try {
      fault.query(
        "update broker_grants set capabilities = '[\"memory.recall\"]' where client_id = ?",
      ).run(target.clientId);
    } finally {
      fault.close();
    }
    const approval = JSON.parse(await fixture.worker.handleSerialized(JSON.stringify({
      kind: "owner-presence",
      peerRole: "owner-control",
      ...ownerConnection,
      payload: {
        challengeId: first.ownerPresenceChallenge.challengeId,
        approved: true,
        outcome: "approved",
      },
    })));
    expect(approval).toMatchObject({
      ok: false,
      error: { code: "denied", message: "Broker request failed" },
    });
    const after = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    expect(after.clients[0]).toMatchObject({ status: "active", authorityRevision: 1 });
    expect(after.clients[0].activeScopes).toEqual(["memory.recall"]);
    expect(
      fixture.worker.readAuditForTest().filter(
        (event) => event.operation === "client.revoke" && event.outcome === "success",
      ),
    ).toHaveLength(0);
  });

  it("invalidates owner inspection on denial, disconnect, expiry, and peer mismatch", async () => {
    let now = Date.now();
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 40101 };
    const params = {
      requestedScopes: ["owner.inspect_clients"],
      ttlMs: 5 * 60 * 1_000,
    };
    for (const [outcome, code] of [
      ["denied", "owner_denied"],
      ["cancelled", "owner_cancelled"],
      ["timed_out", "owner_timeout"],
      ["unavailable", "owner_auth_unavailable"],
    ] as const) {
      const refused = await rawOwnerRequest(
        fixture.worker,
        connection,
        "owner.session.begin",
        params,
        outcome,
      );
      expect(refused.error.code).toBe(code);
    }
    await ownerRequest(fixture.worker, connection, "owner.session.begin", params, true);
    const wrongPid = await rawOwnerRequest(
      fixture.worker,
      { ...connection, peerPid: connection.peerPid + 1 },
      "owner.inspect_connections",
      {},
    );
    expect(wrongPid.error.code).toBe("owner_session_required");
    now += 24 * 60 * 60 * 1_000 + 1;
    const expired = await rawOwnerRequest(
      fixture.worker,
      connection,
      "owner.inspect_connections",
      {},
    );
    expect(expired.error.code).toBe("owner_session_expired");

    await ownerRequest(fixture.worker, connection, "owner.session.begin", params, true);
    await fixture.worker.handleSerialized(JSON.stringify({
      kind: "connection-closed",
      peerRole: "owner-control",
      ...connection,
      payload: null,
    }));
    const disconnected = await rawOwnerRequest(
      fixture.worker,
      connection,
      "owner.inspect_connections",
      {},
    );
    expect(disconnected.error.code).toBe("owner_session_required");
  });

  it("shows the exact trusted work-session prompt contract and refuses unknown revocation targets before prompting", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 40999 };
    const durable = p256();
    const session = p256();
    const requestedCapabilities: MemoryCapability[] = [
      "memory.remember",
      "memory.recall",
      "memory.get_note",
    ];
    const begun = await request(fixture.worker, connection, "client.begin", {
      kind: "codex",
      displayName: "Codex",
      installIdentity: randomUUID(),
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities,
      forgetPolicy: "never",
    });
    const paired = await request(fixture.worker, connection, "client.complete_pairing", {
      requestId: begun.requestId,
      clientSignature: signature(begun.clientProofTranscript, durable.privateKey),
    }, true);
    const activation = await request(fixture.worker, connection, "session.begin", {
      clientId: paired.clientId,
      grantId: paired.grantId,
      sessionPublicKey: session.publicKey,
      requestedCapabilities,
      ttlMs: 15 * 60 * 1_000,
    });
    const completion = JSON.parse(await fixture.worker.handleSerialized(JSON.stringify({
      kind: "client",
      peerRole: "memory-client",
      ...connection,
      payload: {
        protocolVersion: 1,
        requestId: randomUUID(),
        method: "session.complete",
        params: {
          activationId: activation.activationId,
          ownerDecisionTranscript: activation.ownerDecisionTranscript,
          clientSignature: signature(activation.clientProofTranscript, durable.privateKey),
          sessionSignature: signature(activation.sessionProofTranscript, session.privateKey),
        },
      },
    })));
    const verificationDigest = createHash("sha256")
      .update(activation.ownerDecisionTranscript)
      .digest("hex")
      .slice(0, 12);
    const verificationPhrase = [0, 4, 8]
      .map((offset) => verificationDigest.slice(offset, offset + 4))
      .join(" ");
    expect(completion.ownerPresenceChallenge.reason).toBe(
      "Start a shared Afternote work session for 24 hours with an inactivity limit of 24 hours? " +
      "During this work session, previously paired Codex, Claude Code, and Claude Desktop apps may " +
      "silently establish their own connection-bound, least-privilege sessions for " +
      "up to 15 minutes, limited to Remember, Recall, and Get. This triggering " +
      "connection lasts 15 minutes. " +
      `Verification: ${verificationPhrase}.`,
    );

    await ownerRequest(fixture.worker, connection, "owner.session.begin", {
      requestedScopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
      ],
      ttlMs: 5 * 60 * 1_000,
    }, true);
    const unknown = await rawOwnerRequest(
      fixture.worker,
      connection,
      "owner.revoke_client",
      {
        clientId: randomUUID(),
        kind: "codex",
        displayLabel: "Codex",
        authorityRevision: 1,
        scopes: requestedCapabilities,
      },
    );
    expect(unknown.ownerPresenceChallenge).toBeUndefined();
    expect(unknown.error.message).toBe("Broker request failed");
  });

  it("gates real encrypted Memory operations on owner-approved connection-bound scope", async () => {
    const fixture = workerFixture();
    const durable = p256();
    const session = p256();
    const connection = { connectionId: randomUUID(), peerPid: 41001 };
    const requestedCapabilities: MemoryCapability[] = [
      "memory.remember",
      "memory.recall",
      "memory.get_note",
    ];

    const clientBegin = await request(fixture.worker, connection, "client.begin", {
      kind: "codex",
      displayName: "Codex",
      installIdentity: randomUUID(),
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities,
      forgetPolicy: "never",
    });
    expect(clientBegin.state).toBe("proof_required");
    const paired = await request(
      fixture.worker,
      connection,
      "client.complete_pairing",
      {
        requestId: clientBegin.requestId,
        clientSignature: signature(clientBegin.clientProofTranscript, durable.privateKey),
      },
      true,
    );
    const activation = await request(fixture.worker, connection, "session.begin", {
      clientId: paired.clientId,
      grantId: paired.grantId,
      sessionPublicKey: session.publicKey,
      requestedCapabilities,
      ttlMs: 15 * 60 * 1_000,
    });
    const activated = await request(
      fixture.worker,
      connection,
      "session.complete",
      {
        activationId: activation.activationId,
        ownerDecisionTranscript: activation.ownerDecisionTranscript,
        clientSignature: signature(activation.clientProofTranscript, durable.privateKey),
        sessionSignature: signature(activation.sessionProofTranscript, session.privateKey),
      },
      true,
    );
    expect(activated.capabilities).toEqual(requestedCapabilities);
    expect(activated.capabilities).not.toContain("memory.forget");

    const rememberBody = {
      content: "The broker-only integration canary is cedar-7823.",
      source: {
        application: "Codex",
        url: "https://chatgpt.com/codex/tasks/example",
        author: "Danny Kim",
        timestamp: "2026-08-29T16:00:00.000Z",
        label: "Broker metadata regression",
      },
    };
    const rememberEnvelope = envelope(
      fixture,
      activated,
      "memory.remember",
      rememberBody,
      session.privateKey,
    );
    const remembered = await request(fixture.worker, connection, "memory.execute", {
      envelope: rememberEnvelope,
      body: rememberBody,
    });
    expect(remembered.note).toMatchObject({
      content: rememberBody.content,
      revision: 1,
      source: rememberBody.source,
    });

    const recallBody = { query: "Which integration canary used cedar?", limit: 5 };
    const recalled = await memoryRequest(
      fixture,
      connection,
      activated,
      "memory.recall",
      recallBody,
      session.privateKey,
    );
    expect(recalled.results[0]).toMatchObject({
      note: { id: remembered.note.id, content: rememberBody.content, revision: 1 },
      citation: { noteId: remembered.note.id, revision: 1 },
    });
    const got = await memoryRequest(
      fixture,
      connection,
      activated,
      "memory.get_note",
      { id: remembered.note.id },
      session.privateKey,
    );
    expect(got.note).toMatchObject({ id: remembered.note.id, revision: 1 });

    const forget = await rawMemoryRequest(
      fixture.worker,
      connection,
      envelope(
        fixture,
        activated,
        "memory.forget",
        { id: remembered.note.id },
        session.privateKey,
      ),
      { id: remembered.note.id },
    );
    expect(forget.ok).toBe(false);
    expect(forget.error.message).toContain("does not grant memory.forget");

    const copied = await rawMemoryRequest(
      fixture.worker,
      { connectionId: randomUUID(), peerPid: 41002 },
      rememberEnvelope,
      rememberBody,
    );
    expect(copied.ok).toBe(false);
    expect(copied.error.message).toContain("transport");

    const replayed = await rawMemoryRequest(
      fixture.worker,
      connection,
      rememberEnvelope,
      rememberBody,
    );
    expect(replayed.ok).toBe(false);
    expect(replayed.error.message).toContain("replayed");

    const encrypted = readFileSync(fixture.path);
    expect(encrypted.subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
    expect(encrypted.includes(Buffer.from(rememberBody.content))).toBe(false);
    const audit = fixture.worker.readAuditForTest();
    expect(audit.some((event) =>
      event.operation === "session.activate" && event.sessionId === activated.sessionId
    )).toBe(true);
    expect(audit.some((event) =>
      event.operation === "memory.recall" &&
      event.noteRefs.some((reference) => reference.noteId === remembered.note.id)
    )).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("cedar-7823");
  });

  it("shares one owner-approved work session across each paired connector kind", async () => {
    const now = Date.parse("2026-08-29T16:00:00.000Z");
    const fixture = workerFixture({ now: () => now });
    const capabilities: MemoryCapability[] = [
      "memory.remember",
      "memory.recall",
      "memory.get_note",
    ];
    const codexConnection = { connectionId: randomUUID(), peerPid: 41101 };
    const claudeConnection = { connectionId: randomUUID(), peerPid: 41102 };
    const claudeDesktopConnection = { connectionId: randomUUID(), peerPid: 41103 };
    const codexDurable = p256();
    const claudeDurable = p256();
    const claudeDesktopDurable = p256();
    const codexSession = p256();
    const claudeSession = p256();
    const claudeDesktopSession = p256();

    const codexPaired = await pairClient(
      fixture,
      codexConnection,
      "codex",
      codexDurable,
      capabilities,
    );
    const codexActivation = await beginActivation(
      fixture,
      codexConnection,
      codexPaired,
      codexSession,
      capabilities,
    );
    const codexPending = await beginMemoryClientRequest(
      fixture.worker,
      codexConnection,
      "session.complete",
      activationProofs(codexActivation, codexDurable, codexSession),
    );
    expect(codexPending.ownerPresenceChallenge.reason).toContain(
      "Start a shared Afternote work session",
    );
    const codexActivated = await completeMemoryOwnerPresence(
      fixture.worker,
      codexConnection,
      codexPending.ownerPresenceChallenge.challengeId,
      "approved",
    );
    expect(codexActivated).toMatchObject({
      ok: true,
      result: {
        clientId: codexPaired.clientId,
        grantId: codexPaired.grantId,
        expiresAt: new Date(now + 15 * 60 * 1_000).toISOString(),
      },
    });

    const claudePaired = await pairClient(
      fixture,
      claudeConnection,
      "claude",
      claudeDurable,
      capabilities,
    );
    const claudeActivation = await beginActivation(
      fixture,
      claudeConnection,
      claudePaired,
      claudeSession,
      capabilities,
    );
    const claudeActivated = await beginMemoryClientRequest(
      fixture.worker,
      claudeConnection,
      "session.complete",
      activationProofs(claudeActivation, claudeDurable, claudeSession),
    );
    expect(claudeActivated.ownerPresenceChallenge).toBeUndefined();
    expect(claudeActivated).toMatchObject({
      ok: true,
      result: {
        clientId: claudePaired.clientId,
        grantId: claudePaired.grantId,
        expiresAt: new Date(now + 15 * 60 * 1_000).toISOString(),
      },
    });

    const claudeDesktopPaired = await pairClient(
      fixture,
      claudeDesktopConnection,
      "claude-desktop",
      claudeDesktopDurable,
      capabilities,
    );
    const claudeDesktopActivation = await beginActivation(
      fixture,
      claudeDesktopConnection,
      claudeDesktopPaired,
      claudeDesktopSession,
      capabilities,
    );
    const claudeDesktopActivated = await beginMemoryClientRequest(
      fixture.worker,
      claudeDesktopConnection,
      "session.complete",
      activationProofs(
        claudeDesktopActivation,
        claudeDesktopDurable,
        claudeDesktopSession,
      ),
    );
    expect(claudeDesktopActivated.ownerPresenceChallenge).toBeUndefined();
    expect(claudeDesktopActivated).toMatchObject({
      ok: true,
      result: {
        clientId: claudeDesktopPaired.clientId,
        grantId: claudeDesktopPaired.grantId,
        expiresAt: new Date(now + 15 * 60 * 1_000).toISOString(),
      },
    });

    const copied = await rawMemoryRequest(
      fixture.worker,
      codexConnection,
      envelope(
        fixture,
        claudeActivated.result,
        "memory.recall",
        { query: "copied connection must fail", limit: 5 },
        claudeSession.privateKey,
      ),
      { query: "copied connection must fail", limit: 5 },
    );
    expect(copied).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(copied.error.message).toContain("transport");
  });

  it("keeps trusted work authority for the day and expires it at the absolute deadline", async () => {
    let now = Date.parse("2026-08-29T08:00:00.000Z");
    const startedAt = now;
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 41111 };
    const durable = p256();
    const capabilities: MemoryCapability[] = ["memory.recall"];
    const paired = await pairClient(
      fixture,
      connection,
      "codex",
      durable,
      capabilities,
    );

    const firstKey = p256();
    const firstActivation = await beginActivation(
      fixture,
      connection,
      paired,
      firstKey,
      capabilities,
    );
    const first = await request(
      fixture.worker,
      connection,
      "session.complete",
      activationProofs(firstActivation, durable, firstKey),
      true,
    );

    now += 4 * 60 * 60 * 1_000;
    const sameDayKey = p256();
    const sameDayActivation = await beginActivation(
      fixture,
      connection,
      paired,
      sameDayKey,
      capabilities,
    );
    const sameDay = await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "session.complete",
      activationProofs(sameDayActivation, durable, sameDayKey),
    );
    expect(sameDay.ownerPresenceChallenge).toBeUndefined();
    expect(sameDay.ok).toBe(true);
    expect(await rawMemoryRequest(
      fixture.worker,
      connection,
      envelope(
        fixture,
        first,
        "memory.recall",
        { query: "expired work session", limit: 5 },
        firstKey.privateKey,
      ),
      { query: "expired work session", limit: 5 },
    )).toMatchObject({ ok: false, error: { code: "denied" } });
    now = startedAt + 24 * 60 * 60 * 1_000 + 1;
    const afterAbsoluteKey = p256();
    const afterAbsoluteActivation = await beginActivation(
      fixture,
      connection,
      paired,
      afterAbsoluteKey,
      capabilities,
    );
    const afterAbsolute = await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "session.complete",
      activationProofs(afterAbsoluteActivation, durable, afterAbsoluteKey),
    );
    expect(afterAbsolute.ownerPresenceChallenge).toBeDefined();
    expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
      operation: "session.expire",
      outcome: "success",
      errorCode: "work_session_expired",
    }));
  });

  it("silently reactivates a reconnected Claude Desktop process within the work session", async () => {
    let now = Date.parse("2026-09-12T16:00:00.000Z");
    const fixture = workerFixture({ now: () => now });
    const firstConnection = { connectionId: randomUUID(), peerPid: 41131 };
    const installIdentity = randomUUID();
    const durable = p256();
    const capabilities: MemoryCapability[] = [
      "memory.remember",
      "memory.recall",
      "memory.get_note",
    ];
    const begun = await request(fixture.worker, firstConnection, "client.begin", {
      kind: "claude-desktop",
      displayName: "Claude Desktop",
      installIdentity,
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: capabilities,
      forgetPolicy: "never",
    });
    const paired = await request(
      fixture.worker,
      firstConnection,
      "client.complete_pairing",
      {
        requestId: begun.requestId,
        clientSignature: signature(begun.clientProofTranscript, durable.privateKey),
      },
      true,
    );
    const firstSession = p256();
    const firstActivation = await beginActivation(
      fixture,
      firstConnection,
      paired,
      firstSession,
      capabilities,
    );
    await request(
      fixture.worker,
      firstConnection,
      "session.complete",
      activationProofs(firstActivation, durable, firstSession),
      true,
    );
    await fixture.worker.handleSerialized(JSON.stringify({
      kind: "connection-closed",
      peerRole: "memory-client",
      ...firstConnection,
      payload: {},
    }));
    expect(await ownerRequest(
      fixture.worker,
      { connectionId: randomUUID(), peerPid: 41133 },
      "owner.connector_overview",
      {},
    )).toMatchObject({
      connectors: [{ kind: "claude-desktop", status: "paired" }],
    });

    now += 15 * 60 * 1_000 + 1;
    const replacementConnection = { connectionId: randomUUID(), peerPid: 41132 };
    const reconnected = await request(
      fixture.worker,
      replacementConnection,
      "client.begin",
      {
        kind: "claude-desktop",
        displayName: "Claude Desktop",
        installIdentity,
        publicKey: durable.publicKey,
        signingMode: "development-exact-build",
        requestedCapabilities: capabilities,
        forgetPolicy: "never",
      },
    );
    expect(reconnected).toMatchObject({
      state: "paired",
      clientId: paired.clientId,
      grantId: paired.grantId,
    });
    const replacementSession = p256();
    const replacementActivation = await beginActivation(
      fixture,
      replacementConnection,
      reconnected,
      replacementSession,
      capabilities,
    );
    const reactivated = await beginMemoryClientRequest(
      fixture.worker,
      replacementConnection,
      "session.complete",
      activationProofs(replacementActivation, durable, replacementSession),
    );
    expect(reactivated.ownerPresenceChallenge).toBeUndefined();
    expect(reactivated).toMatchObject({
      ok: true,
      result: {
        clientId: paired.clientId,
        grantId: paired.grantId,
        expiresAt: new Date(now + 15 * 60 * 1_000).toISOString(),
      },
    });
  });

  it("applies a changed routine-authentication window to every connector work session", async () => {
    let now = Date.parse("2026-09-12T18:00:00.000Z");
    const fixture = workerFixture({ now: () => now });
    const owner = { connectionId: randomUUID(), peerPid: 41135 };
    const fourHours = 4 * 60 * 60 * 1_000;
    expect(await ownerRequest(
      fixture.worker,
      owner,
      "owner.set_routine_authentication",
      { ttlMs: fourHours },
    )).toEqual({ ttlMs: fourHours });

    const firstConnection = { connectionId: randomUUID(), peerPid: 41136 };
    const durable = p256();
    const capabilities: MemoryCapability[] = ["memory.recall"];
    const paired = await pairClient(
      fixture,
      firstConnection,
      "codex",
      durable,
      capabilities,
    );
    const firstSession = p256();
    const firstActivation = await beginActivation(
      fixture,
      firstConnection,
      paired,
      firstSession,
      capabilities,
    );
    const firstPending = await beginMemoryClientRequest(
      fixture.worker,
      firstConnection,
      "session.complete",
      activationProofs(firstActivation, durable, firstSession),
    );
    expect(firstPending.ownerPresenceChallenge.reason).toContain(
      "work session for 4 hours",
    );
    await completeMemoryOwnerPresence(
      fixture.worker,
      firstConnection,
      firstPending.ownerPresenceChallenge.challengeId,
      "approved",
    );

    now += 15 * 60 * 1_000 + 1;
    const secondConnection = { connectionId: randomUUID(), peerPid: 41137 };
    const claudeDurable = p256();
    const claudePaired = await pairClient(
      fixture,
      secondConnection,
      "claude-desktop",
      claudeDurable,
      capabilities,
    );
    const secondSession = p256();
    const secondActivation = await beginActivation(
      fixture,
      secondConnection,
      claudePaired,
      secondSession,
      capabilities,
    );
    const silent = await beginMemoryClientRequest(
      fixture.worker,
      secondConnection,
      "session.complete",
      activationProofs(secondActivation, claudeDurable, secondSession),
    );
    expect(silent.ownerPresenceChallenge).toBeUndefined();
    expect(silent.ok).toBe(true);

    const daily = 24 * 60 * 60 * 1_000;
    await ownerRequest(
      fixture.worker,
      owner,
      "owner.set_routine_authentication",
      { ttlMs: daily },
    );
    const thirdSession = p256();
    const thirdActivation = await beginActivation(
      fixture,
      secondConnection,
      claudePaired,
      thirdSession,
      capabilities,
    );
    const changedPolicy = await beginMemoryClientRequest(
      fixture.worker,
      secondConnection,
      "session.complete",
      activationProofs(thirdActivation, claudeDurable, thirdSession),
    );
    expect(changedPolicy.ownerPresenceChallenge.reason).toContain(
      "work session for 24 hours",
    );
  });

  it("returns share-safe connector activity without starting an owner session", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 41141 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 41142 };
    const durable = p256();
    const session = p256();
    const paired = await pairClient(
      fixture,
      connection,
      "claude-desktop",
      durable,
      ["memory.remember", "memory.recall", "memory.get_note"],
    );
    const activated = await activateExisting(
      fixture,
      connection,
      durable,
      session,
      paired,
    );
    const initialOverview = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.connector_overview",
      {},
    );
    expect(initialOverview).toEqual({
      connectors: [expect.objectContaining({
        kind: "claude-desktop",
        savedCount: 0,
        readCount: 0,
      })],
    });
    const body = {
      content: "Claude Desktop activity summary canary",
      source: { application: "Claude Desktop" },
    };
    await memoryRequest(
      fixture,
      connection,
      activated,
      "memory.remember",
      body,
      session.privateKey,
    );
    await memoryRequest(
      fixture,
      connection,
      activated,
      "memory.recall",
      { query: "activity summary canary", limit: 5 },
      session.privateKey,
    );

    const overview = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.connector_overview",
      {},
    );
    expect(overview).toEqual({
      connectors: [
        {
          kind: "claude-desktop",
          status: "active",
          activeScopes: ["memory.remember", "memory.recall", "memory.get_note"],
          lastActivityAt: expect.any(String),
          savedCount: 1,
          readCount: 1,
          verifiedRoundTrip: true,
        },
      ],
    });
    expect(JSON.stringify(overview)).not.toMatch(
      /clientId|grantId|sessionId|noteRefs|activity summary canary/i,
    );
  });

  it("does not open trusted work authority when activation audit fails", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 41121 };
    const durable = p256();
    const capabilities: MemoryCapability[] = ["memory.recall"];
    const paired = await pairClient(
      fixture,
      connection,
      "codex",
      durable,
      capabilities,
    );
    const firstKey = p256();
    const firstActivation = await beginActivation(
      fixture,
      connection,
      paired,
      firstKey,
      capabilities,
    );
    const database = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    database.exec(`
      create trigger reject_trusted_work_activation_audit
      before insert on broker_audit_events
      when new.operation = 'session.activate'
      begin select raise(abort, 'forced activation audit failure'); end;
    `);
    const failed = await rawRequest(
      fixture.worker,
      connection,
      "session.complete",
      activationProofs(firstActivation, durable, firstKey),
      true,
    );
    expect(failed).toMatchObject({ ok: false, error: { code: "denied" } });
    database.exec("drop trigger reject_trusted_work_activation_audit");
    database.close();

    const replacementKey = p256();
    const replacementActivation = await beginActivation(
      fixture,
      connection,
      paired,
      replacementKey,
      capabilities,
    );
    const replacement = await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "session.complete",
      activationProofs(replacementActivation, durable, replacementKey),
    );
    expect(replacement.ownerPresenceChallenge).toBeDefined();
  });

  it("rolls back Remember when its terminal success audit cannot commit", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 41003 };
    const durable = p256();
    const session = p256();
    const activated = await pairAndActivate(
      fixture,
      connection,
      durable,
      session,
      ["memory.remember"],
    );
    const inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    try {
      inspection.exec(`
        create trigger reject_worker_success_audit
        before update of outcome on broker_audit_events
        when new.outcome = 'success' and new.operation = 'memory.remember'
        begin
          select raise(abort, 'forced worker audit failure');
        end;
      `);
      const body = { content: "This note must roll back with its audit." };
      const response = await rawMemoryRequest(
        fixture.worker,
        connection,
        envelope(fixture, activated, "memory.remember", body, session.privateKey),
        body,
      );
      expect(response.ok).toBe(false);
      expect(
        inspection.query<{ count: number }, []>("select count(*) as count from notes").get()
          ?.count,
      ).toBe(0);
      expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
        operation: "memory.remember",
        outcome: "error",
        errorCode: "operation_failed",
      }));
    } finally {
      inspection.close();
    }
  });

  it("denies pairing and activation without owner presence", async () => {
    const fixture = workerFixture();
    const durable = p256();
    const connection = { connectionId: randomUUID(), peerPid: 42001 };
    const clientBegin = await request(fixture.worker, connection, "client.begin", {
      kind: "claude",
      displayName: "Claude Code",
      installIdentity: randomUUID(),
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
      forgetPolicy: "never",
    });
    const denied = await rawRequest(
      fixture.worker,
      connection,
      "client.complete_pairing",
      {
        requestId: clientBegin.requestId,
        clientSignature: signature(clientBegin.clientProofTranscript, durable.privateKey),
      },
      false,
    );
    expect(denied.ok).toBe(false);
    expect(denied.error.code).toBe("owner_denied");
  });

  it("terminalizes pairing and activation when owner-presence challenges expire", async () => {
    let now = Date.now();
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 42002 };
    const durable = p256();
    const pairing = await request(fixture.worker, connection, "client.begin", {
      kind: "codex",
      displayName: "Codex",
      installIdentity: randomUUID(),
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    now = Date.parse(pairing.expiresAt) - 1;
    const pendingPairing = await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "client.complete_pairing",
      {
        requestId: pairing.requestId,
        clientSignature: signature(pairing.clientProofTranscript, durable.privateKey),
      },
    );
    expect(pendingPairing.ownerPresenceChallenge.expiresAt).toBe(pairing.expiresAt);
    now = Date.parse(pendingPairing.ownerPresenceChallenge.expiresAt) + 1;
    expect(await completeMemoryOwnerPresence(
      fixture.worker,
      connection,
      pendingPairing.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "owner_timeout" } });
    expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
      operation: "client.pair",
      outcome: "denied",
      errorCode: "owner_timeout",
    }));

    const paired = await pairClient(
      fixture,
      connection,
      "codex",
      durable,
      ["memory.recall"],
    );
    const session = p256();
    const activation = await beginActivation(
      fixture,
      connection,
      paired,
      session,
      ["memory.recall"],
    );
    const activationDecisionExpiresAt = (JSON.parse(
      activation.ownerDecisionTranscript,
    ) as { decisionExpiresAt: string }).decisionExpiresAt;
    now = Date.parse(activationDecisionExpiresAt) - 1;
    const pendingActivation = await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "session.complete",
      activationProofs(activation, durable, session),
    );
    expect(pendingActivation.ownerPresenceChallenge.expiresAt)
      .toBe(activationDecisionExpiresAt);
    now = Date.parse(pendingActivation.ownerPresenceChallenge.expiresAt) + 1;
    expect(await completeMemoryOwnerPresence(
      fixture.worker,
      connection,
      pendingActivation.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "owner_timeout" } });
    expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
      operation: "session.activate",
      outcome: "denied",
      errorCode: "owner_timeout",
    }));
  });

  it("keeps pairing approval one-shot and prunes its timeout idempotently", async () => {
    let now = Date.now();
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 42003 };
    const durable = p256();
    const pairing = await request(fixture.worker, connection, "client.begin", {
      kind: "codex",
      displayName: "Codex",
      installIdentity: randomUUID(),
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const completion = {
      requestId: pairing.requestId,
      clientSignature: signature(pairing.clientProofTranscript, durable.privateKey),
    };
    const first = await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "client.complete_pairing",
      completion,
    );
    expect(await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "client.complete_pairing",
      completion,
    )).toMatchObject({
      ok: false,
      error: { code: "replayed", message: "Pairing approval is already pending" },
    });

    now = Date.parse(first.ownerPresenceChallenge.expiresAt) + 1;
    const other = p256();
    expect(await request(fixture.worker, connection, "client.begin", {
      kind: "codex",
      displayName: "Codex",
      installIdentity: randomUUID(),
      publicKey: other.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    })).toMatchObject({ state: "proof_required" });
    expect(fixture.worker.readAuditForTest().filter((event) =>
      event.operation === "client.pair" && event.errorCode === "owner_timeout"
    )).toHaveLength(1);
  });

  it("distinguishes owner denial, cancellation, timeout, and unavailable authentication", async () => {
    for (const [outcome, code, message] of [
      ["denied", "owner_denied", "denied access"],
      ["cancelled", "owner_cancelled", "was cancelled"],
      ["timed_out", "owner_timeout", "timed out"],
      ["unavailable", "owner_auth_unavailable", "is unavailable"],
    ] as const) {
      const fixture = workerFixture();
      const durable = p256();
      const connection = { connectionId: randomUUID(), peerPid: 42500 };
      const begun = await request(fixture.worker, connection, "client.begin", {
        kind: "claude",
        displayName: "Claude Code",
        installIdentity: randomUUID(),
        publicKey: durable.publicKey,
        signingMode: "development-exact-build",
        requestedCapabilities: ["memory.recall"],
        forgetPolicy: "never",
      });
      const response = await rawRequest(
        fixture.worker,
        connection,
        "client.complete_pairing",
        {
          requestId: begun.requestId,
          clientSignature: signature(begun.clientProofTranscript, durable.privateKey),
        },
        outcome,
      );
      expect(response).toMatchObject({
        ok: false,
        error: { code, message: expect.stringContaining(message) },
      });
      expect(fixture.worker.readAuditForTest()).toContainEqual(expect.objectContaining({
        operation: "client.pair",
        outcome: "denied",
        errorCode: code,
        noteRefs: [],
      }));
    }
  });

  it("records an activation cancellation without executing a Memory operation", async () => {
    const fixture = workerFixture();
    const durable = p256();
    const session = p256();
    const connection = { connectionId: randomUUID(), peerPid: 42600 };
    const begun = await request(fixture.worker, connection, "client.begin", {
      kind: "codex",
      displayName: "Codex",
      installIdentity: randomUUID(),
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: ["memory.remember"],
      forgetPolicy: "never",
    });
    const paired = await request(fixture.worker, connection, "client.complete_pairing", {
      requestId: begun.requestId,
      clientSignature: signature(begun.clientProofTranscript, durable.privateKey),
    }, true);
    const activation = await request(fixture.worker, connection, "session.begin", {
      clientId: paired.clientId,
      grantId: paired.grantId,
      sessionPublicKey: session.publicKey,
      requestedCapabilities: ["memory.remember"],
      ttlMs: 15 * 60 * 1_000,
    });
    const cancelled = await rawRequest(
      fixture.worker,
      connection,
      "session.complete",
      {
        activationId: activation.activationId,
        ownerDecisionTranscript: activation.ownerDecisionTranscript,
        clientSignature: signature(activation.clientProofTranscript, durable.privateKey),
        sessionSignature: signature(activation.sessionProofTranscript, session.privateKey),
      },
      "cancelled",
    );
    expect(cancelled).toMatchObject({
      ok: false,
      error: {
        code: "owner_cancelled",
        message: "Owner authentication was cancelled",
      },
    });
    const audit = fixture.worker.readAuditForTest();
    expect(audit).toContainEqual(expect.objectContaining({
      operation: "session.activate",
      outcome: "denied",
      errorCode: "owner_cancelled",
      noteRefs: [],
    }));
    expect(audit.some((event) => event.operation.startsWith("memory."))).toBe(false);
  });

  it("rejects malformed, oversized, unsigned, stale, and scope-escalating requests", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 43001 };
    const malformed = JSON.parse(await fixture.worker.handleSerialized("{"));
    expect(malformed).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const oversized = JSON.parse(await fixture.worker.handleSerialized("x".repeat(1_048_577)));
    expect(oversized).toMatchObject({ ok: false, error: { code: "invalid_request" } });

    const durable = p256();
    const session = p256();
    const paired = await pairAndActivate(
      fixture,
      connection,
      durable,
      session,
      ["memory.remember"],
    );
    const body = { content: "This request must be signed." };
    const unsigned = envelope(fixture, paired, "memory.remember", body, session.privateKey);
    unsigned.signature = "not-a-signature";
    expect((await rawMemoryRequest(fixture.worker, connection, unsigned, body)).error.message)
      .toBe("Broker request failed");

    const stale = envelope(fixture, paired, "memory.remember", body, session.privateKey);
    stale.issuedAt = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
    stale.signature = signature(canonicalBrokerTranscript({
      protocolVersion: stale.protocolVersion,
      brokerBootId: stale.brokerBootId,
      vaultId: stale.vaultId,
      clientId: stale.clientId,
      grantId: stale.grantId,
      sessionId: stale.sessionId,
      requestId: stale.requestId,
      issuedAt: stale.issuedAt,
      operation: stale.operation,
      bodySha256: stale.bodySha256,
    }), session.privateKey);
    expect((await rawMemoryRequest(fixture.worker, connection, stale, body)).error.message)
      .toBe("Broker request failed");

    const escalation = await rawRequest(fixture.worker, connection, "session.begin", {
      clientId: paired.clientId,
      grantId: paired.grantId,
      sessionPublicKey: p256().publicKey,
      requestedCapabilities: ["memory.remember", "memory.forget"],
      ttlMs: 60_000,
    });
    expect(escalation).toMatchObject({ ok: false, error: { code: "scope_denied" } });

    const overlong = await rawRequest(fixture.worker, connection, "session.begin", {
      clientId: paired.clientId,
      grantId: paired.grantId,
      sessionPublicKey: p256().publicKey,
      requestedCapabilities: ["memory.remember"],
      ttlMs: 15 * 60 * 1_000 + 1,
    });
    expect(overlong).toMatchObject({ ok: false, error: { code: "denied" } });
    expect(overlong.error.message).toBe("Broker request failed");
  });

  it("invalidates sessions on expiration, revocation, disconnect, and broker restart", async () => {
    let now = Date.now();
    const fixture = workerFixture({ now: () => now });
    const connection = { connectionId: randomUUID(), peerPid: 44001 };
    const durable = p256();
    const session = p256();
    const activated = await pairAndActivate(
      fixture,
      connection,
      durable,
      session,
      ["memory.remember"],
      1_000,
    );
    const body = { content: "lifecycle check" };

    now += 1_001;
    expect((await rawMemoryRequest(
      fixture.worker,
      connection,
      envelope(fixture, activated, "memory.remember", body, session.privateKey),
      body,
    )).error.message).toContain("expired");

    const secondSession = p256();
    const second = await activateExisting(
      fixture,
      connection,
      durable,
      secondSession,
      activated,
    );
    await ownerRequest(fixture.worker, connection, "owner.session.begin", {
      requestedScopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
      ],
      ttlMs: 5 * 60 * 1_000,
    }, true);
    const ownerSnapshot = await ownerRequest(
      fixture.worker,
      connection,
      "owner.inspect_connections",
      {},
    );
    await ownerRequest(fixture.worker, connection, "owner.revoke_client", {
      clientId: activated.clientId,
      kind: ownerSnapshot.clients[0].kind,
      displayLabel: ownerSnapshot.clients[0].displayLabel,
      authorityRevision: ownerSnapshot.clients[0].authorityRevision,
      scopes: ownerSnapshot.grants[0].scopes,
    }, true);
    expect((await rawMemoryRequest(
      fixture.worker,
      connection,
      envelope(fixture, second, "memory.remember", body, secondSession.privateKey),
      body,
    )).error.message).toContain("revoked");

    const other = workerFixture({ now: () => now });
    const otherConnection = { connectionId: randomUUID(), peerPid: 44002 };
    const otherDurable = p256();
    const otherSession = p256();
    const active = await pairAndActivate(
      other,
      otherConnection,
      otherDurable,
      otherSession,
      ["memory.remember"],
    );
    await rawRequest(other.worker, otherConnection, "health", {});
    await other.worker.handleSerialized(JSON.stringify({
      kind: "connection-closed",
      peerRole: "memory-client",
      ...otherConnection,
      payload: {},
    }));
    expect((await rawMemoryRequest(
      other.worker,
      otherConnection,
      envelope(other, active, "memory.remember", body, otherSession.privateKey),
      body,
    )).error.message).toContain("disconnected");

    other.worker.close();
    workers.splice(workers.indexOf(other.worker), 1);
    const restarted = new VaultBrokerWorker({
      applicationVersion: "test-worker",
      vaultPath: other.path,
      vaultKey: other.key,
      vault: other.vault,
      now: () => now,
      bootId: randomUUID(),
    });
    workers.push(restarted);
    const restartResponse = await rawMemoryRequest(
      restarted,
      otherConnection,
      envelope(other, active, "memory.remember", body, otherSession.privateKey),
      body,
    );
    expect(restartResponse.error.message).toContain("Broker boot");

    const restartSession = p256();
    const restartActivation = await request(
      restarted,
      otherConnection,
      "session.begin",
      {
        clientId: active.clientId,
        grantId: active.grantId,
        sessionPublicKey: restartSession.publicKey,
        requestedCapabilities: ["memory.remember"],
        ttlMs: 15 * 60 * 1_000,
      },
    );
    const restartCompleted = await beginMemoryClientRequest(
      restarted,
      otherConnection,
      "session.complete",
      activationProofs(restartActivation, otherDurable, restartSession),
    );
    expect(restartCompleted.ownerPresenceChallenge).toBeUndefined();
    expect(restartCompleted.result).toMatchObject({
      clientId: active.clientId,
      grantId: active.grantId,
      capabilities: ["memory.remember"],
    });
  });

  it("upgrades an alpha.8 vault to alpha.9 without losing revisions, identities, or grants", async () => {
    const fixtureRoot = join(import.meta.dir, "fixtures/alpha8");
    const metadata = JSON.parse(readFileSync(
      join(fixtureRoot, "fixture.json"),
      "utf8",
    )) as {
      sourceCommit: string;
      vault: VaultContext;
      noteId: string;
      clientId: string;
      grantId: string;
      sessionId: string;
    };
    expect(metadata.sourceCommit).toBe("95fefd08dfd1e1b2df360b0906e17631a64944c3");
    const directory = mkdtempSync(join(tmpdir(), "afternote-alpha8-upgrade-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    copyFileSync(join(fixtureRoot, "vault.db"), path);
    const key = readFileSync(join(fixtureRoot, "vault.key"));
    const restarted = new VaultBrokerWorker({
      applicationVersion: "2.0.0-alpha.9",
      vaultPath: path,
      vaultKey: key,
      vault: metadata.vault,
      bootId: randomUUID(),
    });
    workers.push(restarted);
    const connector = { connectionId: randomUUID(), peerPid: 44480 };
    const owner = { connectionId: randomUUID(), peerPid: 44481 };
    await ownerRequest(restarted, owner, "library.session.begin", {
      requestedScopes: [
        "library.get_note",
        "library.list_revisions",
        "library.inspect_source",
        "library.search",
      ],
      ttlMs: 15 * 60 * 1_000,
    }, true);
    expect(await ownerRequest(restarted, owner, "library.get_note", {
      id: metadata.noteId,
      revision: null,
    })).toMatchObject({
      note: {
        id: metadata.noteId,
        revision: 2,
        content: "Alpha.8 fixture revision two",
      },
    });
    expect((await ownerRequest(restarted, owner, "library.list_revisions", {
      id: metadata.noteId,
      cursor: null,
      limit: 10,
    })).revisions.map((revision: { revision: number }) => revision.revision))
      .toEqual([2, 1]);
    expect(await ownerRequest(restarted, owner, "library.search", {
      cursor: null,
      limit: 5,
      query: "What happened on August 28?",
    })).toMatchObject({ results: expect.any(Array) });

    await ownerRequest(restarted, owner, "owner.session.begin", {
      requestedScopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
        "owner.inspect_audit",
      ],
      ttlMs: 5 * 60 * 1_000,
    }, true);
    const connections = await ownerRequest(
      restarted,
      owner,
      "owner.inspect_connections",
      {},
    );
    expect(connections.clients[0]).toMatchObject({
      clientId: metadata.clientId,
      status: "paired",
    });
    expect(connections.grants[0]).toMatchObject({
      grantId: metadata.grantId,
      status: "active",
    });
    expect(connections.sessions).toContainEqual(expect.objectContaining({
      sessionId: metadata.sessionId,
      status: "disconnected",
    }));
    const audit = await ownerRequest(restarted, owner, "owner.inspect_audit", {
      cursor: null,
      pageSize: 100,
    });
    expect(audit.events).toContainEqual(expect.objectContaining({
      operation: "admin.telemetry.enable",
    }));

    const nextSession = p256();
    const activation = await request(restarted, connector, "session.begin", {
      clientId: metadata.clientId,
      grantId: metadata.grantId,
      sessionPublicKey: nextSession.publicKey,
      requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
      ttlMs: 15 * 60 * 1_000,
    });
    expect(activation.activationId).toEqual(expect.any(String));
  });

  it("preserves durable grants across lock but requires a fresh current-epoch activation", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 44501 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 44502 };
    const durable = p256();
    const originalSession = p256();
    const activated = await pairAndActivate(
      fixture,
      connection,
      durable,
      originalSession,
      ["memory.remember"],
    );
    const staleBody = { content: "pre-lock authority must not revive" };
    const staleEnvelope = envelope(
      fixture,
      activated,
      "memory.remember",
      staleBody,
      originalSession.privateKey,
    );

    await ownerRequest(fixture.worker, ownerConnection, "lifecycle.lock", {}, true);
    expect((await rawMemoryRequest(
      fixture.worker,
      connection,
      staleEnvelope,
      staleBody,
    ))).toMatchObject({ ok: false, error: { code: "vault_locked" } });
    await ownerRequest(fixture.worker, ownerConnection, "lifecycle.unlock", {}, true);
    expect((await rawMemoryRequest(
      fixture.worker,
      connection,
      staleEnvelope,
      staleBody,
    )).error.message).toContain("Broker boot");

    const currentSession = p256();
    const currentActivation = await beginActivation(
      fixture,
      connection,
      activated,
      currentSession,
      ["memory.remember"],
    );
    const pendingReactivation = await beginMemoryClientRequest(
      fixture.worker,
      connection,
      "session.complete",
      activationProofs(currentActivation, durable, currentSession),
    );
    expect(pendingReactivation.ownerPresenceChallenge).toBeDefined();
    const reactivationResponse = await completeMemoryOwnerPresence(
      fixture.worker,
      connection,
      pendingReactivation.ownerPresenceChallenge.challengeId,
      "approved",
    );
    expect(reactivationResponse.ok).toBe(true);
    const reactivated = reactivationResponse.result;
    const remembered = await memoryRequest(
      fixture,
      connection,
      reactivated,
      "memory.remember",
      { content: "durable grant reactivated in the new epoch" },
      currentSession.privateKey,
    );
    expect(remembered.note.content).toBe("durable grant reactivated in the new epoch");
  });
});

function workerFixture(options: {
  now?: () => number;
  trustPath?: "development-only" | "production-signed";
  applicationVersion?: string;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "afternote-worker-"));
  directories.push(directory);
  const path = join(directory, "vault.db");
  const key = randomBytes(32);
  const vault: VaultContext = { vaultId: "7".repeat(64), deployment: "local" };
  const worker = new VaultBrokerWorker({
    applicationVersion: options.applicationVersion ?? "test-worker",
    vaultPath: path,
    vaultKeyProvider: () => Uint8Array.from(key),
    vault,
    bootId: "f1ef9dc8-8c4d-4c83-b794-4ccb45adaef1",
    now: options.now,
    trustPath: options.trustPath,
  });
  workers.push(worker);
  return { worker, path, key, vault, now: options.now ?? Date.now };
}

async function pairClient(
  fixture: ReturnType<typeof workerFixture>,
  connection: { connectionId: string; peerPid: number },
  kind: "codex" | "claude" | "claude-desktop",
  durable: ReturnType<typeof p256>,
  requestedCapabilities: MemoryCapability[],
) {
  const begun = await request(fixture.worker, connection, "client.begin", {
    kind,
    displayName: kind === "codex"
      ? "Codex"
      : kind === "claude"
      ? "Claude Code"
      : "Claude Desktop",
    installIdentity: randomUUID(),
    publicKey: durable.publicKey,
    signingMode: "development-exact-build",
    requestedCapabilities,
    forgetPolicy: "never",
  });
  return request(fixture.worker, connection, "client.complete_pairing", {
    requestId: begun.requestId,
    clientSignature: signature(begun.clientProofTranscript, durable.privateKey),
  }, true);
}

async function beginActivation(
  fixture: ReturnType<typeof workerFixture>,
  connection: { connectionId: string; peerPid: number },
  paired: any,
  session: ReturnType<typeof p256>,
  requestedCapabilities: MemoryCapability[],
) {
  return request(fixture.worker, connection, "session.begin", {
    clientId: paired.clientId,
    grantId: paired.grantId,
    sessionPublicKey: session.publicKey,
    requestedCapabilities,
    ttlMs: 15 * 60 * 1_000,
  });
}

function activationProofs(
  activation: any,
  durable: ReturnType<typeof p256>,
  session: ReturnType<typeof p256>,
) {
  return {
    activationId: activation.activationId,
    ownerDecisionTranscript: activation.ownerDecisionTranscript,
    clientSignature: signature(activation.clientProofTranscript, durable.privateKey),
    sessionSignature: signature(activation.sessionProofTranscript, session.privateKey),
  };
}

async function beginMemoryClientRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
) {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "client",
    peerRole: "memory-client",
    ...connection,
    payload: {
      protocolVersion: 1,
      requestId: randomUUID(),
      method,
      params,
    },
  })));
}

async function completeMemoryOwnerPresence(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  challengeId: string,
  outcome: "approved" | "denied" | "cancelled" | "timed_out" | "unavailable",
) {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "owner-presence",
    peerRole: "memory-client",
    ...connection,
    payload: {
      challengeId,
      approved: outcome === "approved",
      outcome,
    },
  })));
}


async function pairAndActivate(
  fixture: ReturnType<typeof workerFixture>,
  connection: { connectionId: string; peerPid: number },
  durable: ReturnType<typeof p256>,
  session: ReturnType<typeof p256>,
  requestedCapabilities: MemoryCapability[],
  ttlMs = 15 * 60 * 1_000,
) {
  const begun = await request(fixture.worker, connection, "client.begin", {
    kind: "codex",
    displayName: "Codex",
    installIdentity: randomUUID(),
    publicKey: durable.publicKey,
    signingMode: "development-exact-build",
    requestedCapabilities,
    forgetPolicy: "never",
  });
  const paired = await request(fixture.worker, connection, "client.complete_pairing", {
    requestId: begun.requestId,
    clientSignature: signature(begun.clientProofTranscript, durable.privateKey),
  }, true);
  return activateExisting(fixture, connection, durable, session, paired, ttlMs);
}

async function activateExisting(
  fixture: ReturnType<typeof workerFixture>,
  connection: { connectionId: string; peerPid: number },
  durable: ReturnType<typeof p256>,
  session: ReturnType<typeof p256>,
  paired: any,
  ttlMs = 15 * 60 * 1_000,
) {
  const requestedCapabilities = paired.capabilities as MemoryCapability[];
  const begun = await request(fixture.worker, connection, "session.begin", {
    clientId: paired.clientId,
    grantId: paired.grantId,
    sessionPublicKey: session.publicKey,
    requestedCapabilities,
    ttlMs,
  });
  return request(fixture.worker, connection, "session.complete", {
    activationId: begun.activationId,
    ownerDecisionTranscript: begun.ownerDecisionTranscript,
    clientSignature: signature(begun.clientProofTranscript, durable.privateKey),
    sessionSignature: signature(begun.sessionProofTranscript, session.privateKey),
  }, true);
}

async function request(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
  approve?: boolean,
): Promise<any> {
  const response = await rawRequest(worker, connection, method, params, approve);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

async function rawRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
  ownerOutcome?: boolean | "denied" | "cancelled" | "timed_out" | "unavailable",
): Promise<any> {
  const requestId = randomUUID();
  const first = JSON.parse(await worker.handleSerialized(JSON.stringify({
      kind: "client",
      peerRole: "memory-client",
      ...connection,
    payload: { protocolVersion: 1, requestId, method, params },
  })));
  if (!first.ownerPresenceChallenge) return first;
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "owner-presence",
    peerRole: "memory-client",
    ...connection,
    payload: {
      challengeId: first.ownerPresenceChallenge.challengeId,
      approved: ownerOutcome === true,
      outcome: ownerOutcome === true ? "approved" : ownerOutcome || "denied",
    },
  })));
}

async function ownerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
  approve?: boolean,
): Promise<any> {
  const response = await rawOwnerRequest(worker, connection, method, params, approve);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

async function rawOwnerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
  ownerOutcome?: boolean | "denied" | "cancelled" | "timed_out" | "unavailable",
): Promise<any> {
  const requestId = randomUUID();
  const first = JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "client",
    peerRole: "owner-control",
    ...connection,
    payload: { protocolVersion: 1, requestId, method, params },
  })));
  if (!first.ownerPresenceChallenge) return first;
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "owner-presence",
    peerRole: "owner-control",
    ...connection,
    payload: {
      challengeId: first.ownerPresenceChallenge.challengeId,
      approved: ownerOutcome === true,
      outcome: ownerOutcome === true ? "approved" : ownerOutcome || "denied",
    },
  })));
}

async function beginRawOwnerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const requestId = randomUUID();
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "client",
    peerRole: "owner-control",
    ...connection,
    payload: { protocolVersion: 1, requestId, method, params },
  })));
}

async function completeOwnerPresence(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  challengeId: string,
): Promise<any> {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "owner-presence",
    peerRole: "owner-control",
    ...connection,
    payload: { challengeId, approved: true, outcome: "approved" },
  })));
}

async function memoryRequest(
  fixture: ReturnType<typeof workerFixture>,
  connection: { connectionId: string; peerPid: number },
  activated: any,
  operation: string,
  body: Record<string, unknown>,
  sessionPrivateKey: string,
): Promise<any> {
  const response = await rawMemoryRequest(
    fixture.worker,
    connection,
    envelope(fixture, activated, operation, body, sessionPrivateKey),
    body,
  );
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

async function rawMemoryRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  signedEnvelope: BrokerRequestEnvelope,
  body: Record<string, unknown>,
): Promise<any> {
  return await rawRequest(worker, connection, "memory.execute", {
    envelope: signedEnvelope,
    body,
  });
}

function envelope(
  fixture: ReturnType<typeof workerFixture>,
  activated: any,
  operation: string,
  body: Record<string, unknown>,
  sessionPrivateKey: string,
): BrokerRequestEnvelope {
  const unsigned = {
    protocolVersion: 1,
    brokerBootId: fixture.worker.bootId,
    vaultId: fixture.vault.vaultId,
    clientId: activated.clientId,
    grantId: activated.grantId,
    sessionId: activated.sessionId,
    requestId: randomUUID(),
    issuedAt: new Date(fixture.now()).toISOString(),
    operation,
    bodySha256: createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex"),
  };
  return {
    ...unsigned,
    signature: signature(canonicalBrokerTranscript(unsigned), sessionPrivateKey),
  };
}

function p256() {
  return generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function signature(transcript: string, privateKey: string): string {
  return sign("sha256", Buffer.from(transcript), privateKey).toString("base64url");
}
