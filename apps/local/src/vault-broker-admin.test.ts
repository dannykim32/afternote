import { nextOwnerSequence } from "./owner-request-test-support";
/* eslint-disable @typescript-eslint/no-explicit-any -- public protocol fixtures decode JSON */
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
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

describe("native owner administration broker protocol", () => {
  it("requires separate fresh Owner presence for a Connector's Archive permission", async () => {
    const { worker } = workerFixture();
    const client = { connectionId: randomUUID(), peerPid: 52901 };
    const owner = { connectionId: randomUUID(), peerPid: 52902 };
    await pairMcpClient(worker, client, "claude-desktop", randomUUID());
    const params = { kind: "claude-desktop" };
    expect((await rawRequest(worker, client, "memory-client", "admin.approve_archive_access", params)).ok).toBe(false);
    const denied = await beginOwnerRequest(worker, owner, "admin.approve_archive_access", params);
    expect(denied.ownerPresenceChallenge.reason).toContain("Allow Claude Desktop to search and read Conversation Archives");
    await completeOwnerPresence(worker, owner, denied.ownerPresenceChallenge.challengeId, "denied");
    const before = await ownerRequest(worker, owner, "owner.connector_overview", {});
    expect(before.connectors.find((c: any) => c.kind === "claude-desktop").activeScopes).not.toContain("archive.read");
    expect(await ownerRequest(worker, owner, "admin.approve_archive_access", params, true))
      .toEqual({ approved: true, kind: "claude-desktop" });
    const after = await ownerRequest(worker, owner, "owner.connector_overview", {});
    expect(after.connectors.find((c: any) => c.kind === "claude-desktop").activeScopes).toContain("archive.read");
  });

  it("prepares an exact development MCP identity under fresh owner presence", async () => {
    const fixture = workerFixture();
    const clientConnection = { connectionId: randomUUID(), peerPid: 52001 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 52002 };
    const otherOwner = { connectionId: randomUUID(), peerPid: 52003 };
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const paired = await pairMcpClient(
      fixture.worker,
      clientConnection,
      "codex",
      installIdentity,
    );
    const params = { kind: "codex", installIdentity, replacementInstallIdentity };

    expect(await rawRequest(
      fixture.worker,
      clientConnection,
      "memory-client",
      "admin.prepare_client_rotation",
      params,
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });

    const pending = await beginOwnerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      params,
    );
    expect(pending.ownerPresenceChallenge.reason).toContain(
      `Rotate Codex (codex) identity for installation ${installIdentity}`,
    );
    expect(pending.ownerPresenceChallenge.reason).toContain("Remember, Recall, Get");
    expect(await completeOwnerPresence(
      fixture.worker,
      otherOwner,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(await completeOwnerPresence(
      fixture.worker,
      ownerConnection,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });

    const prepared = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      params,
      true,
    );
    expect(prepared).toEqual({
      prepared: true,
      kind: "codex",
      installIdentity,
      replacementInstallIdentity,
      clientId: paired.clientId,
    });

    const retryPending = await beginOwnerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      params,
    );
    expect(await completeOwnerPresence(
      fixture.worker,
      otherOwner,
      retryPending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(await completeOwnerPresence(
      fixture.worker,
      ownerConnection,
      retryPending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });
    expect(await ownerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      params,
      true,
    )).toEqual(prepared);

    await ownerRequest(fixture.worker, ownerConnection, "owner.session.begin", {
      requestedScopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
        "owner.inspect_audit",
      ],
      ttlMs: 60_000,
    }, true);
    const connections = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    expect(connections).toMatchObject({
      clients: [{ clientId: paired.clientId, status: "revoked", authorityRevision: 2 }],
      grants: [{ clientId: paired.clientId, status: "revoked" }],
    });
    const audit = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_audit",
      { cursor: null, pageSize: 100 },
    );
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clientId: paired.clientId,
        operation: "client.rotate_identity",
        outcome: "success",
        noteRefs: [],
      }),
    ]));
    expect(audit.events.filter((event: { clientId: string; operation: string }) =>
      event.clientId === paired.clientId && event.operation === "client.rotate_identity"
    )).toHaveLength(2);
    expect(JSON.stringify(audit.events)).not.toContain(installIdentity);
  });

  it("approves replacing an orphaned development identity after a vault reset", async () => {
    const fixture = workerFixture();
    const ownerConnection = { connectionId: randomUUID(), peerPid: 52009 };
    const installIdentity = "11111111-1111-4111-8111-111111111111";

    const pending = await beginOwnerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      { kind: "codex", installIdentity, replacementInstallIdentity },
    );
    expect(pending.ownerPresenceChallenge.reason).toContain(
      "Replace orphaned Codex (codex) identity",
    );
    expect(await ownerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      { kind: "codex", installIdentity, replacementInstallIdentity },
      true,
    )).toEqual({
      prepared: true,
      kind: "codex",
      installIdentity,
      replacementInstallIdentity,
      clientId: null,
    });
  });

  it("separately approves local identity replacement after owner revocation", async () => {
    const fixture = workerFixture();
    const clientConnection = { connectionId: randomUUID(), peerPid: 52021 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 52022 };
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    const paired = await pairMcpClient(
      fixture.worker,
      clientConnection,
      "claude",
      installIdentity,
    );
    await ownerRequest(fixture.worker, ownerConnection, "owner.session.begin", {
      requestedScopes: [
        "owner.inspect_clients",
        "owner.inspect_grants",
        "owner.inspect_sessions",
        "owner.inspect_audit",
      ],
      ttlMs: 60_000,
    }, true);
    const connections = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_connections",
      {},
    );
    const client = connections.clients.find(
      (candidate: { clientId: string }) => candidate.clientId === paired.clientId,
    );
    const grant = connections.grants.find(
      (candidate: { clientId: string }) => candidate.clientId === paired.clientId,
    );
    await ownerRequest(fixture.worker, ownerConnection, "owner.revoke_client", {
      clientId: client.clientId,
      kind: client.kind,
      displayLabel: client.displayLabel,
      authorityRevision: client.authorityRevision,
      scopes: grant.scopes,
    }, true);

    const pending = await beginOwnerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      { kind: "claude", installIdentity, replacementInstallIdentity },
    );
    expect(pending.ownerPresenceChallenge.reason).toContain(
      "Replace revoked Claude Code (claude) identity",
    );
    expect(await ownerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      { kind: "claude", installIdentity, replacementInstallIdentity },
      true,
    )).toEqual({
      prepared: true,
      kind: "claude",
      installIdentity,
      replacementInstallIdentity,
      clientId: paired.clientId,
    });

    const audit = await ownerRequest(
      fixture.worker,
      ownerConnection,
      "owner.inspect_audit",
      { cursor: null, pageSize: 100 },
    );
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clientId: paired.clientId,
        operation: "client.replace_identity",
        outcome: "success",
      }),
    ]));
  });

  it("refuses development identity rotation for a production-signed broker", async () => {
    const fixture = workerFixture({ trustPath: "production-signed" });
    const clientConnection = { connectionId: randomUUID(), peerPid: 52011 };
    const ownerConnection = { connectionId: randomUUID(), peerPid: 52012 };
    const installIdentity = "11111111-1111-4111-8111-111111111111";
    await pairMcpClient(fixture.worker, clientConnection, "claude", installIdentity);

    expect(await rawOwnerRequest(
      fixture.worker,
      ownerConnection,
      "admin.prepare_client_rotation",
      { kind: "claude", installIdentity, replacementInstallIdentity },
    )).toMatchObject({
      ok: false,
      error: { code: "scope_denied" },
    });
  });

  it("requires fresh connection-bound owner presence for lossless JSON and Markdown export", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 52101 };
    const otherConnection = { connectionId: randomUUID(), peerPid: 52102 };
    await rememberFixture(fixture.worker, connection);
    const jsonPath = join(fixture.directory, "exports", "vault.json");
    const markdownPath = join(fixture.directory, "exports", "vault.md");

    expect(await rawRequest(
      fixture.worker,
      connection,
      "memory-client",
      "admin.export",
      { destination: jsonPath, format: "json" },
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(existsSync(jsonPath)).toBe(false);

    const pending = await beginOwnerRequest(
      fixture.worker,
      connection,
      "admin.export",
      { destination: jsonPath, format: "json" },
    );
    expect(pending.ownerPresenceChallenge.reason).toContain("vault.json");
    expect(await completeOwnerPresence(
      fixture.worker,
      otherConnection,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(existsSync(jsonPath)).toBe(false);

    const exportedJson = await ownerRequest(
      fixture.worker,
      connection,
      "admin.export",
      { destination: jsonPath, format: "json" },
      true,
    );
    expect(exportedJson).toEqual({
      exported: true,
      destination: jsonPath,
      format: "afternote-vault-v1",
    });
    expect(lstatSync(jsonPath).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toMatchObject({
      format: "afternote-vault",
      notes: [expect.objectContaining({
        currentRevision: 1,
        revisions: [expect.objectContaining({
          content: "Broker-owned export canary",
          revision: 1,
        })],
      })],
    });
    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "admin.export",
      { destination: markdownPath, format: "markdown" },
    )).toHaveProperty("ownerPresenceChallenge");
    expect(existsSync(markdownPath)).toBe(false);
    const exportedMarkdown = await ownerRequest(
      fixture.worker,
      connection,
      "admin.export",
      { destination: markdownPath, format: "markdown" },
      true,
    );
    expect(exportedMarkdown.format).toBe("afternote-markdown-v1");
    expect(readFileSync(markdownPath, "utf8")).toContain("Broker-owned export canary");

    expect(await rawOwnerRequest(
      fixture.worker,
      connection,
      "admin.export",
      { destination: markdownPath, format: "markdown" },
      true,
    )).toMatchObject({ ok: false, error: { code: "denied" } });
  });

  it("serves share-safe diagnostics only after fresh owner presence", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 52201 };
    await rememberFixture(fixture.worker, connection, "Claude Desktop");

    const diagnostics = await ownerRequest(
      fixture.worker,
      connection,
      "admin.diagnostics",
      {},
      true,
    );
    expect(diagnostics).toMatchObject({
      format: "afternote-diagnostics",
      schemaVersion: 2,
      application: {
        version: "2.0.0-admin-test",
        standalone: true,
        ownerPresenceMode: "required",
      },
      runtime: { status: "running", networkBoundary: "broker-only" },
      vault: { integrity: "ok", noteCountBucket: "1-9" },
      connectorActivity: expect.arrayContaining([{
        kind: "claude-desktop",
        attributedNotesBucket: "1-9",
        operations: {
          remember: {
            authorizedBucket: "0",
            successBucket: "0",
            deniedBucket: "0",
            errorBucket: "0",
          },
          recall: {
            authorizedBucket: "0",
            successBucket: "0",
            deniedBucket: "0",
            errorBucket: "0",
          },
          getNote: {
            authorizedBucket: "0",
            successBucket: "0",
            deniedBucket: "0",
            errorBucket: "0",
          },
        },
      }]),
    });
    expect(diagnostics).not.toHaveProperty("telemetry");
    const serializedDiagnostics = JSON.stringify(diagnostics);
    expect(serializedDiagnostics).not.toContain(fixture.path);
    expect(serializedDiagnostics).not.toContain("Broker-owned export canary");

    await ownerRequest(fixture.worker, connection, "owner.session.begin", {
      requestedScopes: ["owner.inspect_audit"],
      ttlMs: 60_000,
    }, true);
    const audit = await ownerRequest(
      fixture.worker,
      connection,
      "owner.inspect_audit",
      { cursor: null, pageSize: 100 },
    );
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clientId: "owner",
        clientDisplayLabel: "Owner",
        operation: "admin.diagnostics",
        outcome: "success",
        noteRefs: [],
      }),
    ]));
  });

  it("rejects malformed admin requests without touching output", async () => {
    const fixture = workerFixture();
    const connection = { connectionId: randomUUID(), peerPid: 52301 };
    const relative = "relative-export.json";
    for (const [method, params] of [
      ["admin.export", { destination: relative, format: "json" }],
      ["admin.export", { destination: fixture.path, format: "xml" }],
      ["admin.diagnostics", { extra: true }],
      ["admin.prepare_client_rotation", {
        kind: "unknown",
        installIdentity: "11111111-1111-4111-8111-111111111111",
      }],
      ["admin.prepare_client_rotation", { kind: "codex", installIdentity: "not-a-uuid" }],
      ["admin.prepare_client_rotation", {
        kind: "codex",
        installIdentity: "11111111-1111-4111-8111-111111111111",
        clientId: "22222222-2222-4222-8222-222222222222",
      }],
    ] as const) {
      expect(await rawOwnerRequest(
        fixture.worker,
        connection,
        method,
        params as Record<string, unknown>,
      )).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });
});

