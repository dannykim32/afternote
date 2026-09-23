import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { MemoryCapability } from "@afternote/memory";
import {
  VaultBrokerAuthorization,
  canonicalBrokerTranscript,
  type BrokerRequestEnvelope,
  type BrokerCapability,
} from "./vault-broker";
import { SqlcipherDatabase } from "./sqlcipher-database";

const directories: string[] = [];
const brokers: VaultBrokerAuthorization[] = [];
const vaultId = "7".repeat(64);

afterEach(() => {
  for (const broker of brokers.splice(0)) broker.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("VaultBrokerAuthorization", () => {
  it("keeps Archives out of Note grants until separate approval and revokes both together", () => {
    const { broker, owner } = brokerFixture();
    const client = p256(), session = p256();
    const paired = pair(broker, owner.privateKey, client.privateKey, {
      publicKey: client.publicKey, requestedCapabilities: ["memory.recall"], forgetPolicy: "never",
    });
    const requested: BrokerCapability[] = ["memory.recall", "archive.search", "archive.read"];
    const before = activate(broker, owner.privateKey, client.privateKey, session.privateKey, session.publicKey, paired, requested);
    expect(before.capabilities).toEqual(["memory.recall"]);
    const body = Buffer.from(JSON.stringify({ query: "canary", limit: 1 }));
    expect(() => broker.authorize(envelope(broker, before, "archive.search", body, session.privateKey), body)).toThrow();
    const target = broker.connectorRevocationTarget("codex");
    broker.approveConnectorArchiveAccess(target);
    expect(() => broker.approveConnectorArchiveAccess(target)).toThrow();
    expect(() => broker.authorize(envelope(broker, before, "memory.recall", body, session.privateKey), body)).toThrow();
    const after = activate(broker, owner.privateKey, client.privateKey, session.privateKey, session.publicKey, paired, requested);
    expect(after.capabilities).toEqual(requested);
    expect(broker.authorize(envelope(broker, after, "archive.search", body, session.privateKey), body).clientId).toBe(paired.clientId);
    broker.revokeClient(paired.clientId);
    expect(() => broker.authorize(envelope(broker, after, "archive.search", body, session.privateKey), body)).toThrow();
  });

  it("pairs and activates an agent with exact non-destructive scope", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );

    expect(activated.capabilities).toEqual([
      "memory.remember",
      "memory.recall",
      "memory.get_note",
    ]);
    expect(activated.capabilities).not.toContain("memory.forget");
    expect(activated.forgetPolicy).toBe("never");
  });

  it("rejects body edits, replay, copied IDs, restart reuse, and next-call revocation", () => {
    const fixture = brokerFixture();
    const client = p256();
    const attacker = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const body = Buffer.from(JSON.stringify({ content: "allowed" }));
    const valid = envelope(fixture.broker, activated, "memory.remember", body, session.privateKey);

    expect(fixture.broker.authorize(valid, body).clientId).toBe(paired.clientId);
    expect(() => fixture.broker.authorize(valid, body)).toThrow("replayed");

    const editedBody = Buffer.from(JSON.stringify({ content: "edited" }));
    const editedEnvelope = envelope(
      fixture.broker,
      activated,
      "memory.remember",
      body,
      session.privateKey,
    );
    expect(() => fixture.broker.authorize(editedEnvelope, editedBody)).toThrow("body hash");

    const stolen = envelope(
      fixture.broker,
      activated,
      "memory.remember",
      body,
      attacker.privateKey,
    );
    expect(() => fixture.broker.authorize(stolen, body)).toThrow("signature");

    const restarted = fixture.reopen("new-boot");
    const afterRestart = envelope(
      fixture.broker,
      activated,
      "memory.remember",
      body,
      session.privateKey,
    );
    expect(() => restarted.authorize(afterRestart, body)).toThrow("Broker boot");

    fixture.broker.revokeClient(paired.clientId);
    const afterRevocation = envelope(
      fixture.broker,
      activated,
      "memory.remember",
      body,
      session.privateKey,
    );
    expect(() => fixture.broker.authorize(afterRevocation, body)).toThrow("revoked");
    restarted.close();
  });

  it("prunes replay records after their signed-request validity window", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const body = Buffer.from(JSON.stringify({ content: "allowed" }));
    fixture.broker.authorize(
      envelope(fixture.broker, activated, "memory.remember", body, session.privateKey),
      body,
    );
    expect(fixture.replayCount()).toBe(1);

    fixture.advanceTime(5 * 60 * 1_000 + 1);
    fixture.broker.authorize(
      envelope(fixture.broker, activated, "memory.remember", body, session.privateKey),
      body,
    );

    expect(fixture.replayCount()).toBe(1);
  });

  it("keeps a remember-only MCP grant from reading or deleting and binds it to one vault", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      kind: "codex",
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const body = Buffer.from("{}");
    for (const operation of ["memory.recall", "memory.get_note", "memory.forget"] as const) {
      const request = envelope(fixture.broker, activated, operation, body, session.privateKey);
      expect(() => fixture.broker.authorize(request, body)).toThrow("does not grant");
    }
    const wrongVault = envelope(
      fixture.broker,
      activated,
      "memory.remember",
      body,
      session.privateKey,
      { vaultId: "8".repeat(64) },
    );
    expect(() => fixture.broker.authorize(wrongVault, body)).toThrow("vault");
  });

  it("persists an MCP connector reconnect gate across broker restarts", () => {
    const fixture = brokerFixture();
    const client = p256();
    pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      kind: "codex",
      installIdentity: randomUUID(),
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    fixture.broker.revokeConnector(
      fixture.broker.connectorRevocationTarget("codex"),
    );

    const restarted = fixture.reopen("boot-two");
    const replacement = p256();
    expect(() => restarted.requestPairing({
      kind: "codex",
      displayName: "Codex",
      installIdentity: randomUUID(),
      publicKey: replacement.publicKey,
      signingMode: "development-exact-build",
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    })).toThrow("Codex requires explicit reconnect preparation");
  });

  it("prepares one exact development identity for rotation atomically with audit", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const replacementInstallIdentity = "22222222-2222-4222-8222-222222222222";
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      installIdentity,
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
      ["memory.remember", "memory.recall", "memory.get_note"],
    );

    const target = fixture.broker.clientRotationTarget("codex", installIdentity);
    expect(target).toEqual({
      clientId: paired.clientId,
      kind: "codex",
      displayLabel: "Codex",
      installIdentity,
      authorityRevision: 1,
      scopes: ["memory.remember", "memory.recall", "memory.get_note"],
    });
    expect(() => fixture.broker.revokeClientForRotation({
      ...target,
      authorityRevision: target.authorityRevision + 1,
    }, replacementInstallIdentity)).toThrow("changed before approval");
    expect(fixture.broker.inspectConnections("development-only").clients[0])
      .toMatchObject({ clientId: paired.clientId, status: "active", authorityRevision: 1 });
    fixture.broker.revokeClientForRotation(target, replacementInstallIdentity);

    expect(fixture.broker.inspectConnections("development-only")).toMatchObject({
      clients: [{ clientId: paired.clientId, status: "revoked", authorityRevision: 2 }],
      grants: [{ grantId: paired.grantId, status: "revoked" }],
      sessions: [{ sessionId: activated.sessionId, status: "revoked" }],
    });
    expect(fixture.broker.readAuditForTest().at(-1)).toMatchObject({
      clientId: paired.clientId,
      operation: "client.rotate_identity",
      outcome: "success",
      noteRefs: [],
    });

    const retryTarget = fixture.broker.clientRotationTarget("codex", installIdentity);
    expect(retryTarget).toEqual({
      clientId: paired.clientId,
      kind: "codex",
      displayLabel: "Codex",
      installIdentity,
      authorityRevision: 2,
      scopes: ["memory.remember", "memory.recall", "memory.get_note"],
    });
    fixture.broker.revokeClientForRotation(retryTarget, replacementInstallIdentity);
    expect(fixture.broker.inspectConnections("development-only")).toMatchObject({
      clients: [{ clientId: paired.clientId, status: "revoked", authorityRevision: 2 }],
      grants: [{ grantId: paired.grantId, status: "revoked" }],
      sessions: [{ sessionId: activated.sessionId, status: "revoked" }],
    });
    expect(fixture.broker.readAuditForTest().filter((event) =>
      event.clientId === paired.clientId && event.operation === "client.rotate_identity"
    )).toHaveLength(2);
  });

  it("prepares an orphaned local identity replacement without inventing broker authority", () => {
    const fixture = brokerFixture();
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const replacementInstallIdentity = "22222222-2222-4222-8222-222222222222";

    const target = fixture.broker.clientRotationTarget("codex", installIdentity);
    expect(target).toEqual({
      clientId: null,
      kind: "codex",
      displayLabel: "Codex",
      installIdentity,
      authorityRevision: 0,
      scopes: [],
    });
    expect(() => fixture.broker.revokeClientForRotation(
      target,
      replacementInstallIdentity,
    )).not.toThrow();
    expect(fixture.broker.inspectConnections("development-only").clients).toEqual([]);
  });

  it("never treats an ordinary owner revocation as a rotation retry", () => {
    const fixture = brokerFixture();
    const client = p256();
    const replacementClient = p256();
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const replacementInstallIdentity = "22222222-2222-4222-8222-222222222222";
    const first = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      installIdentity,
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    fixture.broker.revokeClientForRotation(
      fixture.broker.clientRotationTarget("codex", installIdentity),
      replacementInstallIdentity,
    );
    const repaired = pair(
      fixture.broker,
      fixture.owner.privateKey,
      replacementClient.privateKey,
      {
      installIdentity: replacementInstallIdentity,
      publicKey: replacementClient.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    expect(repaired.clientId).not.toBe(first.clientId);
    fixture.broker.revokeClient(fixture.broker.revocationTarget(repaired.clientId));

    expect(() => fixture.broker.clientRotationTarget("codex", replacementInstallIdentity))
      .toThrow("was not revoked for rotation");
    expect(fixture.broker.inspectConnections("development-only").clients)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ clientId: first.clientId, status: "revoked" }),
        expect.objectContaining({ clientId: repaired.clientId, status: "revoked" }),
      ]));
  });

  it("prepares a separately approved local replacement after ordinary revocation", () => {
    const fixture = brokerFixture();
    const client = p256();
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const replacementInstallIdentity = "22222222-2222-4222-8222-222222222222";
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      installIdentity,
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    fixture.broker.revokeClient(fixture.broker.revocationTarget(paired.clientId));

    const target = fixture.broker.revokedClientReplacementTarget("codex", installIdentity);
    expect(target).toMatchObject({
      clientId: paired.clientId,
      kind: "codex",
      installIdentity,
      scopes: ["memory.recall"],
    });
    fixture.broker.prepareRevokedClientReplacement(target, replacementInstallIdentity);

    expect(fixture.broker.inspectConnections("development-only").clients[0])
      .toMatchObject({ clientId: paired.clientId, status: "revoked", authorityRevision: 2 });
    expect(fixture.broker.readAuditForTest().at(-1)).toMatchObject({
      clientId: paired.clientId,
      operation: "client.replace_identity",
      outcome: "success",
      noteRefs: [],
    });
  });

  it("binds a retry to the most recently rotated grant scopes", () => {
    const fixture = brokerFixture();
    const client = p256();
    const replacementClient = p256();
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const replacementInstallIdentity = "22222222-2222-4222-8222-222222222222";
    const secondReplacementInstallIdentity = "33333333-3333-4333-8333-333333333333";
    pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      installIdentity,
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    fixture.broker.revokeClientForRotation(
      fixture.broker.clientRotationTarget("codex", installIdentity),
      replacementInstallIdentity,
    );
    pair(fixture.broker, fixture.owner.privateKey, replacementClient.privateKey, {
      installIdentity: replacementInstallIdentity,
      publicKey: replacementClient.publicKey,
      requestedCapabilities: ["memory.remember"],
      forgetPolicy: "never",
    });
    fixture.broker.revokeClientForRotation(
      fixture.broker.clientRotationTarget("codex", replacementInstallIdentity),
      secondReplacementInstallIdentity,
    );

    expect(fixture.broker.clientRotationTarget("codex", replacementInstallIdentity)).toMatchObject({
      authorityRevision: 2,
      scopes: ["memory.remember"],
    });
  });

  it("fails closed on ambiguous rotation identity or failed terminal audit", () => {
    const fixture = brokerFixture();
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const replacementInstallIdentity = "22222222-2222-4222-8222-222222222222";
    const firstKey = p256();
    const first = pair(fixture.broker, fixture.owner.privateKey, firstKey.privateKey, {
      installIdentity,
      publicKey: firstKey.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const secondKey = p256();
    pair(fixture.broker, fixture.owner.privateKey, secondKey.privateKey, {
      installIdentity,
      publicKey: secondKey.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    expect(() => fixture.broker.clientRotationTarget("codex", installIdentity))
      .toThrow("ambiguous");

    const separate = brokerFixture();
    const onlyKey = p256();
    const only = pair(separate.broker, separate.owner.privateKey, onlyKey.privateKey, {
      installIdentity,
      publicKey: onlyKey.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const database = new SqlcipherDatabase(separate.path, { key: separate.key });
    try {
      database.exec(`
        create trigger reject_client_rotation_audit
        before insert on broker_audit_events
        when new.operation = 'client.rotate_identity'
        begin
          select raise(abort, 'forced rotation audit failure');
        end;
      `);
      const target = separate.broker.clientRotationTarget("codex", installIdentity);
      expect(() => separate.broker.revokeClientForRotation(
        target,
        replacementInstallIdentity,
      ))
        .toThrow("forced rotation audit failure");
      expect(separate.broker.inspectConnections("development-only").clients[0])
        .toMatchObject({ clientId: only.clientId, status: "paired", authorityRevision: 1 });
    } finally {
      database.close();
    }
    expect(first.clientId).toEqual(expect.any(String));
  });

  it("writes a bounded redacted encrypted audit ledger without prohibited canaries", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const prohibited = "QUERY-TEXT-CANARY-7823";
    const body = Buffer.from(JSON.stringify({ query: prohibited }));
    const request = envelope(fixture.broker, activated, "memory.recall", body, session.privateKey);
    const authorization = fixture.broker.authorize(request, body);
    fixture.broker.recordAudit(authorization, "success", [
      { noteId: randomUUID(), revision: 3 },
    ]);

    const ledger = fixture.broker.readAuditForTest().filter(
      (event) => event.operation.startsWith("memory."),
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      clientId: paired.clientId,
      operation: "memory.recall",
      outcome: "success",
    });
    expect(JSON.stringify(ledger)).not.toContain(prohibited);
  });

  it("requires a single-use revision-bound owner decision for confirm-each Forget", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.forget"],
      forgetPolicy: "confirm_each",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const noteId = randomUUID();
    fixture.seedNote(noteId, 4);
    const body = Buffer.from(JSON.stringify({ id: noteId }));
    const direct = envelope(
      fixture.broker,
      activated,
      "memory.forget",
      body,
      session.privateKey,
    );
    expect(() => fixture.broker.authorize(direct, body)).toThrow("owner confirmation");

    const approvedRequest = envelope(
      fixture.broker,
      activated,
      "memory.forget",
      body,
      session.privateKey,
    );
    const decision = fixture.broker.requestForgetDecision(
      approvedRequest,
      body,
    );
    fixture.broker.approveForgetDecision(
      decision.decisionId,
      signature(decision.ownerDecisionTranscript, fixture.owner.privateKey),
    );
    fixture.updateNoteRevision(noteId, 5);
    expect(() => fixture.broker.executeApprovedForget(decision.decisionId))
      .toThrow("revision changed");

    const secondRequest = envelope(
      fixture.broker,
      activated,
      "memory.forget",
      body,
      session.privateKey,
    );
    const second = fixture.broker.requestForgetDecision(secondRequest, body);
    fixture.broker.approveForgetDecision(
      second.decisionId,
      signature(second.ownerDecisionTranscript, fixture.owner.privateKey),
    );
    expect(fixture.broker.executeApprovedForget(second.decisionId)).toBe(true);
    expect(fixture.noteRevision(noteId)).toBeNull();
    expect(() => fixture.broker.executeApprovedForget(second.decisionId))
      .toThrow("no longer available");
  });

  it("atomically expires an untouched Forget decision and its audit intent after two minutes", async () => {
    const fixture = brokerFixture({ expirySweepIntervalMs: 5 });
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.forget"],
      forgetPolicy: "confirm_each",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const noteId = randomUUID();
    fixture.seedNote(noteId, 2);
    const body = Buffer.from(JSON.stringify({ id: noteId }));
    const request = envelope(
      fixture.broker,
      activated,
      "memory.forget",
      body,
      session.privateKey,
    );
    const decision = fixture.broker.requestForgetDecision(request, body);

    fixture.advanceTime(2 * 60 * 1_000 + 1);
    await waitFor(() => fixture.broker.readAuditForTest().some(
      (event) => event.operation === "memory.forget" && event.outcome === "error",
    ));
    expect(fixture.broker.expireForgetDecisions()).toBe(0);
    expect(fixture.broker.readAuditForTest().filter(
      (event) => event.operation === "memory.forget",
    )).toEqual([
      expect.objectContaining({
        eventId: expect.any(String),
        operation: "memory.forget",
        outcome: "error",
        errorCode: "forget_decision_expired",
      }),
    ]);
    expect(() => fixture.broker.approveForgetDecision(
      decision.decisionId,
      signature(decision.ownerDecisionTranscript, fixture.owner.privateKey),
    )).toThrow("expired");
    expect(fixture.noteRevision(noteId)).toBe(2);
  });

  it("terminalizes a Forget decision when its approved session is revoked", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.forget"],
      forgetPolicy: "confirm_each",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const noteId = randomUUID();
    fixture.seedNote(noteId, 3);
    const body = Buffer.from(JSON.stringify({ id: noteId }));
    const request = envelope(
      fixture.broker,
      activated,
      "memory.forget",
      body,
      session.privateKey,
    );
    const decision = fixture.broker.requestForgetDecision(request, body);
    fixture.broker.approveForgetDecision(
      decision.decisionId,
      signature(decision.ownerDecisionTranscript, fixture.owner.privateKey),
    );

    fixture.broker.revokeClient(paired.clientId);
    expect(() => fixture.broker.executeApprovedForget(decision.decisionId))
      .toThrow("revoked");
    expect(fixture.broker.readAuditForTest().filter(
      (event) => event.operation === "memory.forget",
    )).toEqual([
      expect.objectContaining({
        operation: "memory.forget",
        outcome: "error",
        errorCode: "forget_session_inactive",
      }),
    ]);
    fixture.advanceTime(2 * 60 * 1_000 + 1);
    expect(fixture.broker.expireForgetDecisions()).toBe(0);
    expect(fixture.noteRevision(noteId)).toBe(3);
  });

  it("rolls back a broker-owned mutation when its success audit cannot commit", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
    );
    const noteId = randomUUID();
    const body = Buffer.from(JSON.stringify({ content: "mutation audit canary" }));
    const request = envelope(
      fixture.broker,
      activated,
      "memory.remember",
      body,
      session.privateKey,
    );

    expect(() => fixture.broker.executeAuthorizedMutation(request, body, (database) => {
      database.query("insert into notes (id, current_revision) values (?, 1)").run(noteId);
      return {
        result: true,
        noteRefs: [{ noteId: "invalid note id with spaces", revision: 1 }],
      };
    })).toThrow("note ID is invalid");
    expect(fixture.noteRevision(noteId)).toBeNull();
    expect(fixture.broker.readAuditForTest().at(-1)).toMatchObject({
      operation: "memory.remember",
      outcome: "error",
      errorCode: "operation_failed",
    });
  });

  it("prunes audit only through a current-boot single-use owner decision", () => {
    const fixture = brokerFixture();
    fixture.seedAuditEvents(10_001, "2020-01-01T00:00:00.000Z");
    const requested = fixture.broker.requestAuditPrune();
    expect(() => fixture.broker.approveAndPruneAudit(
      requested.decisionId,
      signature(`${requested.ownerDecisionTranscript}-edited`, fixture.owner.privateKey),
    )).toThrow("owner signature");

    const restarted = fixture.reopen("new-boot");
    expect(() => restarted.approveAndPruneAudit(
      requested.decisionId,
      signature(requested.ownerDecisionTranscript, fixture.owner.privateKey),
    )).toThrow("another broker boot");
    restarted.close();

    expect(fixture.broker.approveAndPruneAudit(
      requested.decisionId,
      signature(requested.ownerDecisionTranscript, fixture.owner.privateKey),
    )).toBe(1);
    expect(fixture.broker.readAuditForTest()).toHaveLength(10_001);
    expect(fixture.broker.readAuditForTest().at(-1)).toMatchObject({
      clientId: "owner",
      operation: "audit.prune",
      outcome: "success",
    });
    expect(() => fixture.broker.approveAndPruneAudit(
      requested.decisionId,
      signature(requested.ownerDecisionTranscript, fixture.owner.privateKey),
    )).toThrow("no longer available");
  });

  it("returns bounded owner connection views without stored signing material", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      {
        kind: "claude",
        displayName: "Claude Code",
        publicKey: client.publicKey,
        requestedCapabilities: ["memory.remember", "memory.recall"],
        forgetPolicy: "never",
      },
    );
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
      ["memory.remember", "memory.recall"],
    );

    const view = fixture.broker.inspectConnections("development-only");
    expect(view.clients).toEqual([
      expect.objectContaining({
        clientId: paired.clientId,
        kind: "claude",
        displayLabel: "Claude Code",
        status: "active",
        trust: "development-only",
        authorityRevision: 1,
      }),
    ]);
    expect(view.grants).toEqual([
      expect.objectContaining({
        grantId: paired.grantId,
        clientId: paired.clientId,
        scopes: ["memory.remember", "memory.recall"],
        status: "active",
      }),
    ]);
    expect(view.sessions).toEqual([
      expect.objectContaining({
        sessionId: activated.sessionId,
        clientId: paired.clientId,
        grantId: paired.grantId,
        status: "active",
      }),
    ]);
    const decoded = JSON.stringify(view);
    expect(decoded).not.toContain("untrusted label with a secret canary");
    expect(decoded).not.toContain("PUBLIC KEY");
    expect(decoded).not.toContain("transport_connection");
    expect(decoded).not.toContain(String(process.pid));
  });

  it("builds the passive connector overview linearly across 10,000 audit events", () => {
    const fixture = brokerFixture();
    const client = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      kind: "claude-desktop",
      displayName: "Claude Desktop",
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember", "memory.recall"],
      forgetPolicy: "never",
    });
    fixture.seedConnectorAuditEvents(paired.clientId, 10_000);

    const startedAt = performance.now();
    const overview = fixture.broker.connectorOverview("development-only");
    const elapsedMs = performance.now() - startedAt;

    expect(overview).toEqual({
      connectors: [expect.objectContaining({
        kind: "claude-desktop",
        status: "paired",
        savedCount: 5_000,
        readCount: 5_000,
        verifiedRoundTrip: true,
      })],
    });
    expect(fixture.broker.connectorAuditDiagnostics("development-only"))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "claude-desktop",
        operations: expect.objectContaining({
          remember: expect.objectContaining({ success: 5_000 }),
          recall: expect.objectContaining({ success: 5_000 }),
        }),
      })]));
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it("delegates audit history while retaining the broker lifetime guard", () => {
    const fixture = brokerFixture();
    fixture.seedAuditEvents(5, "2026-08-28T12:00:00.000Z");

    const first = fixture.broker.inspectAudit({ pageSize: 2 });
    expect(first.events.map((event) => event.eventId)).toEqual(["seed-00004", "seed-00003"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = fixture.broker.inspectAudit({
      pageSize: 2,
      cursor: first.nextCursor!,
    });
    expect(second.events.map((event) => event.eventId)).toEqual(["seed-00002", "seed-00001"]);
    fixture.broker.close();
    expect(() => fixture.broker.inspectAudit({ cursor: second.nextCursor! }))
      .toThrow("Vault broker is closed");
  });

  it("keeps every displayed client's revocation scopes and session summary complete", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember", "memory.recall"],
      forgetPolicy: "never",
    });
    activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
      ["memory.remember", "memory.recall"],
    );
    const history = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    try {
      const insertGrant = history.query(`
        insert into broker_grants (
          id, client_id, capabilities, forget_policy, status, created_at,
          expires_at, revoked_at
        ) values (?, ?, '["memory.recall"]', 'never', 'revoked', ?, null, ?)
      `);
      const insertSession = history.query(`
        insert into broker_sessions (
          id, vault_id, broker_boot_id, client_id, grant_id, session_public_key,
          capabilities, forget_policy, nonce, status, activated_at,
          decision_expires_at, expires_at, last_seen_at,
          transport_connection_id, transport_peer_pid
        ) values (?, ?, 'old-boot', ?, ?, ?, '["memory.recall"]', 'never', '',
          'disconnected', ?, ?, ?, ?, null, null)
      `);
      history.transaction(() => {
        for (let index = 0; index < 300; index += 1) {
          const timestamp = new Date(Date.now() + index + 1_000).toISOString();
          const grantId = randomUUID();
          insertGrant.run(grantId, paired.clientId, timestamp, timestamp);
          insertSession.run(
            randomUUID(),
            vaultId,
            paired.clientId,
            grantId,
            client.publicKey,
            timestamp,
            timestamp,
            timestamp,
            timestamp,
          );
        }
      })();
      insertGrant.close();
      insertSession.close();
    } finally {
      history.close();
    }

    const clientView = fixture.broker.inspectConnections("development-only").clients[0];
    expect(clientView).toMatchObject({
      clientId: paired.clientId,
      activeScopes: ["memory.remember", "memory.recall"],
      sessionSummary: {
        activeCount: 1,
        latestStatus: "disconnected",
      },
    });
  });

  it("expires elapsed daily trusted work before presenting owner connection state", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
      ["memory.recall"],
    );

    fixture.advanceTime(24 * 60 * 60 * 1_000 + 1);

    expect(fixture.broker.inspectConnections("development-only")).toMatchObject({
      clients: [{
        clientId: paired.clientId,
        status: "paired",
        sessionSummary: { activeCount: 0, latestStatus: "expired" },
      }],
      sessions: [{ sessionId: activated.sessionId, status: "expired" }],
    });
    expect(fixture.broker.readAuditForTest()).toContainEqual(expect.objectContaining({
      sessionId: activated.sessionId,
      operation: "session.expire",
      outcome: "success",
      errorCode: "work_session_expired",
    }));
  });

  it("preserves owner-approved trusted work across a broker process restart", () => {
    const fixture = brokerFixture();
    const client = p256();
    const firstSession = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      kind: "claude-desktop",
      displayName: "Claude Desktop",
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
      forgetPolicy: "never",
    });
    const firstActivated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      firstSession.privateKey,
      firstSession.publicKey,
      paired,
      ["memory.remember", "memory.recall", "memory.get_note"],
    );
    const oldBody = Buffer.from(JSON.stringify({ query: "old connection", limit: 5 }));
    const oldEnvelope = envelope(
      fixture.broker,
      firstActivated,
      "memory.recall",
      oldBody,
      firstSession.privateKey,
    );
    fixture.broker.close();

    const restarted = fixture.reopen("boot-two");
    const secondSession = p256();
    const requested = restarted.requestActivation({
      ...paired,
      sessionPublicKey: secondSession.publicKey,
      requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
      ttlMs: 15 * 60 * 1_000,
    });

    expect(restarted.canSilentlyActivateTrustedMcp(requested.activationId)).toBe(true);
    expect(restarted.approveTrustedMcpActivation({
      activationId: requested.activationId,
      clientSignature: signature(requested.clientProofTranscript, client.privateKey),
      sessionSignature: signature(requested.sessionProofTranscript, secondSession.privateKey),
    })).toMatchObject({ ...paired });
    expect(() => restarted.authorize(oldEnvelope, oldBody)).toThrow("Broker boot");

    restarted.invalidateEphemeralAuthorityForLock();
    restarted.close();
    const afterLock = fixture.reopen("boot-three");
    const afterLockSession = p256();
    const afterLockActivation = afterLock.requestActivation({
      ...paired,
      sessionPublicKey: afterLockSession.publicKey,
      requestedCapabilities: ["memory.recall"],
      ttlMs: 15 * 60 * 1_000,
    });
    expect(afterLock.canSilentlyActivateTrustedMcp(afterLockActivation.activationId))
      .toBe(false);
  });

  it("rolls back silent activation when persisted work-session touch fails", () => {
    const fixture = brokerFixture();
    const client = p256();
    const firstSession = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      kind: "claude-desktop",
      displayName: "Claude Desktop",
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      firstSession.privateKey,
      firstSession.publicKey,
      paired,
      ["memory.recall"],
    );
    fixture.advanceTime(1);
    const secondSession = p256();
    const requested = fixture.broker.requestActivation({
      ...paired,
      sessionPublicKey: secondSession.publicKey,
      requestedCapabilities: ["memory.recall"],
      ttlMs: 15 * 60 * 1_000,
    });
    const database = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    database.exec(`
      create trigger reject_work_session_touch
      before update on broker_trusted_work_sessions
      when new.last_activity_at <> old.last_activity_at
      begin
        select raise(abort, 'injected work-session touch failure');
      end;
    `);
    database.close();

    expect(() => fixture.broker.approveTrustedMcpActivation({
      activationId: requested.activationId,
      clientSignature: signature(requested.clientProofTranscript, client.privateKey),
      sessionSignature: signature(requested.sessionProofTranscript, secondSession.privateKey),
    })).toThrow("work-session touch failure");

    const verification = new SqlcipherDatabase(fixture.path, {
      key: fixture.key,
      readonly: true,
    });
    expect(verification.query<{ status: string }, [string]>(
      "select status from broker_sessions where id = ?",
    ).get(requested.activationId)?.status).toBe("pending");
    verification.close();
    expect(fixture.broker.readAuditForTest()).not.toContainEqual(
      expect.objectContaining({
        sessionId: requested.activationId,
        operation: "session.activate",
        outcome: "success",
      }),
    );
  });

  it("rejects expired, clock-rolled-back, malformed, and policy-stale persisted work", () => {
    const cases = [
      {
        name: "expired",
        configure: (_broker: VaultBrokerAuthorization) => {},
        times: (now: number) => ({
          startedAt: now - 24 * 60 * 60 * 1_000,
          expiresAt: now - 1,
          lastActivityAt: now - 60_000,
          lastObservedAt: now - 60_000,
        }),
        id: randomUUID(),
      },
      {
        name: "clock rollback",
        configure: (_broker: VaultBrokerAuthorization) => {},
        times: (now: number) => ({
          startedAt: now - 60_000,
          expiresAt: now + 60 * 60 * 1_000,
          lastActivityAt: now - 30_000,
          lastObservedAt: now + 1,
        }),
        id: randomUUID(),
      },
      {
        name: "malformed identifier",
        configure: (_broker: VaultBrokerAuthorization) => {},
        times: (now: number) => ({
          startedAt: now - 60_000,
          expiresAt: now + 60 * 60 * 1_000,
          lastActivityAt: now - 30_000,
          lastObservedAt: now,
        }),
        id: "not a valid identifier",
      },
      {
        name: "changed policy",
        configure: (broker: VaultBrokerAuthorization) => {
          broker.configureRoutineAuthentication(4 * 60 * 60 * 1_000);
        },
        times: (now: number) => ({
          startedAt: now - 60_000,
          expiresAt: now + 23 * 60 * 60 * 1_000,
          lastActivityAt: now - 30_000,
          lastObservedAt: now,
        }),
        id: randomUUID(),
      },
    ];
    for (const testCase of cases) {
      const fixture = brokerFixture();
      testCase.configure(fixture.broker);
      fixture.broker.close();
      const database = new SqlcipherDatabase(fixture.path, { key: fixture.key });
      const times = testCase.times(fixture.now());
      database.query(`
        insert into broker_trusted_work_sessions (
          vault_id, id, started_at, expires_at, last_activity_at, last_observed_at
        ) values (?, ?, ?, ?, ?, ?)
      `).run(
        vaultId,
        testCase.id,
        times.startedAt,
        times.expiresAt,
        times.lastActivityAt,
        times.lastObservedAt,
      );
      database.close();

      fixture.reopen(`reopen-${testCase.name}`);
      expect(fixture.workSessionCount(), testCase.name).toBe(0);
    }
  });

  it("persists the user-selected routine authentication window", () => {
    const fixture = brokerFixture();
    expect(fixture.broker.routineAuthenticationTtlMilliseconds()).toBe(
      24 * 60 * 60 * 1_000,
    );

    fixture.broker.configureRoutineAuthentication(4 * 60 * 60 * 1_000);
    expect(fixture.broker.routineAuthenticationTtlMilliseconds()).toBe(
      4 * 60 * 60 * 1_000,
    );
    expect(fixture.reopen("boot-two").routineAuthenticationTtlMilliseconds()).toBe(
      4 * 60 * 60 * 1_000,
    );
    expect(() => fixture.broker.configureRoutineAuthentication(60_000)).toThrow(
      "Routine authentication window is invalid",
    );
  });

  it("revokes the exact displayed client atomically with its audit record", () => {
    const fixture = brokerFixture();
    const client = p256();
    const session = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.remember"],
      forgetPolicy: "never",
    });
    const activated = activate(
      fixture.broker,
      fixture.owner.privateKey,
      client.privateKey,
      session.privateKey,
      session.publicKey,
      paired,
      ["memory.remember"],
    );
    const target = fixture.broker.revocationTarget(paired.clientId);
    expect(target).toMatchObject({
      clientId: paired.clientId,
      kind: "codex",
      displayLabel: "Codex",
      authorityRevision: 1,
    });
    expect(() => fixture.broker.revokeClient({
      ...target,
      displayLabel: "Claude Code",
    })).toThrow("changed");

    fixture.broker.revokeClient(target);
    expect(fixture.broker.inspectConnections("development-only")).toMatchObject({
      clients: [{ clientId: paired.clientId, status: "revoked", authorityRevision: 2 }],
      grants: [{ grantId: paired.grantId, status: "revoked" }],
      sessions: [{ sessionId: activated.sessionId, status: "revoked" }],
    });
    expect(fixture.broker.readAuditForTest().at(-1)).toMatchObject({
      clientId: paired.clientId,
      operation: "client.revoke",
      outcome: "success",
    });
  });

  it("leaves a client live when the revocation audit record cannot commit", () => {
    const fixture = brokerFixture();
    const client = p256();
    const paired = pair(fixture.broker, fixture.owner.privateKey, client.privateKey, {
      publicKey: client.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    try {
      inspection.exec(`
        create trigger reject_revocation_audit
        before insert on broker_audit_events
        when new.operation = 'client.revoke'
        begin
          select raise(abort, 'forced revocation audit failure');
        end;
      `);
      const target = fixture.broker.revocationTarget(paired.clientId);
      expect(() => fixture.broker.revokeClient(target)).toThrow("forced revocation audit failure");
      expect(fixture.broker.inspectConnections("development-only").clients[0]).toMatchObject({
        clientId: paired.clientId,
        status: "paired",
        authorityRevision: 1,
      });
    } finally {
      inspection.close();
    }
  });

  it("rolls back connector revocation if any hidden identity cannot be audited", () => {
    const fixture = brokerFixture();
    const firstClient = p256();
    const secondClient = p256();
    const first = pair(fixture.broker, fixture.owner.privateKey, firstClient.privateKey, {
      publicKey: firstClient.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const second = pair(fixture.broker, fixture.owner.privateKey, secondClient.privateKey, {
      publicKey: secondClient.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const target = fixture.broker.connectorRevocationTarget("codex");
    expect(target.clients.map((client) => client.clientId).sort())
      .toEqual([first.clientId, second.clientId].sort());

    const inspection = new SqlcipherDatabase(fixture.path, { key: fixture.key });
    try {
      inspection.exec(`
        create trigger reject_second_connector_revocation_audit
        before insert on broker_audit_events
        when new.operation = 'client.revoke' and new.client_id = '${second.clientId}'
        begin
          select raise(abort, 'forced connector revocation audit failure');
        end;
      `);
      expect(() => fixture.broker.revokeConnector(target))
        .toThrow("forced connector revocation audit failure");
      expect(fixture.broker.inspectConnections("development-only").clients)
        .toEqual([
          expect.objectContaining({ status: "paired", authorityRevision: 1 }),
          expect.objectContaining({ status: "paired", authorityRevision: 1 }),
        ]);
    } finally {
      inspection.close();
    }
  });

  it("refuses connector revocation when its hidden identity set changes after approval", () => {
    const fixture = brokerFixture();
    const firstClient = p256();
    pair(fixture.broker, fixture.owner.privateKey, firstClient.privateKey, {
      publicKey: firstClient.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });
    const approved = fixture.broker.connectorRevocationTarget("codex");

    const lateClient = p256();
    pair(fixture.broker, fixture.owner.privateKey, lateClient.privateKey, {
      publicKey: lateClient.publicKey,
      requestedCapabilities: ["memory.recall"],
      forgetPolicy: "never",
    });

    expect(() => fixture.broker.revokeConnector(approved)).toThrow(
      "Connector revocation target changed before commit",
    );
    expect(fixture.broker.inspectConnections("development-only").clients)
      .toEqual([
        expect.objectContaining({ status: "paired", authorityRevision: 1 }),
        expect.objectContaining({ status: "paired", authorityRevision: 1 }),
      ]);
  });
});

function brokerFixture(options: { expirySweepIntervalMs?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "afternote-broker-"));
  directories.push(directory);
  const key = randomBytes(32);
  const owner = p256();
  const path = join(directory, "broker.db");
  let now = Date.now();
  const seed = new SqlcipherDatabase(path, { key });
  seed.exec("create table notes (id text primary key, current_revision integer not null)");
  seed.close();
  const broker = new VaultBrokerAuthorization({
    path,
    key,
    vaultId,
    bootId: "boot-one",
    ownerPublicKey: owner.publicKey,
    now: () => now,
    expirySweepIntervalMs: options.expirySweepIntervalMs,
  });
  brokers.push(broker);
  return {
    broker,
    owner,
    advanceTime(milliseconds: number) {
      now += milliseconds;
    },
    now() {
      return now;
    },
    seedNote(noteId: string, revision: number) {
      const database = new SqlcipherDatabase(path, { key });
      database.query("insert into notes (id, current_revision) values (?, ?)").run(noteId, revision);
      database.close();
    },
    updateNoteRevision(noteId: string, revision: number) {
      const database = new SqlcipherDatabase(path, { key });
      database.query("update notes set current_revision = ? where id = ?").run(revision, noteId);
      database.close();
    },
    noteRevision(noteId: string): number | null {
      const database = new SqlcipherDatabase(path, { key, readonly: true });
      const revision = database.query<{ current_revision: number }, [string]>(
        "select current_revision from notes where id = ?",
      ).get(noteId)?.current_revision ?? null;
      database.close();
      return revision;
    },
    replayCount(): number {
      const database = new SqlcipherDatabase(path, { key, readonly: true });
      const count = database.query<{ count: number }, []>(
        "select count(*) as count from broker_request_replays",
      ).get()?.count ?? 0;
      database.close();
      return count;
    },
    workSessionCount(): number {
      const database = new SqlcipherDatabase(path, { key, readonly: true });
      const count = database.query<{ count: number }, []>(
        "select count(*) as count from broker_trusted_work_sessions",
      ).get()?.count ?? 0;
      database.close();
      return count;
    },
    path,
    key,
    seedAuditEvents(count: number, occurredAt: string, prefix = "seed") {
      const database = new SqlcipherDatabase(path, { key });
      const insert = database.query(`
        insert into broker_audit_events (
          event_id, occurred_at, client_id, grant_id, session_id, operation,
          outcome, error_code, note_refs
        ) values (?, ?, 'seed-client', null, null, 'memory.recall', 'success', null, '[]')
      `);
      database.transaction(() => {
        for (let index = 0; index < count; index += 1) {
          insert.run(`${prefix}-${index.toString().padStart(5, "0")}`, occurredAt);
        }
      })();
      insert.close();
      database.close();
    },
    seedConnectorAuditEvents(clientId: string, count: number) {
      const database = new SqlcipherDatabase(path, { key });
      const insert = database.query(`
        insert into broker_audit_events (
          event_id, occurred_at, client_id, grant_id, session_id, operation,
          outcome, error_code, note_refs
        ) values (?, ?, ?, null, null, ?, 'success', null, ?)
      `);
      database.transaction(() => {
        for (let index = 0; index < count; index += 1) {
          const pairIndex = Math.floor(index / 2);
          insert.run(
            `connector-${index.toString().padStart(5, "0")}`,
            new Date(now + index).toISOString(),
            clientId,
            index % 2 === 0 ? "memory.remember" : "memory.recall",
            JSON.stringify([{
              noteId: `note-${pairIndex.toString().padStart(5, "0")}`,
              revision: 1,
            }]),
          );
        }
      })();
      insert.close();
      database.close();
    },
    reopen(bootId: string) {
      const reopened = new VaultBrokerAuthorization({
        path,
        key,
        vaultId,
        bootId,
        ownerPublicKey: owner.publicKey,
        now: () => now,
      });
      brokers.push(reopened);
      return reopened;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for broker state");
    await Bun.sleep(5);
  }
}

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

function pair(
  broker: VaultBrokerAuthorization,
  ownerPrivateKey: string,
  clientPrivateKey: string,
  overrides: Partial<Parameters<VaultBrokerAuthorization["requestPairing"]>[0]> & {
    publicKey: string;
    requestedCapabilities: Parameters<VaultBrokerAuthorization["requestPairing"]>[0]["requestedCapabilities"];
    forgetPolicy: Parameters<VaultBrokerAuthorization["requestPairing"]>[0]["forgetPolicy"];
  },
) {
  const requested = broker.requestPairing({
    kind: "codex",
    displayName: "Codex",
    installIdentity: randomUUID(),
    signingMode: "development-exact-build",
    ...overrides,
  });
  broker.approvePairing(
    requested.requestId,
    signature(requested.ownerDecisionTranscript, ownerPrivateKey),
  );
  return broker.exchangePairing(
    requested.requestId,
    signature(requested.clientProofTranscript, clientPrivateKey),
  );
}

function activate(
  broker: VaultBrokerAuthorization,
  ownerPrivateKey: string,
  clientPrivateKey: string,
  sessionPrivateKey: string,
  sessionPublicKey: string,
  paired: { clientId: string; grantId: string },
  requestedCapabilities: BrokerCapability[] = [
    "memory.remember",
    "memory.recall",
    "memory.get_note",
    "memory.forget",
  ],
) {
  const requested = broker.requestActivation({
    ...paired,
    sessionPublicKey,
    requestedCapabilities,
    ttlMs: 15 * 60 * 1_000,
  });
  return broker.approveActivation({
    activationId: requested.activationId,
    ownerSignature: signature(requested.ownerDecisionTranscript, ownerPrivateKey),
    clientSignature: signature(requested.clientProofTranscript, clientPrivateKey),
    sessionSignature: signature(requested.sessionProofTranscript, sessionPrivateKey),
  });
}

function envelope(
  broker: VaultBrokerAuthorization,
  session: { sessionId: string; clientId: string; grantId: string },
  operation: string,
  body: Uint8Array,
  privateKey: string,
  override: Partial<BrokerRequestEnvelope> = {},
): BrokerRequestEnvelope {
  const unsigned = broker.unsignedEnvelope({
    ...session,
    operation,
    body,
    requestId: randomBytes(16).toString("hex"),
    ...override,
  });
  return {
    ...unsigned,
    signature: signature(canonicalBrokerTranscript(unsigned), privateKey),
  };
}

function signature(transcript: string, privateKey: string): string {
  return sign("sha256", Buffer.from(transcript), privateKey).toString("base64url");
}
