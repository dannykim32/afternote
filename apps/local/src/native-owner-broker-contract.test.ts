import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildDiagnosticBundle } from "./diagnostics";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("Foundation-only owner broker contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-owner-contract-"));
  const runner = join(directory, "contract-smoke");
  beforeAll(() => {
    const build = Bun.spawnSync([
      "clang++", "-std=c++17", "-O2", "-fobjc-arc", "-fblocks",
      "-framework", "Foundation",
      join(import.meta.dir, "../native/connector_overview.mm"),
      join(import.meta.dir, "../native/owner_broker_contract.mm"),
      join(import.meta.dir, "../native/owner_broker_contract_smoke.mm"),
      "-o", runner,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  }, 30_000);
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  function accepts(fixture: Record<string, unknown>): boolean {
    const path = join(directory, "fixture.json");
    writeFileSync(path, JSON.stringify(fixture), { mode: 0o600 });
    const result = Bun.spawnSync([runner, path], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  }
  function result(method: string, value: unknown, params: Record<string, unknown> = {}) {
    return accepts({ kind: "result", method, result: value, params });
  }
  const epoch = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const nextEpoch = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  it("binds results to a known method and rejects unexpected fields", () => {
    expect(result("library.browse", { notes: [], nextCursor: null })).toBe(true);
    expect(result("library.browse", { notes: [], nextCursor: null, secret: "unexpected" })).toBe(false);
    expect(result("library.browse", { notes: [null], nextCursor: null })).toBe(false);
    expect(result("library.browse", { notes: [], nextCursor: "not-base64" })).toBe(false);
    expect(result("library.unknown", { notes: [], nextCursor: null })).toBe(false);
    expect(result("unknown", {})).toBe(false);
    expect(result("recovery.status", { state: "vault-key-unavailable" })).toBe(true);
    expect(result("recovery.status", { state: "unlocked" })).toBe(false);
  });

  it("validates semantic activation replies", () => {
    for (const searchMode of ["exact", "indexing", "hybrid", "degraded"]) {
      expect(result("library.refresh_search", { searchMode })).toBe(true);
    }
    expect(result("library.refresh_search", { searchMode: "ready" })).toBe(false);
    expect(result("library.refresh_search", { searchMode: "hybrid", note: "unexpected" })).toBe(false);
    expect(result("library.refresh_search", {})).toBe(false);
  });

  it("binds export and identity-rotation acknowledgments to the request", () => {
    const params = { format: "json", destination: "/tmp/export.json" };
    const exported = { exported: true, format: "afternote-vault-v1", destination: params.destination };
    expect(result("admin.export", exported, params)).toBe(true);
    expect(result("admin.export", exported, { ...params, destination: "/tmp/other.json" })).toBe(false);
    expect(result("admin.export", exported, { ...params, format: "markdown" })).toBe(false);
    const rotation = { kind: "claude-desktop", installIdentity: epoch, replacementInstallIdentity: nextEpoch };
    const prepared = { prepared: true, ...rotation, clientId: null };
    expect(result("admin.prepare_client_rotation", prepared, rotation)).toBe(true);
    expect(result("admin.prepare_client_rotation", prepared, { ...rotation, kind: "claude" })).toBe(false);
    expect(result("admin.prepare_client_rotation", prepared, { ...rotation, replacementInstallIdentity: epoch })).toBe(false);
  });

  it("accepts broker diagnostics but rejects raw counts, private fields, and duplicate connectors", () => {
    const counts = { authorized: 0, success: 2, denied: 0, error: 0 };
    const diagnostics = buildDiagnosticBundle({
      applicationVersion: "2.0.0-test", standalone: true, apiVersion: 7,
      networkBoundary: "broker-only", ownerPresenceMode: "required",
      vault: { schemaVersion: 10, integrity: "ok", noteCount: 2, revisionCount: 2, databaseBytes: 4096 },
      connectorActivity: (["codex", "claude", "claude-desktop"] as const).map((kind) => ({
        kind, attributedNoteCount: 2,
        operations: { remember: counts, recall: counts, getNote: counts },
      })),
    });
    expect(result("admin.diagnostics", diagnostics)).toBe(true);
    expect(result("admin.diagnostics", { ...diagnostics, vaultPath: "/private/vault.db" })).toBe(false);
    expect(result("admin.diagnostics", { ...diagnostics, schemaVersion: 1 })).toBe(false);
    expect(result("admin.diagnostics", {
      ...diagnostics, connectorActivity: [
        diagnostics.connectorActivity[0], diagnostics.connectorActivity[1], diagnostics.connectorActivity[1],
      ],
    })).toBe(false);
    const unredacted = structuredClone(diagnostics);
    (unredacted.vault as unknown as Record<string, unknown>).noteCountBucket = 2;
    expect(result("admin.diagnostics", unredacted)).toBe(false);
  });

  it("binds production reconnect approval to an exact revoked identity and a new replacement", () => {
    const params = { kind: "codex", installIdentity: epoch, replacementInstallIdentity: nextEpoch };
    const prepared = { prepared: true, ...params, clientId: epoch };
    expect(result("admin.prepare_connector_reconnect", prepared, params)).toBe(true);
    expect(result("admin.prepare_connector_reconnect", { ...prepared, clientId: null }, params)).toBe(false);
    expect(result("admin.prepare_connector_reconnect", prepared, { ...params, kind: "claude" })).toBe(false);
    expect(result("admin.prepare_connector_reconnect", {
      ...prepared, replacementInstallIdentity: epoch,
    }, { ...params, replacementInstallIdentity: epoch })).toBe(false);
  });

  it("enforces the existing lifecycle epoch rules", () => {
    function transition(method: string, before: unknown, after: unknown) {
      return accepts({ kind: "lifecycle", method, before, result: after });
    }
    const unlocked = { state: "unlocked", epoch };
    const locked = { state: "locked", epoch };
    expect(transition("lifecycle.lock", unlocked, locked)).toBe(true);
    expect(transition("lifecycle.lock", unlocked, { ...locked, epoch: nextEpoch })).toBe(false);
    expect(transition("lifecycle.unlock", locked, { state: "unlocked", epoch: nextEpoch })).toBe(true);
    expect(transition("lifecycle.unlock", locked, unlocked)).toBe(false);
    expect(transition("lifecycle.lock", locked, locked)).toBe(false);
    expect(transition("lifecycle.status", unlocked, unlocked)).toBe(false);
  });

  it("accepts only known, bounded broker errors", () => {
    const error = { code: "vault_locked", message: "The vault is locked." };
    expect(accepts({ kind: "error", result: error })).toBe(true);
    expect(accepts({ kind: "error", result: { ...error, code: "private_error" } })).toBe(false);
    expect(accepts({ kind: "error", result: { ...error, message: "x".repeat(501) } })).toBe(false);
    expect(accepts({ kind: "error", result: { ...error, stack: "private stack" } })).toBe(false);
  });
});
