import { nextOwnerSequence } from "./owner-request-test-support";
/* eslint-disable @typescript-eslint/no-explicit-any -- protocol fixtures decode JSON */
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { VaultContext } from "@afternote/memory";
import type { EncryptionMigrationFault } from "./encrypted-vault-migration";
import type { CleanVaultRestoreFault } from "./encrypted-vault-restore";
import { SqlcipherDatabase } from "./sqlcipher-database";
import { SqliteMemory } from "./sqlite-memory";
import { VaultBrokerWorker, type VaultBrokerWorkerOptions } from "./vault-broker-worker";

const directories: string[] = [];
const workers: VaultBrokerWorker[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) worker.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("native owner-controlled vault lifecycle", () => {
  it("fails closed when an encrypted vault has no installation-bound key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-vault-key-unavailable-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    const encryptionKey = randomBytes(32);
    const vault: VaultContext = {
      vaultId: "9".repeat(64),
      deployment: "local",
    };
    const existing = new SqliteMemory(path, vault, { encryptionKey });
    await existing.remember(vault, { content: "encrypted vault canary" });
    existing.close();
    encryptionKey.fill(0);

    let creates = 0;
    const worker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-vault-key-test",
      standalone: true,
      vaultPath: path,
      vault,
      vaultKeyReader: () => null,
      vaultKeyCreator: () => {
        creates += 1;
        return randomBytes(32);
      },
      trustPath: "production-signed",
    });
    workers.push(worker);
    const owner = { connectionId: randomUUID(), peerPid: 60790 };

    expect(await rawOwnerRequest(worker, owner, "recovery.status", {}))
      .toMatchObject({ ok: true, result: { state: "vault-key-unavailable" } });
    expect(await rawOwnerRequest(worker, owner, "lifecycle.status", {}))
      .toMatchObject({ ok: false, error: { code: "recovery_required" } });
    expect(creates).toBe(0);
  });

  it("reports path-redacted recovery readiness without creating or unlocking the vault", async () => {
    const emptyDirectory = mkdtempSync(join(tmpdir(), "afternote-recovery-status-empty-"));
    directories.push(emptyDirectory);
    const emptyPath = join(emptyDirectory, "vault.db");
    let keyRequests = 0;
    const emptyWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: emptyPath,
      vaultKeyProvider: () => {
        keyRequests += 1;
        return randomBytes(32);
      },
      vault: { vaultId: "1".repeat(64), deployment: "local" },
    });
    workers.push(emptyWorker);
    const owner = { connectionId: randomUUID(), peerPid: 60791 };

    expect(await rawOwnerRequest(emptyWorker, owner, "recovery.status", {}))
      .toMatchObject({ ok: true, result: { state: "empty" } });
    expect(keyRequests).toBe(0);
    expect(existsSync(emptyPath)).toBe(false);
    expect(await rawOwnerRequest(
      emptyWorker,
      owner,
      "recovery.status",
      { path: emptyPath },
    )).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await rawRequest(
      emptyWorker,
      { connectionId: randomUUID(), peerPid: 60792 },
      "memory-client",
      "recovery.status",
      {},
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });

    const plaintextDirectory = mkdtempSync(join(tmpdir(), "afternote-recovery-status-plain-"));
    directories.push(plaintextDirectory);
    const plaintextPath = join(plaintextDirectory, "vault.db");
    const plaintextVault: VaultContext = {
      vaultId: "2".repeat(64),
      deployment: "local",
    };
    const plaintext = new SqliteMemory(plaintextPath, plaintextVault);
    await plaintext.remember(plaintextVault, { content: "recovery status canary" });
    plaintext.close();
    const plaintextWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: plaintextPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: plaintextVault,
    });
    workers.push(plaintextWorker);
    expect(await rawOwnerRequest(plaintextWorker, owner, "recovery.status", {}))
      .toMatchObject({ ok: true, result: { state: "migration-required" } });
    expect(JSON.stringify(await rawOwnerRequest(
      plaintextWorker,
      owner,
      "recovery.status",
      {},
    ))).not.toContain(plaintextPath);
  });

  it("fails closed for unsafe and conflicting recovery directory entries", async () => {
    const owner = { connectionId: randomUUID(), peerPid: 60793 };

    const danglingDirectory = mkdtempSync(join(tmpdir(), "afternote-recovery-status-link-"));
    directories.push(danglingDirectory);
    const danglingPath = join(danglingDirectory, "vault.db");
    symlinkSync(join(danglingDirectory, "missing-target.db"), danglingPath);
    const danglingWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: danglingPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: { vaultId: "3".repeat(64), deployment: "local" },
    });
    workers.push(danglingWorker);
    expect(await rawOwnerRequest(danglingWorker, owner, "recovery.status", {}))
      .toMatchObject({
        ok: false,
        error: { code: "recovery_state_invalid" },
      });

    const danglingRestoreDirectory = mkdtempSync(
      join(tmpdir(), "afternote-recovery-dangling-restore-marker-"),
    );
    directories.push(danglingRestoreDirectory);
    const danglingRestorePath = join(danglingRestoreDirectory, "vault.db");
    const danglingRestoreVault: VaultContext = {
      vaultId: "7".repeat(64),
      deployment: "local",
    };
    const danglingRestorePlaintext = new SqliteMemory(
      danglingRestorePath,
      danglingRestoreVault,
    );
    danglingRestorePlaintext.close();
    symlinkSync(
      join(danglingRestoreDirectory, "missing-restore-marker.json"),
      `${danglingRestorePath}.restore-recovery.json`,
    );
    const danglingRestoreWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: danglingRestorePath,
      vaultKeyProvider: () => randomBytes(32),
      vault: danglingRestoreVault,
    });
    workers.push(danglingRestoreWorker);
    expect(await rawOwnerRequest(
      danglingRestoreWorker,
      owner,
      "recovery.migrate",
      {
        liveAction: "keep",
        liveDestination: null,
        artifactAction: "keep",
        artifactDestinationDirectory: null,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "recovery_state_invalid" },
    });

    const danglingMigrationDirectory = mkdtempSync(
      join(tmpdir(), "afternote-recovery-dangling-migration-marker-"),
    );
    directories.push(danglingMigrationDirectory);
    const danglingMigrationPath = join(danglingMigrationDirectory, "vault.db");
    symlinkSync(
      join(danglingMigrationDirectory, "missing-migration-marker.json"),
      `${danglingMigrationPath}.encryption-migration.json`,
    );
    const danglingMigrationWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: danglingMigrationPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: { vaultId: "8".repeat(64), deployment: "local" },
    });
    workers.push(danglingMigrationWorker);
    expect(await rawOwnerRequest(
      danglingMigrationWorker,
      owner,
      "recovery.restore",
      { source: join(danglingMigrationDirectory, "missing-export.json") },
    )).toMatchObject({
      ok: false,
      error: { code: "recovery_state_invalid" },
    });

    const conflictDirectory = mkdtempSync(join(tmpdir(), "afternote-recovery-status-conflict-"));
    directories.push(conflictDirectory);
    const conflictPath = join(conflictDirectory, "vault.db");
    writeFileSync(`${conflictPath}.encryption-migration.json`, `${JSON.stringify({
      version: 1,
      phase: "candidate_verified",
      candidateName: "vault.db.encryption-candidate",
      rollbackName: "vault.db.encrypted-rollback",
      legacyName: `vault.db.legacy-plaintext-${"a".repeat(16)}`,
      sourceDigest: "b".repeat(64),
      coordinationDigest: null,
      completion: null,
    })}\n`, { mode: 0o600 });
    const migrationOnlyWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: conflictPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: { vaultId: "4".repeat(64), deployment: "local" },
    });
    workers.push(migrationOnlyWorker);
    expect(await rawOwnerRequest(migrationOnlyWorker, owner, "recovery.status", {}))
      .toMatchObject({
        ok: true,
        result: { state: "migration-manual-resume-required" },
      });
    expect(await rawOwnerRequest(migrationOnlyWorker, owner, "recovery.restore", {
      source: join(conflictDirectory, "missing-export.json"),
    })).toMatchObject({
      ok: false,
      error: { code: "transition_conflict" },
    });
    migrationOnlyWorker.close();
    workers.splice(workers.indexOf(migrationOnlyWorker), 1);

    const markerUuid = "11111111-1111-4111-8111-111111111111";
    writeFileSync(`${conflictPath}.restore-recovery.json`, `${JSON.stringify({
      version: 1,
      phase: "prepared",
      coordinationDigest: "c".repeat(64),
      sourceDigest: "d".repeat(64),
      sourceBytes: 1,
      noteCount: 0,
      revisionCount: 0,
      payloadSha256: "e".repeat(64),
      sourceApplicationVersion: "2.0.0-test",
      temporaryDirectoryName: `.afternote-restore-${markerUuid}`,
      baselineName: `.afternote-restore-baseline-${markerUuid}.db`,
      sealName: null,
      candidateDigest: null,
      finalDigest: null,
      authenticationTag: "0".repeat(64),
    })}\n`, { mode: 0o600 });
    const conflictWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: conflictPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: { vaultId: "5".repeat(64), deployment: "local" },
    });
    workers.push(conflictWorker);
    expect(await rawOwnerRequest(conflictWorker, owner, "recovery.status", {}))
      .toMatchObject({ ok: true, result: { state: "conflict" } });

    const randomDirectory = mkdtempSync(join(tmpdir(), "afternote-recovery-status-random-"));
    directories.push(randomDirectory);
    const randomPath = join(randomDirectory, "vault.db");
    writeFileSync(randomPath, randomBytes(64), { mode: 0o600 });
    const randomWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-status-test",
      standalone: true,
      vaultPath: randomPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: { vaultId: "6".repeat(64), deployment: "local" },
    });
    workers.push(randomWorker);
    expect(await rawOwnerRequest(randomWorker, owner, "recovery.status", {}))
      .toMatchObject({ ok: true, result: { state: "encrypted-candidate" } });
    expect(await rawOwnerRequest(randomWorker, owner, "lifecycle.status", {}))
      .toMatchObject({ ok: false });
  });

  it("restores a clean encrypted vault only after exact owner approval and reopens it through Library", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-restore-worker-"));
    directories.push(directory);
    const sourcePath = join(directory, "legacy-backup.afternote.json");
    const sourceVaultPath = join(directory, "source.db");
    const destinationPath = join(directory, "restored", "vault.db");
    const key = randomBytes(32);
    const vault: VaultContext = { vaultId: "8".repeat(64), deployment: "local" };
    const sourceVault: VaultContext = { vaultId: "9".repeat(64), deployment: "local" };
    const source = new SqliteMemory(sourceVaultPath, sourceVault);
    const note = await source.remember(sourceVault, {
      content: "broker-owned restore canary",
    });
    source.exportInterchange(sourceVault, sourcePath, "2.0.0-restore-test");
    source.close();

    const worker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-restore-test",
      standalone: true,
      vaultPath: destinationPath,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault,
    });
    workers.push(worker);
    const owner = { connectionId: randomUUID(), peerPid: 60801 };
    const params = { source: sourcePath };

    expect(await rawRequest(
      worker,
      { connectionId: randomUUID(), peerPid: 60802 },
      "memory-client",
      "recovery.restore",
      params,
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });

    const denied = await beginOwnerRequest(worker, owner, "recovery.restore", params);
    expect(denied.ownerPresenceChallenge.reason).toContain(
      `Restore export SHA-256 `,
    );
    expect(denied.ownerPresenceChallenge.reason).toContain(sourcePath);
    expect(denied.ownerPresenceChallenge.reason).toMatch(/[a-f0-9]{64}/);
    expect(await completeOwnerPresence(
      worker,
      owner,
      denied.ownerPresenceChallenge.challengeId,
      "denied",
    )).toMatchObject({ ok: false, error: { code: "owner_denied" } });
    expect(existsSync(destinationPath)).toBe(false);

    const sourceBound = await beginOwnerRequest(worker, owner, "recovery.restore", params);
    const approvedSourceBytes = readFileSync(sourcePath);
    writeFileSync(sourcePath, "not the approved export", { mode: 0o600 });
    expect(await completeOwnerPresence(
      worker,
      owner,
      sourceBound.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "transition_conflict" } });
    expect(existsSync(destinationPath)).toBe(false);
    writeFileSync(sourcePath, approvedSourceBytes, { mode: 0o600 });

    const restored = await rawOwnerRequest(
      worker,
      owner,
      "recovery.restore",
      params,
      true,
    );
    expect(restored).toMatchObject({
      ok: true,
      result: {
        restored: true,
        state: "unlocked",
        noteCount: 1,
        format: "afternote-vault-v1",
      },
    });
    expect(restored.result.epoch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(restored)).not.toContain(sourcePath);
    expect(JSON.stringify(restored)).not.toContain(destinationPath);
    expect(readFileSync(destinationPath).subarray(0, 16).toString())
      .not.toBe("SQLite format 3\0");

    await ownerRequest(worker, owner, "library.session.begin", {
      requestedScopes: ["library.get_note", "library.inspect_source"],
      ttlMs: 60_000,
    }, true);
    expect(await ownerRequest(worker, owner, "library.get_note", {
      id: note.id,
      revision: null,
    })).toMatchObject({
      note: { id: note.id, content: "broker-owned restore canary", revision: 1 },
    });

    await ownerRequest(worker, owner, "owner.session.begin", {
      requestedScopes: ["owner.inspect_audit"],
      ttlMs: 60_000,
    }, true);
    const audit = await ownerRequest(worker, owner, "owner.inspect_audit", {
      cursor: null,
      pageSize: 100,
    });
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clientId: "owner",
        operation: "recovery.restore",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      }),
    ]));
    expect(JSON.stringify(audit)).not.toContain(sourcePath);
    expect(JSON.stringify(audit)).not.toContain(destinationPath);
  });

  it("keeps malformed recovery-marker admission errors path-free for ordinary clients", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-restore-marker-redaction-"));
    directories.push(directory);
    const destinationPath = join(directory, "restored", "vault.db");
    const markerPath = `${destinationPath}.restore-recovery.json`;
    const vault: VaultContext = { vaultId: "7".repeat(64), deployment: "local" };
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath, "not valid marker JSON\n", { mode: 0o600 });
    const worker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-restore-test",
      standalone: true,
      vaultPath: destinationPath,
      vaultKeyProvider: () => randomBytes(32),
      vault,
    });
    workers.push(worker);

    const response = await rawRequest(
      worker,
      { connectionId: randomUUID(), peerPid: 60803 },
      "memory-client",
      "memory.recall",
      { query: "redaction canary", limit: 1 },
    );
    expect(response).toMatchObject({
      ok: false,
      error: { code: "denied", message: "Vault restore recovery state is invalid" },
    });
    expect(JSON.stringify(response)).not.toContain(directory);
    expect(JSON.stringify(response)).not.toContain(destinationPath);
    expect(JSON.stringify(response)).not.toContain(markerPath);
    const ownerStatus = await rawOwnerRequest(
      worker,
      { connectionId: randomUUID(), peerPid: 60804 },
      "recovery.status",
      {},
    );
    expect(ownerStatus).toMatchObject({
      ok: false,
      error: {
        code: "recovery_state_invalid",
        message: "Vault recovery state is invalid",
      },
    });
    expect(JSON.stringify(ownerStatus)).not.toContain(directory);
    expect(JSON.stringify(ownerStatus)).not.toContain(destinationPath);
    expect(JSON.stringify(ownerStatus)).not.toContain(markerPath);

    const migrationDirectory = mkdtempSync(
      join(tmpdir(), "afternote-migration-marker-redaction-"),
    );
    directories.push(migrationDirectory);
    const migrationPath = join(migrationDirectory, "vault.db");
    const migrationMarkerPath = `${migrationPath}.encryption-migration.json`;
    writeFileSync(migrationMarkerPath, "x".repeat(8_193), { mode: 0o600 });
    const migrationWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-migration-test",
      standalone: true,
      vaultPath: migrationPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: { vaultId: "6".repeat(64), deployment: "local" },
    });
    workers.push(migrationWorker);
    const migrationResponse = await rawRequest(
      migrationWorker,
      { connectionId: randomUUID(), peerPid: 60805 },
      "memory-client",
      "memory.recall",
      { query: "redaction canary", limit: 1 },
    );
    expect(migrationResponse).toMatchObject({
      ok: false,
      error: {
        code: "denied",
        message: "Vault encryption migration recovery state is invalid",
      },
    });
    expect(JSON.stringify(migrationResponse)).not.toContain(migrationDirectory);
    expect(JSON.stringify(migrationResponse)).not.toContain(migrationPath);
    expect(JSON.stringify(migrationResponse)).not.toContain(migrationMarkerPath);
  });

  it("revalidates opposing recovery markers after owner approval and before mutation", async () => {
    const migrationDirectory = mkdtempSync(
      join(tmpdir(), "afternote-recovery-approval-migration-race-"),
    );
    directories.push(migrationDirectory);
    const migrationPath = join(migrationDirectory, "vault.db");
    const migrationVault: VaultContext = {
      vaultId: "a".repeat(64),
      deployment: "local",
    };
    const plaintext = new SqliteMemory(migrationPath, migrationVault);
    await plaintext.remember(migrationVault, {
      content: "cross recovery migration canary",
    });
    plaintext.close();
    const migrationWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-race-test",
      standalone: true,
      vaultPath: migrationPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: migrationVault,
      onRecoveryApprovalRevalidatedForTest(operation) {
        if (operation !== "migration") return;
        writeFileSync(
          `${migrationPath}.restore-recovery.json`,
          "opposing restore marker\n",
          { mode: 0o600 },
        );
      },
    });
    workers.push(migrationWorker);
    const migrationOwner = { connectionId: randomUUID(), peerPid: 60806 };
    const migration = await beginOwnerRequest(
      migrationWorker,
      migrationOwner,
      "recovery.migrate",
      {
        liveAction: "keep",
        liveDestination: null,
        artifactAction: "keep",
        artifactDestinationDirectory: null,
      },
    );
    expect(await completeOwnerPresence(
      migrationWorker,
      migrationOwner,
      migration.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({
      ok: false,
      error: { code: "recovery_state_invalid" },
    });
    expect(readFileSync(migrationPath).subarray(0, 16).toString())
      .toBe("SQLite format 3\0");

    const restoreDirectory = mkdtempSync(
      join(tmpdir(), "afternote-recovery-approval-restore-race-"),
    );
    directories.push(restoreDirectory);
    const sourcePath = join(restoreDirectory, "backup.afternote.json");
    const sourceVaultPath = join(restoreDirectory, "source.db");
    const destinationPath = join(restoreDirectory, "restored", "vault.db");
    const restoreVault: VaultContext = {
      vaultId: "b".repeat(64),
      deployment: "local",
    };
    const sourceVault: VaultContext = {
      vaultId: "c".repeat(64),
      deployment: "local",
    };
    const source = new SqliteMemory(sourceVaultPath, sourceVault);
    await source.remember(sourceVault, { content: "cross recovery restore canary" });
    source.exportInterchange(sourceVault, sourcePath, "2.0.0-recovery-race-test");
    source.close();
    const restoreWorker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-race-test",
      standalone: true,
      vaultPath: destinationPath,
      vaultKeyProvider: () => randomBytes(32),
      vault: restoreVault,
      onRecoveryApprovalRevalidatedForTest(operation) {
        if (operation !== "restore") return;
        mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
        writeFileSync(
          `${destinationPath}.encryption-migration.json`,
          "opposing migration marker\n",
          { mode: 0o600 },
        );
      },
    });
    workers.push(restoreWorker);
    const restoreOwner = { connectionId: randomUUID(), peerPid: 60807 };
    const restore = await beginOwnerRequest(
      restoreWorker,
      restoreOwner,
      "recovery.restore",
      { source: sourcePath },
    );
    expect(await completeOwnerPresence(
      restoreWorker,
      restoreOwner,
      restore.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({
      ok: false,
      error: { code: "recovery_state_invalid" },
    });
    expect(existsSync(destinationPath)).toBe(false);
  });

  for (const fault of [
    "during_candidate",
    "after_candidate_verified",
    "after_publish",
    "after_audit_sealed",
    "during_finalization",
  ] as const) {
    it(`resumes an interrupted clean restore after ${fault}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), `afternote-restore-${fault}-`));
      directories.push(directory);
      const sourcePath = join(directory, "backup.afternote.json");
      const sourceVaultPath = join(directory, "source.db");
      const destinationPath = join(directory, "restored", "vault.db");
      const key = randomBytes(32);
      const sourceVault: VaultContext = { vaultId: "a".repeat(64), deployment: "local" };
      const restoredVault: VaultContext = { vaultId: "b".repeat(64), deployment: "local" };
      const source = new SqliteMemory(sourceVaultPath, sourceVault);
      const note = await source.remember(sourceVault, {
        content: `restore restart canary ${fault}`,
      });
      source.exportInterchange(sourceVault, sourcePath, "2.0.0-restore-test");
      source.close();
      let injectFault = true;
      const options: VaultBrokerWorkerOptions = {
        applicationVersion: "2.0.0-restore-test",
        standalone: true,
        vaultPath: destinationPath,
        vaultKeyProvider: () => Uint8Array.from(key),
        vault: restoredVault,
        onCleanVaultRestorePhaseForTest(phase: CleanVaultRestoreFault) {
          if (injectFault && phase === fault) throw new Error(`injected ${fault}`);
        },
      };
      const interrupted = new VaultBrokerWorker(options);
      workers.push(interrupted);
      const owner = { connectionId: randomUUID(), peerPid: 60811 };
      const params = { source: sourcePath };

      expect(await rawOwnerRequest(
        interrupted,
        owner,
        "recovery.restore",
        params,
        true,
      )).toMatchObject({ ok: false, error: { code: "recovery_failed" } });
      expect(interrupted.shouldTerminateAfterResponse()).toBe(true);
      expect(existsSync(`${destinationPath}.restore-recovery.json`)).toBe(true);
      if (fault === "during_candidate") {
        expect(readdirSync(dirname(destinationPath)).some((entry) =>
          entry.startsWith(".afternote-restore-") &&
          !entry.startsWith(".afternote-restore-baseline-")
        )).toBe(true);
      }
      interrupted.close();
      workers.splice(workers.indexOf(interrupted), 1);

      injectFault = false;
      const restarted = new VaultBrokerWorker(options);
      workers.push(restarted);
      expect(await rawOwnerRequest(restarted, owner, "recovery.status", {}))
        .toMatchObject({
          ok: true,
          result: { state: "restore-resume-required" },
        });
      expect(await rawOwnerRequest(
        restarted,
        owner,
        "library.session.begin",
        { requestedScopes: ["library.get_note"], ttlMs: 60_000 },
      )).toMatchObject({ ok: false, error: { code: "recovery_required" } });
      expect(await rawOwnerRequest(
        restarted,
        owner,
        "recovery.restore",
        params,
        true,
      )).toMatchObject({
        ok: true,
        result: { restored: true, state: "unlocked", noteCount: 1 },
      });
      expect(existsSync(`${destinationPath}.restore-recovery.json`)).toBe(false);
      expect(await rawOwnerRequest(restarted, owner, "recovery.status", {}))
        .toMatchObject({ ok: true, result: { state: "encrypted-candidate" } });
      expect(readdirSync(dirname(destinationPath)).filter((entry) =>
        entry.startsWith(".afternote-restore-")
      )).toEqual([]);

      await ownerRequest(restarted, owner, "library.session.begin", {
        requestedScopes: ["library.get_note", "library.inspect_source"],
        ttlMs: 60_000,
      }, true);
      expect(await ownerRequest(restarted, owner, "library.get_note", {
        id: note.id,
        revision: null,
      })).toMatchObject({ note: { content: `restore restart canary ${fault}` } });
    });
  }

  it("refuses to overwrite a changed vault while resuming a published restore", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-restore-changed-target-"));
    directories.push(directory);
    const sourcePath = join(directory, "backup.afternote.json");
    const sourceVaultPath = join(directory, "source.db");
    const destinationPath = join(directory, "restored", "vault.db");
    const key = randomBytes(32);
    const sourceVault: VaultContext = { vaultId: "c".repeat(64), deployment: "local" };
    const restoredVault: VaultContext = { vaultId: "d".repeat(64), deployment: "local" };
    const source = new SqliteMemory(sourceVaultPath, sourceVault);
    await source.remember(sourceVault, { content: "approved restore payload" });
    source.exportInterchange(sourceVault, sourcePath, "2.0.0-restore-test");
    source.close();

    let injectFault = true;
    const options: VaultBrokerWorkerOptions = {
      applicationVersion: "2.0.0-restore-test",
      standalone: true,
      vaultPath: destinationPath,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault: restoredVault,
      onCleanVaultRestorePhaseForTest(phase) {
        if (injectFault && phase === "after_publish") throw new Error("injected publish fault");
      },
    };
    const interrupted = new VaultBrokerWorker(options);
    workers.push(interrupted);
    const owner = { connectionId: randomUUID(), peerPid: 60812 };
    expect(await rawOwnerRequest(
      interrupted,
      owner,
      "recovery.restore",
      { source: sourcePath },
      true,
    )).toMatchObject({ ok: false, error: { code: "recovery_failed" } });
    interrupted.close();
    workers.splice(workers.indexOf(interrupted), 1);

    rmSync(destinationPath);
    rmSync(`${destinationPath}-wal`, { force: true });
    rmSync(`${destinationPath}-shm`, { force: true });
    const replacement = new SqliteMemory(destinationPath, restoredVault, {
      encryptionKey: key,
    });
    const replacementNote = await replacement.remember(restoredVault, {
      content: "new vault that must not be overwritten",
    });
    replacement.close();

    injectFault = false;
    const restarted = new VaultBrokerWorker(options);
    workers.push(restarted);
    expect(await rawOwnerRequest(
      restarted,
      owner,
      "recovery.restore",
      { source: sourcePath },
      true,
    )).toMatchObject({ ok: false, error: { code: "recovery_failed" } });

    const unchanged = new SqliteMemory(destinationPath, restoredVault, {
      encryptionKey: key,
    });
    expect(await unchanged.getNote(restoredVault, replacementNote.id)).toMatchObject({
      content: "new vault that must not be overwritten",
    });
    unchanged.close();
  });

  it("rejects a forged restore marker that claims the mandatory audit already completed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-restore-forged-marker-"));
    directories.push(directory);
    const sourcePath = join(directory, "backup.afternote.json");
    const sourceVaultPath = join(directory, "source.db");
    const destinationPath = join(directory, "restored", "vault.db");
    const markerPath = `${destinationPath}.restore-recovery.json`;
    const key = randomBytes(32);
    const sourceVault: VaultContext = { vaultId: "e".repeat(64), deployment: "local" };
    const restoredVault: VaultContext = { vaultId: "f".repeat(64), deployment: "local" };
    const source = new SqliteMemory(sourceVaultPath, sourceVault);
    await source.remember(sourceVault, { content: "marker authentication canary" });
    source.exportInterchange(sourceVault, sourcePath, "2.0.0-restore-test");
    source.close();

    let injectFault = true;
    const options: VaultBrokerWorkerOptions = {
      applicationVersion: "2.0.0-restore-test",
      standalone: true,
      vaultPath: destinationPath,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault: restoredVault,
      onCleanVaultRestorePhaseForTest(phase) {
        if (injectFault && phase === "after_publish") throw new Error("injected publish fault");
      },
    };
    const interrupted = new VaultBrokerWorker(options);
    workers.push(interrupted);
    const owner = { connectionId: randomUUID(), peerPid: 60813 };
    expect(await rawOwnerRequest(
      interrupted,
      owner,
      "recovery.restore",
      { source: sourcePath },
      true,
    )).toMatchObject({ ok: false, error: { code: "recovery_failed" } });
    interrupted.close();
    workers.splice(workers.indexOf(interrupted), 1);

    const forged = JSON.parse(readFileSync(markerPath, "utf8")) as {
      candidateDigest: string;
      finalDigest: string | null;
      phase: string;
      sealName: string | null;
    };
    forged.phase = "finalizing";
    forged.finalDigest = forged.candidateDigest;
    forged.sealName = `.afternote-restore-seal-${randomUUID()}.db`;
    writeFileSync(markerPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });

    injectFault = false;
    const restarted = new VaultBrokerWorker(options);
    workers.push(restarted);
    expect(await rawOwnerRequest(
      restarted,
      owner,
      "recovery.restore",
      { source: sourcePath },
      true,
    )).toMatchObject({ ok: false, error: { code: "recovery_failed" } });
    expect(existsSync(markerPath)).toBe(true);
  });

  it("restores its sealed baseline after an interrupted broker reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-restore-reopen-"));
    directories.push(directory);
    const sourcePath = join(directory, "backup.afternote.json");
    const sourceVaultPath = join(directory, "source.db");
    const destinationPath = join(directory, "restored", "vault.db");
    const key = randomBytes(32);
    const sourceVault: VaultContext = { vaultId: "c".repeat(64), deployment: "local" };
    const restoredVault: VaultContext = { vaultId: "d".repeat(64), deployment: "local" };
    const source = new SqliteMemory(sourceVaultPath, sourceVault);
    const note = await source.remember(sourceVault, { content: "restore reopen canary" });
    source.exportInterchange(sourceVault, sourcePath, "2.0.0-restore-test");
    source.close();
    const owner = { connectionId: randomUUID(), peerPid: 60821 };
    const interrupted = new VaultBrokerWorker({
      applicationVersion: "2.0.0-restore-test",
      standalone: true,
      vaultPath: destinationPath,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault: restoredVault,
      onVaultDataPlaneOpenForTest() {
        throw new Error("injected restore reopen failure");
      },
    });
    workers.push(interrupted);
    expect(await rawOwnerRequest(
      interrupted,
      owner,
      "recovery.restore",
      { source: sourcePath },
      true,
    )).toMatchObject({ ok: false, error: { code: "recovery_failed" } });
    expect(existsSync(`${destinationPath}.restore-recovery.json`)).toBe(true);
    interrupted.close();
    workers.splice(workers.indexOf(interrupted), 1);

    const restarted = new VaultBrokerWorker({
      applicationVersion: "2.0.0-restore-test",
      standalone: true,
      vaultPath: destinationPath,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault: restoredVault,
    });
    workers.push(restarted);
    expect(await rawOwnerRequest(
      restarted,
      owner,
      "recovery.restore",
      { source: sourcePath },
      true,
    )).toMatchObject({ ok: true, result: { restored: true, noteCount: 1 } });
    expect(existsSync(`${destinationPath}.restore-recovery.json`)).toBe(false);
    await ownerRequest(restarted, owner, "library.session.begin", {
      requestedScopes: ["library.get_note", "library.inspect_source"],
      ttlMs: 60_000,
    }, true);
    expect(await ownerRequest(restarted, owner, "library.get_note", {
      id: note.id,
      revision: null,
    })).toMatchObject({ note: { content: "restore reopen canary" } });
  });

  it("migrates a plaintext vault only after exact owner approval and reopens it through the broker", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-recovery-worker-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    const key = randomBytes(32);
    const vault: VaultContext = { vaultId: "6".repeat(64), deployment: "local" };
    const plaintext = new SqliteMemory(path, vault);
    const note = await plaintext.remember(vault, {
      content: "broker-owned migration canary",
    });
    plaintext.close();

    const worker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-test",
      standalone: true,
      vaultPath: path,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault,
    });
    workers.push(worker);
    const owner = { connectionId: randomUUID(), peerPid: 60901 };
    const params = {
      liveAction: "delete",
      liveDestination: null,
      artifactAction: "delete",
      artifactDestinationDirectory: null,
    };

    expect(await rawRequest(
      worker,
      { connectionId: randomUUID(), peerPid: 60902 },
      "memory-client",
      "recovery.migrate",
      params,
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });

    const denied = await beginOwnerRequest(worker, owner, "recovery.migrate", params);
    expect(denied.ownerPresenceChallenge.reason).toContain(
      "Migrate this Afternote vault to encrypted storage",
    );
    expect(await completeOwnerPresence(
      worker,
      owner,
      denied.ownerPresenceChallenge.challengeId,
      "denied",
    )).toMatchObject({ ok: false, error: { code: "owner_denied" } });
    expect(readFileSync(path).subarray(0, 16).toString()).toBe("SQLite format 3\0");

    const inventoryBound = await beginOwnerRequest(
      worker,
      owner,
      "recovery.migrate",
      params,
    );
    expect(await rawOwnerRequest(worker, owner, "lifecycle.lock", {})).toMatchObject({
      ok: false,
      error: { code: "transition_in_progress" },
    });
    const lateArtifact = join(directory, "late-export.afternote.json");
    writeFileSync(lateArtifact, "late plaintext export", { mode: 0o600 });
    expect(await completeOwnerPresence(
      worker,
      owner,
      inventoryBound.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({
      ok: false,
      error: { code: "transition_conflict" },
    });
    expect(readFileSync(path).subarray(0, 16).toString()).toBe("SQLite format 3\0");
    rmSync(lateArtifact);

    const targetBound = await beginOwnerRequest(
      worker,
      owner,
      "recovery.migrate",
      params,
    );
    const changed = new SqliteMemory(path, vault);
    await changed.remember(vault, { content: "written while approval was pending" });
    changed.close();
    expect(await completeOwnerPresence(
      worker,
      owner,
      targetBound.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({
      ok: false,
      error: { code: "transition_conflict" },
    });

    const migrated = await rawOwnerRequest(worker, owner, "recovery.migrate", params, true);
    expect(migrated).toMatchObject({
      ok: true,
      result: {
        migrated: true,
        state: "unlocked",
        encryptedRollbackCreated: true,
        legacyPlaintextRetained: false,
        legacyArtifacts: { found: 0, retained: 0 },
      },
    });
    expect(migrated.result.epoch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(JSON.stringify(migrated)).not.toContain(path);
    expect(readFileSync(path).subarray(0, 16).toString()).not.toBe("SQLite format 3\0");

    await ownerRequest(worker, owner, "library.session.begin", {
      requestedScopes: ["library.get_note", "library.inspect_source"],
      ttlMs: 60_000,
    }, true);
    expect(await ownerRequest(worker, owner, "library.get_note", {
      id: note.id,
      revision: null,
    })).toMatchObject({
      note: { id: note.id, content: "broker-owned migration canary", revision: 1 },
    });

    await ownerRequest(worker, owner, "owner.session.begin", {
      requestedScopes: ["owner.inspect_audit"],
      ttlMs: 60_000,
    }, true);
    const audit = await ownerRequest(worker, owner, "owner.inspect_audit", {
      cursor: null,
      pageSize: 100,
    });
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clientId: "owner",
        operation: "recovery.migrate",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      }),
    ]));
    expect(JSON.stringify(audit)).not.toContain(path);
  });

  it("retires after an interrupted atomic migration and resumes safely on broker restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-recovery-resume-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    const key = randomBytes(32);
    const vault: VaultContext = { vaultId: "5".repeat(64), deployment: "local" };
    const plaintext = new SqliteMemory(path, vault);
    const note = await plaintext.remember(vault, {
      content: "migration restart canary",
    });
    plaintext.close();
    let injectFault = true;
    const options = {
      applicationVersion: "2.0.0-recovery-test",
      standalone: true,
      vaultPath: path,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault,
      onEncryptionMigrationPhaseForTest(phase: EncryptionMigrationFault) {
        if (injectFault && phase === "after_swap") throw new Error("injected after swap");
      },
    };
    const interrupted = new VaultBrokerWorker(options);
    workers.push(interrupted);
    const owner = { connectionId: randomUUID(), peerPid: 60911 };
    const params = {
      liveAction: "keep",
      liveDestination: null,
      artifactAction: "keep",
      artifactDestinationDirectory: null,
    };

    expect(await rawOwnerRequest(
      interrupted,
      owner,
      "recovery.migrate",
      params,
      true,
    )).toMatchObject({
      ok: false,
      error: { code: "recovery_failed" },
    });
    expect(interrupted.shouldTerminateAfterResponse()).toBe(true);
    expect(existsSync(`${path}.encryption-migration.json`)).toBe(true);
    interrupted.close();
    workers.splice(workers.indexOf(interrupted), 1);

    injectFault = false;
    const restarted = new VaultBrokerWorker(options);
    workers.push(restarted);
    expect(await rawOwnerRequest(restarted, owner, "recovery.status", {}))
      .toMatchObject({
        ok: true,
        result: { state: "migration-resume-required" },
      });
    expect(await rawOwnerRequest(
      restarted,
      owner,
      "library.session.begin",
      { requestedScopes: ["library.get_note"], ttlMs: 60_000 },
    )).toMatchObject({
      ok: false,
      error: { code: "recovery_required" },
    });
    expect(restarted.hasConfiguredVaultKeyForTest()).toBe(false);
    expect(await rawOwnerRequest(
      restarted,
      owner,
      "recovery.migrate",
      params,
      true,
    )).toMatchObject({ ok: true, result: { migrated: true, state: "unlocked" } });
    expect(existsSync(`${path}.encryption-migration.json`)).toBe(false);
    expect(await rawOwnerRequest(restarted, owner, "recovery.status", {}))
      .toMatchObject({ ok: true, result: { state: "encrypted-candidate" } });

    await ownerRequest(restarted, owner, "library.session.begin", {
      requestedScopes: ["library.get_note", "library.inspect_source"],
      ttlMs: 60_000,
    }, true);
    expect(await ownerRequest(restarted, owner, "library.get_note", {
      id: note.id,
      revision: null,
    })).toMatchObject({
      note: { id: note.id, content: "migration restart canary", revision: 1 },
    });
  });

  it("retains resumable completion until broker reopen and audit succeed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-recovery-reopen-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    const key = randomBytes(32);
    const vault: VaultContext = { vaultId: "4".repeat(64), deployment: "local" };
    const plaintext = new SqliteMemory(path, vault);
    const note = await plaintext.remember(vault, { content: "reopen retry canary" });
    plaintext.close();
    const params = {
      liveAction: "delete",
      liveDestination: null,
      artifactAction: "delete",
      artifactDestinationDirectory: null,
    };
    const owner = { connectionId: randomUUID(), peerPid: 60921 };
    const interrupted = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-test",
      standalone: true,
      vaultPath: path,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault,
      onVaultDataPlaneOpenForTest() {
        throw new Error("injected reopen failure");
      },
    });
    workers.push(interrupted);
    expect(await rawOwnerRequest(
      interrupted,
      owner,
      "recovery.migrate",
      params,
      true,
    )).toMatchObject({ ok: false, error: { code: "recovery_failed" } });
    expect(interrupted.shouldTerminateAfterResponse()).toBe(true);
    expect(existsSync(`${path}.encryption-migration.json`)).toBe(true);
    interrupted.close();
    workers.splice(workers.indexOf(interrupted), 1);

    const restarted = new VaultBrokerWorker({
      applicationVersion: "2.0.0-recovery-test",
      standalone: true,
      vaultPath: path,
      vaultKeyProvider: () => Uint8Array.from(key),
      vault,
    });
    workers.push(restarted);
    expect(await rawOwnerRequest(restarted, owner, "recovery.status", {}))
      .toMatchObject({
        ok: true,
        result: { state: "migration-manual-resume-required" },
      });
    expect(await rawOwnerRequest(
      restarted,
      owner,
      "recovery.migrate",
      params,
      true,
    )).toMatchObject({ ok: true, result: { migrated: true, state: "unlocked" } });
    expect(existsSync(`${path}.encryption-migration.json`)).toBe(false);
    await ownerRequest(restarted, owner, "library.session.begin", {
      requestedScopes: ["library.get_note", "library.inspect_source"],
      ttlMs: 60_000,
    }, true);
    expect(await ownerRequest(restarted, owner, "library.get_note", {
      id: note.id,
      revision: null,
    })).toMatchObject({ note: { content: "reopen retry canary" } });
  });

  it("rejects ordinary roles, malformed requests, cross-connection/PID approval, denial, expiry, and replay", async () => {
    let now = Date.parse("2026-08-29T00:00:00.000Z");
    const fixture = workerFixture({ now: () => now });
    const owner = { connectionId: randomUUID(), peerPid: 61001 };
    const otherConnection = { connectionId: randomUUID(), peerPid: owner.peerPid };
    const otherPid = { connectionId: owner.connectionId, peerPid: owner.peerPid + 1 };

    expect(await rawRequest(fixture.worker, owner, "memory-client", "lifecycle.lock", {}))
      .toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(await rawOwnerRequest(fixture.worker, owner, "lifecycle.lock", { extra: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_request" } });

    const crossed = await beginOwnerRequest(fixture.worker, owner, "lifecycle.lock", {});
    expect(crossed.ownerPresenceChallenge).toMatchObject({
      operation: "lifecycle.lock",
      currentState: "unlocked",
    });
    expect(await completeOwnerPresence(
      fixture.worker,
      otherConnection,
      crossed.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      crossed.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });

    const pidBound = await beginOwnerRequest(fixture.worker, owner, "lifecycle.lock", {});
    expect(await completeOwnerPresence(
      fixture.worker,
      otherPid,
      pidBound.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "identity_mismatch" } });
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      pidBound.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });

    const denied = await beginOwnerRequest(fixture.worker, owner, "lifecycle.lock", {});
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      denied.ownerPresenceChallenge.challengeId,
      "denied",
    )).toMatchObject({ ok: false, error: { code: "owner_denied" } });
    expect((await lifecycleStatus(fixture.worker, owner)).state).toBe("unlocked");

    const expired = await beginOwnerRequest(fixture.worker, owner, "lifecycle.lock", {});
    now = Date.parse(expired.ownerPresenceChallenge.expiresAt) + 1;
    const replacement = await beginOwnerRequest(fixture.worker, owner, "lifecycle.lock", {});
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      expired.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      replacement.ownerPresenceChallenge.challengeId,
      "denied",
    )).toMatchObject({ ok: false, error: { code: "owner_denied" } });
    expect((await lifecycleStatus(fixture.worker, owner)).state).toBe("unlocked");
  });

  it("consumes and audits a lifecycle challenge when its owner connection disconnects", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61051 };
    const replacement = { connectionId: randomUUID(), peerPid: 61052 };
    const pending = await beginOwnerRequest(fixture.worker, owner, "lifecycle.lock", {});

    await closeConnection(fixture.worker, owner);
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });
    expect((await lifecycleStatus(fixture.worker, replacement)).state).toBe("unlocked");
    expect(fixture.worker.readAuditForTest()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "lifecycle.lock",
        outcome: "denied",
        errorCode: "owner_disconnected",
        noteRefs: [],
      }),
    ]));
  });

  it("closes admission and every pre-lock ephemeral owner capability, then rotates the epoch", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61101 };
    await ownerRequest(fixture.worker, owner, "library.session.begin", {
      requestedScopes: ["library.remember", "library.browse"],
      ttlMs: 60_000,
    }, true);
    await ownerRequest(fixture.worker, owner, "library.remember", {
      content: "lifecycle plaintext canary",
      source: null,
    });
    const before = await lifecycleStatus(fixture.worker, owner);

    const locked = await ownerRequest(fixture.worker, owner, "lifecycle.lock", {}, true);
    expect(locked).toEqual({ state: "locked", epoch: before.epoch });
    for (const [method, params] of [
      ["library.browse", { cursor: null, limit: 20, view: null }],
      ["owner.inspect_connections", {}],
      ["admin.diagnostics", {}],
      ["admin.export", { destination: join(fixture.directory, "locked.json"), format: "json" }],
    ] as const) {
      expect(await rawOwnerRequest(fixture.worker, owner, method, params))
        .toMatchObject({ ok: false, error: { code: "vault_locked" } });
    }
    expect(await rawRequest(
      fixture.worker,
      { connectionId: randomUUID(), peerPid: 61102 },
      "memory-client",
      "client.begin",
      {},
    )).toMatchObject({ ok: false, error: { code: "vault_locked" } });

    const unlocked = await ownerRequest(fixture.worker, owner, "lifecycle.unlock", {}, true);
    expect(unlocked.state).toBe("unlocked");
    expect(unlocked.epoch).not.toBe(before.epoch);
    expect(await rawOwnerRequest(
      fixture.worker,
      owner,
      "library.browse",
      { cursor: null, limit: 20, view: null },
    )).toMatchObject({ ok: false, error: { code: "library_session_required" } });

    await ownerRequest(fixture.worker, owner, "library.session.begin", {
      requestedScopes: ["library.browse"],
      ttlMs: 60_000,
    }, true);
    const page = await ownerRequest(fixture.worker, owner, "library.browse", {
      cursor: null,
      limit: 20,
      view: null,
    });
    expect(page.notes).toEqual([
      expect.objectContaining({ excerpt: "lifecycle plaintext canary" }),
    ]);
  });

  it("fails concurrent and repeated lifecycle requests with stable closed errors", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61151 };
    const pending = await beginOwnerRequest(fixture.worker, owner, "lifecycle.lock", {});
    expect(await rawOwnerRequest(fixture.worker, owner, "lifecycle.lock", {}))
      .toMatchObject({ ok: false, error: { code: "transition_in_progress" } });
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      pending.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: true, result: { state: "locked" } });
    expect(await rawOwnerRequest(fixture.worker, owner, "lifecycle.lock", {}))
      .toMatchObject({ ok: false, error: { code: "already_locked" } });
    await ownerRequest(fixture.worker, owner, "lifecycle.unlock", {}, true);
    expect(await rawOwnerRequest(fixture.worker, owner, "lifecycle.unlock", {}))
      .toMatchObject({ ok: false, error: { code: "already_unlocked" } });
  });

  it("consumes pre-lock pending owner challenges without publishing their result", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61161 };
    const destination = join(fixture.directory, "pending-export.json");
    const exportRequest = await beginOwnerRequest(
      fixture.worker,
      owner,
      "admin.export",
      { destination, format: "json" },
    );
    await ownerRequest(fixture.worker, owner, "lifecycle.lock", {}, true);
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      exportRequest.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });
    expect(existsSync(destination)).toBe(false);
  });

  it("uses maintenance-only restart status and requires fresh presence after interrupted reopen", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61201 };
    await ownerRequest(fixture.worker, owner, "lifecycle.lock", {}, true);
    fixture.worker.close();
    workers.splice(workers.indexOf(fixture.worker), 1);

    let dataPlaneOpens = 0;
    let failKeyRetrieval = false;
    let interruptReopen = true;
    const restarted = new VaultBrokerWorker({
      applicationVersion: "2.0.0-lifecycle-test",
      standalone: true,
      vaultPath: fixture.path,
      vaultKeyProvider: () => {
        if (failKeyRetrieval) throw new Error("Keychain item unavailable: secret detail");
        return Uint8Array.from(fixture.key);
      },
      onVaultDataPlaneOpenForTest: () => {
        dataPlaneOpens += 1;
        if (interruptReopen) throw new Error("Interrupted after maintenance verification");
      },
      vault: fixture.vault,
    });
    workers.push(restarted);
    expect((await lifecycleStatus(restarted, owner)).state).toBe("locked");
    expect(dataPlaneOpens).toBe(0);

    const firstAttempt = await beginOwnerRequest(restarted, owner, "lifecycle.unlock", {});
    failKeyRetrieval = true;
    expect(await completeOwnerPresence(
      restarted,
      owner,
      firstAttempt.ownerPresenceChallenge.challengeId,
      "approved",
    ))
      .toMatchObject({ ok: false, error: { code: "unlock_failed", message: "Afternote vault remains locked" } });
    expect(dataPlaneOpens).toBe(0);

    failKeyRetrieval = false;
    const secondAttempt = await beginOwnerRequest(restarted, owner, "lifecycle.unlock", {});
    expect(secondAttempt.ownerPresenceChallenge.challengeId)
      .not.toBe(firstAttempt.ownerPresenceChallenge.challengeId);
    expect(await completeOwnerPresence(
      restarted,
      owner,
      secondAttempt.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "unlock_failed" } });
    expect(dataPlaneOpens).toBe(1);

    interruptReopen = false;
    const thirdAttempt = await beginOwnerRequest(restarted, owner, "lifecycle.unlock", {});
    expect(thirdAttempt.ownerPresenceChallenge.challengeId)
      .not.toBe(secondAttempt.ownerPresenceChallenge.challengeId);
    const unlocked = await completeOwnerPresence(
      restarted,
      owner,
      thirdAttempt.ownerPresenceChallenge.challengeId,
      "approved",
    );
    expect(unlocked).toMatchObject({ ok: true, result: { state: "unlocked" } });
    expect(dataPlaneOpens).toBe(2);
  });

  it("keeps corrupt and newer-schema vaults locked with redacted reopen errors", async () => {
    for (const failure of ["corrupt", "newer-schema"] as const) {
      const fixture = workerFixture();
      const owner = { connectionId: randomUUID(), peerPid: failure === "corrupt" ? 61221 : 61222 };
      await ownerRequest(fixture.worker, owner, "lifecycle.lock", {}, true);
      if (failure === "corrupt") {
        writeFileSync(fixture.path, randomBytes(4096));
      } else {
        const database = new SqlcipherDatabase(fixture.path, { key: fixture.key });
        database.exec("pragma user_version = 999");
        database.close();
      }

      expect(await rawOwnerRequest(fixture.worker, owner, "lifecycle.unlock", {}, true))
        .toMatchObject({
          ok: false,
          error: { code: "unlock_failed", message: "Afternote vault remains locked" },
        });
      expect((await lifecycleStatus(fixture.worker, owner)).state).toBe("locked");
    }
  });

  it("keeps a permission-denied reopen locked and requires a fresh retry challenge", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61231 };
    await ownerRequest(fixture.worker, owner, "lifecycle.lock", {}, true);
    const deniedByPermissions = await beginOwnerRequest(
      fixture.worker,
      owner,
      "lifecycle.unlock",
      {},
    );
    chmodSync(fixture.path, 0o000);
    try {
      expect(await completeOwnerPresence(
        fixture.worker,
        owner,
        deniedByPermissions.ownerPresenceChallenge.challengeId,
        "approved",
      )).toMatchObject({
        ok: false,
        error: { code: "unlock_failed", message: "Afternote vault remains locked" },
      });
    } finally {
      chmodSync(fixture.path, 0o600);
    }
    expect((await lifecycleStatus(fixture.worker, owner)).state).toBe("locked");
    const retry = await beginOwnerRequest(fixture.worker, owner, "lifecycle.unlock", {});
    expect(retry.ownerPresenceChallenge.challengeId)
      .not.toBe(deniedByPermissions.ownerPresenceChallenge.challengeId);
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      retry.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: true, result: { state: "unlocked" } });
  });

  it("retires on an uncertain lock transaction and recovers from encrypted state", async () => {
    const fixture = workerFixture({
      onLockTransactionForTest: () => {
        throw new Error("Injected commit/rollback uncertainty");
      },
    });
    const owner = { connectionId: randomUUID(), peerPid: 61241 };
    expect(await rawOwnerRequest(fixture.worker, owner, "lifecycle.lock", {}, true))
      .toMatchObject({ ok: false, error: { code: "lifecycle_transition_failed" } });
    expect(fixture.worker.shouldTerminateAfterResponse()).toBe(true);

    fixture.worker.close();
    workers.splice(workers.indexOf(fixture.worker), 1);
    const recovered = new VaultBrokerWorker({
      applicationVersion: "2.0.0-lifecycle-test",
      standalone: true,
      vaultPath: fixture.path,
      vaultKeyProvider: () => Uint8Array.from(fixture.key),
      vault: fixture.vault,
    });
    workers.push(recovered);
    expect((await lifecycleStatus(recovered, owner)).state).toBe("unlocked");
  });

  it("stays locked, closes every handle, and zeroes its owned key after teardown failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-lifecycle-close-failure-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    const key = randomBytes(32);
    const vault: VaultContext = { vaultId: "7".repeat(64), deployment: "local" };
    const closed: string[] = [];
    let injected = false;
    const worker = new VaultBrokerWorker({
      applicationVersion: "2.0.0-lifecycle-test",
      standalone: true,
      vaultPath: path,
      vaultKey: key,
      vault,
      onVaultHandleClosedForTest: (handle) => {
        closed.push(handle);
        if (handle === "memory" && !injected) {
          injected = true;
          throw new Error("Injected close failure");
        }
      },
    });
    workers.push(worker);
    const owner = { connectionId: randomUUID(), peerPid: 61251 };
    await ownerRequest(worker, owner, "library.session.begin", {
      requestedScopes: ["library.browse"],
      ttlMs: 60_000,
    }, true);

    expect(await rawOwnerRequest(worker, owner, "lifecycle.lock", {}, true))
      .toMatchObject({ ok: false, error: { code: "lifecycle_transition_failed" } });
    expect((await lifecycleStatus(worker, owner)).state).toBe("locked");
    expect(closed).toEqual(["memory", "authorization", "cursors", "database"]);
    expect(worker.hasConfiguredVaultKeyForTest()).toBe(false);
    expect(worker.shouldTerminateAfterResponse()).toBe(true);
  });

  it("records redacted lock and deferred unlock-denial evidence after reopen", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61301 };
    await ownerRequest(fixture.worker, owner, "lifecycle.lock", {}, true);
    const denied = await beginOwnerRequest(fixture.worker, owner, "lifecycle.unlock", {});
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      denied.ownerPresenceChallenge.challengeId,
      "cancelled",
    )).toMatchObject({ ok: false, error: { code: "owner_cancelled" } });
    const disconnected = await beginOwnerRequest(
      fixture.worker,
      owner,
      "lifecycle.unlock",
      {},
    );
    await closeConnection(fixture.worker, owner);
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      disconnected.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "replayed" } });
    const reopenedOwner = { connectionId: randomUUID(), peerPid: 61302 };
    await ownerRequest(fixture.worker, reopenedOwner, "lifecycle.unlock", {}, true);
    await ownerRequest(fixture.worker, reopenedOwner, "owner.session.begin", {
      requestedScopes: ["owner.inspect_audit"],
      ttlMs: 60_000,
    }, true);
    const audit = await ownerRequest(fixture.worker, reopenedOwner, "owner.inspect_audit", {
      cursor: null,
      pageSize: 100,
    });
    expect(audit.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clientId: "owner",
        operation: "lifecycle.lock",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      }),
      expect.objectContaining({
        clientId: "owner",
        operation: "lifecycle.unlock",
        outcome: "denied",
        errorCode: "owner_cancelled",
        noteRefs: [],
      }),
      expect.objectContaining({
        clientId: "owner",
        operation: "lifecycle.unlock",
        outcome: "denied",
        errorCode: "owner_disconnected",
        noteRefs: [],
      }),
      expect.objectContaining({
        clientId: "owner",
        operation: "lifecycle.unlock",
        outcome: "success",
        errorCode: null,
        noteRefs: [],
      }),
    ]));
    expect(JSON.stringify(audit)).not.toContain(fixture.path);
    expect(JSON.stringify(audit)).not.toContain("lifecycle plaintext canary");
  });

  it("never publishes an export when lifecycle admission closes before publication", async () => {
    const fixture = workerFixture();
    const owner = { connectionId: randomUUID(), peerPid: 61401 };
    const destination = join(fixture.directory, "export.json");
    await ownerRequest(fixture.worker, owner, "library.session.begin", {
      requestedScopes: ["library.remember"],
      ttlMs: 60_000,
    }, true);
    await ownerRequest(fixture.worker, owner, "library.remember", {
      content: "export race plaintext canary",
      source: null,
    });

    const admitted = await beginOwnerRequest(
      fixture.worker,
      owner,
      "admin.export",
      { destination, format: "json" },
    );
    fixture.worker.closeLifecycleAdmissionForTest();
    expect(await completeOwnerPresence(
      fixture.worker,
      owner,
      admitted.ownerPresenceChallenge.challengeId,
      "approved",
    )).toMatchObject({ ok: false, error: { code: "vault_locked" } });
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(fixture.directory).some((name) => name.startsWith("export.json.tmp-")))
      .toBe(false);
  });
});

function workerFixture(
  options: Pick<
    VaultBrokerWorkerOptions,
    | "now"
    | "onVaultDataPlaneOpenForTest"
    | "onVaultHandleClosedForTest"
    | "onLockTransactionForTest"
  > = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "afternote-lifecycle-worker-"));
  directories.push(directory);
  const path = join(directory, "vault.db");
  const key = randomBytes(32);
  const vault: VaultContext = { vaultId: "8".repeat(64), deployment: "local" };
  const worker = new VaultBrokerWorker({
    applicationVersion: "2.0.0-lifecycle-test",
    standalone: true,
    vaultPath: path,
    vaultKeyProvider: () => Uint8Array.from(key),
    vault,
    bootId: "9d5c6484-35e9-44e4-bf09-556508567cab",
    ...options,
  });
  workers.push(worker);
  return { worker, directory, path, key, vault };
}

async function closeConnection(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
) {
  return JSON.parse(await worker.handleSerialized(JSON.stringify({
    kind: "connection-closed",
    peerRole: "owner-control",
    ...connection,
    payload: {},
  })));
}

async function lifecycleStatus(
  worker: VaultBrokerWorker,
  connection: { connectionId: string; peerPid: number },
) {
  return ownerRequest(worker, connection, "lifecycle.status", {});
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
