/* eslint-disable @typescript-eslint/no-explicit-any -- public protocol fixtures decode JSON */
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import type { VaultContext } from "@afternote/memory";
import { VaultBrokerWorker } from "./vault-broker-worker";

const directories: string[] = [];
const workers: VaultBrokerWorker[] = [];
const replacementInstallIdentity = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["codex", "claude", "claude-desktop"] as const)(
  "%s reconnect requires separate approval and never revives the old identity", async (kind) => {
  const { worker, ownerConnection, clientConnection, installIdentity, paired } =
    await revokedFixture(kind);
  const params = { kind, installIdentity, replacementInstallIdentity };
  await expect(pairMcpClient(worker, clientConnection, kind, replacementInstallIdentity))
    .rejects.toThrow("requires explicit reconnect preparation");
  const pending = await beginOwnerRequest(worker, ownerConnection, "admin.prepare_connector_reconnect", params);
  expect(pending.ownerPresenceChallenge).toBeDefined();
  expect(pending.ownerPresenceChallenge.reason).toContain("remain revoked");
  // An existing owner inspection session is not reconnect approval.
  await expect(pairMcpClient(worker, clientConnection, kind, replacementInstallIdentity))
    .rejects.toThrow("requires explicit reconnect preparation");
  expect(await completeOwnerPresence(worker, ownerConnection,
    pending.ownerPresenceChallenge.challengeId, "approved")).toMatchObject({
    ok: true, result: { prepared: true, ...params, clientId: paired.clientId },
  });
  expect(await completeOwnerPresence(worker, ownerConnection,
    pending.ownerPresenceChallenge.challengeId, "approved")).toMatchObject({ ok: false });
  await expect(pairMcpClient(worker, clientConnection, kind, randomUUID()))
    .rejects.toThrow("requires explicit reconnect preparation");
  const replacement = await pairMcpClient(worker, clientConnection, kind, replacementInstallIdentity);
  expect(replacement.clientId).not.toBe(paired.clientId);
  const inspected = await ownerRequest(worker, ownerConnection, "owner.inspect_connections", {});
  expect(inspected.clients.find((client: any) => client.clientId === paired.clientId).status).toBe("revoked");
  expect(inspected.grants.filter((grant: any) => grant.clientId === paired.clientId)
    .every((grant: any) => grant.status === "revoked")).toBe(true);
  // A historical revocation must not authorize replacing an already reconnected connector.
  expect(await beginOwnerRequest(worker, ownerConnection, "admin.prepare_connector_reconnect", {
    ...params, replacementInstallIdentity: randomUUID(),
  })).toMatchObject({ ok: false });
});

it.each(["denied", "cancelled", "unavailable", "timed_out"] as const)(
  "%s approval leaves the connector revoked", async (outcome) => {
  const { worker, ownerConnection, clientConnection, installIdentity } = await revokedFixture("codex");
  const pending = await beginOwnerRequest(worker, ownerConnection, "admin.prepare_connector_reconnect",
    { kind: "codex", installIdentity, replacementInstallIdentity });
  expect(pending.ownerPresenceChallenge).toBeDefined();
  expect(await completeOwnerPresence(worker, ownerConnection,
    pending.ownerPresenceChallenge.challengeId, outcome)).toMatchObject({ ok: false });
  await expect(pairMcpClient(worker, clientConnection, "codex", replacementInstallIdentity))
    .rejects.toThrow("requires explicit reconnect preparation");
});

it("rejects connector-role requests and approval from another connection", async () => {
  const { worker, ownerConnection, clientConnection, installIdentity } = await revokedFixture("codex");
  const params = { kind: "codex", installIdentity, replacementInstallIdentity };
  expect(await rawRequest(worker, clientConnection, "memory-client",
    "admin.prepare_connector_reconnect", params)).toMatchObject({
    ok: false, error: { code: "identity_mismatch" },
  });
  const pending = await beginOwnerRequest(worker, ownerConnection, "admin.prepare_connector_reconnect", params);
  expect(await completeOwnerPresence(worker, { connectionId: randomUUID(), peerPid: 52199 },
    pending.ownerPresenceChallenge.challengeId, "approved")).toMatchObject({
    ok: false, error: { code: "identity_mismatch" },
  });
  await expect(pairMcpClient(worker, clientConnection, "codex", replacementInstallIdentity))
    .rejects.toThrow("requires explicit reconnect preparation");
});