describe("prepared reconnect presentation", () => {
  let nativeDirectory: string;
  let nativeRunner: string;
  beforeAll(() => {
    if (process.platform !== "darwin") return;
    nativeDirectory = mkdtempSync(join(tmpdir(), "afternote-prepared-presentation-"));
    nativeRunner = join(nativeDirectory, "presentation");
    const build = Bun.spawnSync(["clang++", "-std=c++17", "-O2", "-fobjc-arc",
      "-framework", "Foundation",
      ...["connector_overview.mm", "connector_presentation.mm", "connector_reconnect_smoke.mm"]
        .map((file) => join(import.meta.dir, "../native", file)), "-o", nativeRunner],
      { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  });
  afterAll(() => { if (nativeDirectory) rmSync(nativeDirectory, { recursive: true, force: true }); });
  it.each(["codex", "claude", "claude-desktop"] as const)(
    "%s overview preserves prepared reconnect across reopen until pairing", async (kind) => {
    const fixture = await revokedFixture(kind);
    const { ownerConnection, clientConnection, installIdentity } = fixture;
    let worker = fixture.worker;
    const overview = async () => {
      const result = await ownerRequest(worker, ownerConnection, "owner.connector_overview", {});
      const item = result.connectors.find((item: any) => item.kind === kind);
      if (nativeRunner) {
        const native = Bun.spawnSync([nativeRunner, kind], {
          stdin: Buffer.from(JSON.stringify(result)), stdout: "pipe", stderr: "pipe",
        });
        expect(native.exitCode, native.stderr.toString()).toBe(0);
        const expected = item.status === "reconnect-prepared"
          ? { title: "Reconnect prepared", action: 0, hasAuthority: false }
          : item.status === "revoked"
          ? { title: "Access revoked", action: 3, hasAuthority: false }
          : { title: "Connected", action: 0, hasAuthority: true };
        expect(JSON.parse(native.stdout.toString())).toMatchObject(expected);
      }
      return item;
    };
    expect(await overview()).toMatchObject({ status: "revoked", activeScopes: [] });
    const params = { kind, installIdentity, replacementInstallIdentity };
    const cancelled = await beginOwnerRequest(worker, ownerConnection,
      "admin.prepare_connector_reconnect", params);
    await completeOwnerPresence(worker, ownerConnection,
      cancelled.ownerPresenceChallenge.challengeId, "cancelled");
    expect(await overview()).toMatchObject({ status: "revoked", activeScopes: [] });
    await ownerRequest(worker, ownerConnection, "admin.prepare_connector_reconnect", params, true);
    expect(await overview()).toMatchObject({ status: "reconnect-prepared", activeScopes: [] });
    worker.close();
    workers.splice(workers.indexOf(worker), 1);
    worker = new VaultBrokerWorker({ applicationVersion: "2.0.0-admin-test", standalone: true,
      vaultPath: fixture.path, vaultKey: fixture.key, vault: fixture.vault,
      bootId: randomUUID(), trustPath: "production-signed" });
    workers.push(worker);
    expect(await overview()).toMatchObject({ status: "reconnect-prepared", activeScopes: [] });
    const replacement = await pairMcpClient(worker, clientConnection, kind,
      replacementInstallIdentity, "secure-enclave");
    expect(replacement.clientId).not.toBe(fixture.paired.clientId);
    expect(await overview()).toMatchObject({ status: "paired" });
    await ownerRequest(worker, ownerConnection, "owner.session.begin", {
      requestedScopes: ["owner.inspect_clients", "owner.inspect_grants", "owner.inspect_sessions"],
      ttlMs: 60000,
    }, true);
    await ownerRequest(worker, ownerConnection, "owner.revoke_connector", { kind }, true);
    expect(await overview()).toMatchObject({ status: "revoked", activeScopes: [] });
  });
});

it.each(["codex", "claude", "claude-desktop"] as const)(
  "%s reconnect requires separate approval and never revives the old identity", async (kind) => {
  const { worker, ownerConnection, clientConnection, installIdentity, paired } =
    await revokedFixture(kind);
  const params = { kind, installIdentity, replacementInstallIdentity };
  await expect(pairMcpClient(worker, clientConnection, kind, replacementInstallIdentity, "secure-enclave"))
    .rejects.toThrow("requires explicit reconnect preparation");
  const pending = await beginOwnerRequest(worker, ownerConnection, "admin.prepare_connector_reconnect", params);
  expect(pending.ownerPresenceChallenge).toBeDefined();
  expect(pending.ownerPresenceChallenge.reason).toContain("remain revoked");
  // An existing owner inspection session is not reconnect approval.
  await expect(pairMcpClient(worker, clientConnection, kind, replacementInstallIdentity, "secure-enclave"))
    .rejects.toThrow("requires explicit reconnect preparation");
  expect(await completeOwnerPresence(worker, ownerConnection,
    pending.ownerPresenceChallenge.challengeId, "approved")).toMatchObject({
    ok: true, result: { prepared: true, ...params, clientId: paired.clientId },
  });
  expect(await completeOwnerPresence(worker, ownerConnection,
    pending.ownerPresenceChallenge.challengeId, "approved")).toMatchObject({ ok: false });
  await expect(pairMcpClient(worker, clientConnection, kind, randomUUID(), "secure-enclave"))
    .rejects.toThrow("requires explicit reconnect preparation");
  const replacement = await pairMcpClient(worker, clientConnection, kind, replacementInstallIdentity, "secure-enclave");
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
  await expect(pairMcpClient(worker, clientConnection, "codex", replacementInstallIdentity, "secure-enclave"))
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
  await expect(pairMcpClient(worker, clientConnection, "codex", replacementInstallIdentity, "secure-enclave"))
    .rejects.toThrow("requires explicit reconnect preparation");
});

async function revokedFixture(kind: "codex" | "claude" | "claude-desktop") {
  const fixture = workerFixture({ trustPath: "production-signed" });
  const clientConnection = { connectionId: randomUUID(), peerPid: 52021 };
  const ownerConnection = { connectionId: randomUUID(), peerPid: 52022 };
  const installIdentity = "11111111-1111-4111-8111-111111111111";
  const paired = await pairMcpClient(fixture.worker, clientConnection, kind, installIdentity, "secure-enclave");
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

it("rejects an old reconnect approval after a replacement is paired and revoked again", async () => {
  const { worker, ownerConnection, clientConnection, installIdentity } = await revokedFixture("codex");
  const staleOwner = { connectionId: randomUUID(), peerPid: 52198 };
  const staleReplacement = randomUUID();
  const stale = await beginOwnerRequest(worker, staleOwner, "admin.prepare_connector_reconnect", {
    kind: "codex", installIdentity, replacementInstallIdentity: staleReplacement,
  });
  expect(stale.ownerPresenceChallenge).toBeDefined();
  await ownerRequest(worker, ownerConnection, "admin.prepare_connector_reconnect", {
    kind: "codex", installIdentity, replacementInstallIdentity,
  }, true);
  await pairMcpClient(worker, clientConnection, "codex", replacementInstallIdentity, "secure-enclave");
  await ownerRequest(worker, ownerConnection, "owner.revoke_connector", { kind: "codex" }, true);
  expect(await completeOwnerPresence(worker, staleOwner,
    stale.ownerPresenceChallenge.challengeId, "approved")).toMatchObject({ ok: false });
  await expect(pairMcpClient(worker, clientConnection, "codex", staleReplacement, "secure-enclave"))
    .rejects.toThrow("requires explicit reconnect preparation");
});

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
  signingMode: "development-exact-build" | "secure-enclave" = "development-exact-build",
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
    signingMode,
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

async function rememberFixture(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
  application = "Admin test",
) {
  await ownerRequest(worker, connection, "library.session.begin", {
    requestedScopes: ["library.remember"],
    ttlMs: 60_000,
  }, true);
  return ownerRequest(worker, connection, "library.remember", {
    content: "Broker-owned export canary",
    source: { application, label: "Fixture" },
  });
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
    payload: { protocolVersion: 1, ...(peerRole === "owner-control" ? { sequence: nextOwnerSequence(connection) } : {}), requestId: randomUUID(), method, params },
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