async function revokedFixture(kind: "codex" | "claude" | "claude-desktop") {
  const fixture = workerFixture({ trustPath: "production-signed" });
  const clientConnection = { connectionId: randomUUID(), peerPid: 52021 };
  const ownerConnection = { connectionId: randomUUID(), peerPid: 52022 };
  const installIdentity = "11111111-1111-4111-8111-111111111111";
  const paired = await pairMcpClient(fixture.worker, clientConnection, kind, installIdentity);
  await ownerRequest(fixture.worker, ownerConnection, "owner.session.begin", {
    requestedScopes: ["owner.inspect_clients", "owner.inspect_grants", "owner.inspect_sessions"],
    ttlMs: 60000,
  }, true);
  const revoked = await ownerRequest(fixture.worker, ownerConnection, "owner.revoke_connector", {
    kind,
  }, true);
  expect(revoked.clientIds).toContain(paired.clientId);
  return { ...fixture, paired, clientConnection, ownerConnection, installIdentity };
}
function workerFixture(options: {
  trustPath?: "development-only" | "production-signed";
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "afternote-admin-worker-"));
  directories.push(directory);
  const path = join(directory, "vault.db");
  const key = randomBytes(32);
  const vault: VaultContext = { vaultId: "7".repeat(64), deployment: "local" };
  const worker = new VaultBrokerWorker({
    applicationVersion: "2.0.0-admin-test",
    standalone: true,
    vaultPath: path,
    vaultKey: key,
    vault,
    bootId: "8a8cb901-b5d5-4ca0-a2e4-27420210316c",
    trustPath: options.trustPath,
  });
  workers.push(worker);
  return { worker, directory, path, key, vault };
}

async function pairMcpClient(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  kind: "codex" | "claude" | "claude-desktop",
  installIdentity: string,
) {
  const durable = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const begun = await rawRequest(worker, connection, "memory-client", "client.begin", {
    kind,
    displayName: kind === "codex"
      ? "Codex"
      : kind === "claude"
      ? "Claude Code"
      : "Claude Desktop",
    installIdentity,
    publicKey: durable.publicKey,
    signingMode: "secure-enclave",
    requestedCapabilities: ["memory.remember", "memory.recall", "memory.get_note"],
    forgetPolicy: "never",
  });
  if (!begun.ok) throw new Error(begun.error.message);
  const paired = await rawRequest(
    worker,
    connection,
    "memory-client",
    "client.complete_pairing",
    {
      requestId: begun.result.requestId,
      clientSignature: sign(
        "sha256",
        Buffer.from(begun.result.clientProofTranscript),
        durable.privateKey,
      ).toString("base64url"),
    },
    true,
  );
  if (!paired.ok) throw new Error(paired.error.message);
  return paired.result;
}

async function ownerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
  approve?: true,
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
  approve?: true,
): Promise<any> {
  return rawRequest(worker, connection, "owner-control", method, params, approve);
}

async function rawRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  peerRole: "owner-control" | "memory-client" | "browser-client",
  method: string,
  params: Record<string, unknown>,
  approve?: true,
): Promise<any> {
  const first = await beginRequest(worker, connection, peerRole, method, params);
  if (!approve || !first.ownerPresenceChallenge) return first;
  return completeOwnerPresence(
    worker,
    connection,
    first.ownerPresenceChallenge.challengeId,
    "approved",
    peerRole,
  );
}

async function beginOwnerRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  method: string,
  params: Record<string, unknown>,
) {
  return beginRequest(worker, connection, "owner-control", method, params);
}

async function beginRequest(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  peerRole: "owner-control" | "memory-client" | "browser-client",
  method: string,
  params: Record<string, unknown>,
) {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "client",
    peerRole,
    ...connection,
    payload: { protocolVersion: 1, requestId: randomUUID(), method, params },
  })));
}

async function completeOwnerPresence(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  challengeId: string,
  outcome: "approved" | "denied" | "cancelled" | "timed_out" | "unavailable",
  peerRole: "owner-control" | "memory-client" | "browser-client" = "owner-control",
) {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "owner-presence",
    peerRole,
    ...connection,
    payload: {
      challengeId,
      approved: outcome === "approved",
      outcome,
    },
  })));
}
