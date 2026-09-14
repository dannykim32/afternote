import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createAfternoteMcpServer } from "@afternote/mcp";
import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildLocalAlpha } from "../../../scripts/build-local-alpha";
import {
  requestVaultBroker,
  VaultBrokerMemoryClient,
  vaultBrokerHealth,
} from "./vault-broker-client";
import { localVaultContext } from "./local-vault";
import {
  requestVaultBrokerXpc,
  type DurableClientSigner,
} from "./sqlcipher-database";
import { SqliteMemory } from "./sqlite-memory";

const describeMacos = process.platform === "darwin" && process.arch === "arm64" &&
    process.env.AFTERNOTE_TEST_HOST_LAUNCHD === "1"
  ? describe
  : describe.skip;
const temporaryDirectories: string[] = [];
const loadedJobs: string[] = [];
const userId = typeof process.getuid === "function" ? process.getuid() : -1;

afterEach(() => {
  for (const job of loadedJobs.splice(0)) {
    Bun.spawnSync(["/bin/launchctl", "bootout", `gui/${userId}/${job}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describeMacos("launchd-owned vault broker gateway", () => {
  it("owns one authoritative Mach service despite replaceable legacy artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-broker-xpc-"));
    temporaryDirectories.push(directory);
    const suffix = randomUUID().toLowerCase();
    const service = `dev.afternote.vault-broker.test.${suffix}`;
    const ownerService = `dev.afternote.owner.test.${suffix}`;
    const workerService = `${service}.private-worker`;
    const label = `${service}.primary`;
    const duplicateLabel = `${service}.duplicate`;
    const workerPath = join(directory, "afternote-vault-worker");
    const vaultPath = join(directory, "vault", "vault.db");
    const keyPath = join(directory, "test-vault-key");
    const closeFailurePath = join(directory, "inject-close-failure");
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    const plaintext = new SqliteMemory(vaultPath, localVaultContext(vaultPath));
    plaintext.close();
    const builtGatewayPath = join(
      import.meta.dir,
      "../native/build/afternote-vault-broker-gateway-test",
    );
    const gatewayPath = join(directory, "afternote-vault-broker-gateway-test");
    copyFileSync(builtGatewayPath, gatewayPath);
    const gatewayCodeRequirement = designatedRequirement(gatewayPath);
    const ownerControlPath = join(directory, "afternote-owner-control-test");
    const ownerControlBuild = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O2",
      "-fobjc-arc",
      "-fblocks",
      "-DAFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING=1",
      `-DAFTERNOTE_OWNER_CONTROL_MACH_SERVICE=${JSON.stringify(ownerService)}`,
      `-DAFTERNOTE_BROKER_CODE_REQUIREMENT=${JSON.stringify(gatewayCodeRequirement)}`,
      "-framework",
      "AppKit",
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-framework",
      "UniformTypeIdentifiers",
      join(import.meta.dir, "../native/broker_recovery_state.mm"),
      join(import.meta.dir, "../native/connector_overview.mm"),
      join(import.meta.dir, "../native/connector_presentation.mm"),
      join(import.meta.dir, "../native/note_editor_state.mm"),
      join(import.meta.dir, "../native/setup_guide_state.mm"),
      join(import.meta.dir, "../native/plain_text_list_formatting.mm"),
      join(import.meta.dir, "../native/application_installation.mm"),
      join(import.meta.dir, "../native/owner_broker.mm"),
      join(import.meta.dir, "../native/product_surface_router.mm"),
      join(import.meta.dir, "../native/software_update.mm"),
      join(import.meta.dir, "../native/owner_control_app.mm"),
      join(import.meta.dir, "../native/owner_broker_contract.mm"),
      join(import.meta.dir, "../native/native_appearance.mm"),
      join(import.meta.dir, "../native/connections_view.mm"),
      join(import.meta.dir, "../native/note_editor_view.mm"),
      "-o",
      ownerControlPath,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(ownerControlBuild.exitCode, ownerControlBuild.stderr.toString()).toBe(0);
    const signedOwnerControl = Bun.spawnSync([
      "codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      "dev.afternote.owner-control.test",
      ownerControlPath,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(signedOwnerControl.exitCode, signedOwnerControl.stderr.toString()).toBe(0);
    const formattingSmoke = Bun.spawnSync([
      ownerControlPath,
      "--formatting-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(formattingSmoke.exitCode, formattingSmoke.stderr.toString()).toBe(0);
    expect(JSON.parse(formattingSmoke.stdout.toString())).toEqual({
      continuesLists: true,
      exitsEmptyList: true,
      indentsSelectedListItems: true,
      indentsListAtEndOfNote: true,
      leavesPlainParagraphsAlone: true,
      outdentsSelectedListItems: true,
      preservesMixedLists: true,
      startsEmptyList: true,
      togglesChecklists: true,
      togglesLists: true,
    });
    const connectorHistorySmoke = Bun.spawnSync([
      ownerControlPath,
      "--connector-history-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      connectorHistorySmoke.exitCode,
      connectorHistorySmoke.stderr.toString(),
    ).toBe(0);
    expect(JSON.parse(connectorHistorySmoke.stdout.toString())).toEqual({
      capsAtTwelve: true,
      deduplicatesLifecycleRecords: true,
      expiredDoesNotConnect: true,
      excludesUnrelatedGrants: true,
      newestFirst: true,
      preservesReconnects: true,
    });
    const searchSubmissionSmoke = Bun.spawnSync([
      ownerControlPath,
      "--library-search-submission-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      searchSubmissionSmoke.exitCode,
      searchSubmissionSmoke.stderr.toString(),
    ).toBe(0);
    expect(JSON.parse(searchSubmissionSmoke.stdout.toString())).toEqual({
      explicitActionSubmittedOnce: true,
      focusUsesOuterComposer: true,
      multilineEnabled: true,
      placeholderMatchesProductCopy: true,
      pauseDidNotSubmit: true,
      searchIconDoesNotOverlapText: true,
      typedThroughFieldEditor: true,
      verticallyAligned: true,
    });
    const searchStateSmoke = Bun.spawnSync([
      ownerControlPath,
      "--search-state-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      searchStateSmoke.exitCode,
      searchStateSmoke.stderr.toString(),
    ).toBe(0);
    expect(JSON.parse(searchStateSmoke.stdout.toString())).toEqual({
      newSearchReplacedResults: true,
      pageAppendPreservedResults: true,
    });
    const revisionNavigationSmoke = Bun.spawnSync([
      ownerControlPath,
      "--revision-navigation-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      revisionNavigationSmoke.exitCode,
      revisionNavigationSmoke.stderr.toString(),
    ).toBe(0);
    expect(JSON.parse(revisionNavigationSmoke.stdout.toString())).toEqual({
      historicalRevisionReturnsToCurrent: true,
    });
    const cleanupSmoke = Bun.spawnSync([
      ownerControlPath,
      "--library-cleanup-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(cleanupSmoke.exitCode, cleanupSmoke.stderr.toString()).toBe(0);
    expect(JSON.parse(cleanupSmoke.stdout.toString())).toEqual({
      bundlePlistPlaintext: false,
      crossSurfaceMalformedOwnerCleared: true,
      disconnectCleared: true,
      expiryCleared: true,
      lifecycleEpochConsistency: true,
      lifecycleStatusErrorRemainsLocked: true,
      malformedResponseRejected: true,
      malformedAuditRelationshipsRejected: true,
      malformedLifecycleStatusRemainsLocked: true,
      manualResumeRendered: true,
      nonReadyRecoveryClearedAuthority: true,
      recoveryErrorPersisted: true,
      recoveryOperationSerialized: true,
      lockedLibraryFeedback: true,
      lockedResponseFeedback: true,
      processArgumentsPlaintext: false,
      protocolInvalidationCleared: true,
      sensitiveSheetCleared: true,
      serializedPlaintext: false,
      spoofedUnlockRemainsLocked: true,
      staleReplyRejected: true,
      staleLifecycleStatusIgnored: true,
      staleOwnerReplyRejected: true,
      staleRecoveryReplyRejected: true,
      staleRevocationReplyRejected: true,
      statusPlaintext: false,
      unlockedLibraryFeedback: true,
      undoHistoryCleared: true,
      validReservedAuditAccepted: true,
    });
    expect(cleanupSmoke.stdout.toString()).not.toContain("PLAINTEXT-CLEANUP-CANARY");
    for (const filename of [
      "afternote_sqlcipher.node",
      "libsqlcipher.3.dylib",
      "libcrypto.4.dylib",
    ]) {
      copyFileSync(join(import.meta.dir, "../native/build", filename), join(directory, filename));
    }
    expect(existsSync(gatewayPath)).toBe(true);
    const promptLifetimeSmoke = Bun.spawnSync([
      gatewayPath,
      "--owner-prompt-lifetime-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(promptLifetimeSmoke.exitCode, promptLifetimeSmoke.stderr.toString()).toBe(0);
    expect(JSON.parse(promptLifetimeSmoke.stdout.toString())).toEqual({
      closedPeerRejected: true,
      disconnectInvalidated: true,
      otherPeerPreserved: true,
      shortDeadlineBounded: true,
    });
    const build = Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      `--define=AFTERNOTE_BUILD_VERSION=${JSON.stringify("2.0.0-test.0")}`,
      "--define=AFTERNOTE_BROKER_TESTING=true",
      "--define=AFTERNOTE_ACCEPTANCE_TRACE=true",
      join(import.meta.dir, "vault-broker-worker-main.ts"),
      `--outfile=${workerPath}`,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const signedWorker = Bun.spawnSync([
      "codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      `${service}.worker`,
      workerPath,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(signedWorker.exitCode, signedWorker.stderr.toString()).toBe(0);
    const workerCodeRequirement = designatedRequirement(workerPath);
    const clientCodeRequirement = "";
    const ownerControlRequirement = exactCodeRequirement(ownerControlPath);

    const directWorker = Bun.spawn([workerPath], {
      env: stringEnvironment({
        AFTERNOTE_TEST_GATEWAY_CODE_REQUIREMENT: gatewayCodeRequirement,
        AFTERNOTE_VAULT_PATH: vaultPath,
        AFTERNOTE_TEST_VAULT_KEY_PATH: keyPath,
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    directWorker.stdin.write(`${JSON.stringify({
      kind: "client",
      peerRole: "memory-client",
      connectionId: randomUUID(),
      peerPid: process.pid,
      payload: {
        protocolVersion: 1,
        requestId: randomUUID(),
        method: "health",
        params: {},
      },
    })}\n`);
    directWorker.stdin.end();
    expect(await directWorker.exited).not.toBe(0);
    expect(await new Response(directWorker.stdout).text()).toBe("");
    expect(await new Response(directWorker.stderr).text()).toContain(
      "required code signature",
    );

    const primaryPlist = join(directory, "primary.plist");
    writeFileSync(primaryPlist, launchAgent({
      label,
      service,
      ownerService,
      gatewayPath,
      workerPath,
      directory,
      vaultPath,
      keyPath,
      gatewayCodeRequirement,
      workerCodeRequirement,
      clientCodeRequirement,
      ownerControlRequirement,
      closeFailurePath,
    }));
    const loaded = Bun.spawnSync([
      "/bin/launchctl",
      "bootstrap",
      `gui/${userId}`,
      primaryPlist,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      loaded.exitCode,
      [
        loaded.stderr.toString(),
        Bun.file(join(directory, "stderr.log")).size
          ? await Bun.file(join(directory, "stderr.log")).text()
          : "",
      ].join("\n"),
    ).toBe(0);
    loadedJobs.push(label);

    let health: ReturnType<typeof vaultBrokerHealth> | undefined;
    let healthError: unknown;
    const deadline = Date.now() + 5_000;
    while (!health && Date.now() < deadline) {
      try {
        health = vaultBrokerHealth({
          service,
          timeoutMs: 500,
          codeRequirement: gatewayCodeRequirement,
        });
      } catch (error) {
        healthError = error;
        await Bun.sleep(50);
      }
    }
    expect(
      health,
      [
        healthError instanceof Error ? healthError.message : String(healthError),
        Bun.file(join(directory, "stderr.log")).size
          ? await Bun.file(join(directory, "stderr.log")).text()
          : "",
      ].join("\n"),
    ).toMatchObject({
      protocolVersion: 1,
      publicMetadata: {
        applicationVersion: "2.0.0-test.0",
        brokerIdentifier: "dev.afternote.vault-broker",
        transport: "launchd-mach-service",
      },
    });
    expect(() => vaultBrokerHealth({
      service,
      timeoutMs: 500,
      codeRequirement: 'identifier "dev.afternote.invalid"',
    })).toThrow("unavailable");
    expect(() => requestVaultBrokerXpc(
      workerService,
      gatewayCodeRequirement,
      JSON.stringify({
        protocolVersion: 1,
        responseTo: 0,
        response: null,
        terminate: false,
      }),
      500,
    )).toThrow(/unavailable|timed out/);
    const migrated = Bun.spawnSync([
      ownerControlPath,
      "--admin-migrate",
      "delete",
      "delete",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(migrated.exitCode, migrated.stderr.toString()).toBe(0);
    expect(JSON.parse(migrated.stdout.toString())).toMatchObject({
      migrated: true,
      state: "unlocked",
      encryptedRollbackCreated: true,
      legacyPlaintextRetained: false,
      legacyArtifacts: { found: 0, retained: 0 },
    });
    expect(readFileSync(vaultPath).subarray(0, 16).toString())
      .not.toBe("SQLite format 3\0");
    expect(() => requestVaultBroker("owner.session.begin", {
      requestedScopes: ["owner.inspect_clients"],
      ttlMs: 300_000,
    }, {
      service,
      timeoutMs: 500,
      codeRequirement: gatewayCodeRequirement,
    })).toThrow("trusted client role");
    expect(() => requestVaultBroker("owner.session.begin", {
      requestedScopes: ["owner.inspect_clients"],
      ttlMs: 300_000,
    }, {
      service: ownerService,
      timeoutMs: 500,
      codeRequirement: gatewayCodeRequirement,
    })).toThrow("unavailable");
    const ownerSmoke = Bun.spawnSync([ownerControlPath, "--protocol-smoke"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(ownerSmoke.exitCode, ownerSmoke.stderr.toString()).toBe(0);
    expect(JSON.parse(ownerSmoke.stdout.toString())).toMatchObject({
      connectorOverview: { connectors: [] },
      session: {
        scopes: [
          "owner.inspect_clients",
          "owner.inspect_grants",
          "owner.inspect_sessions",
          "owner.inspect_audit",
        ],
      },
      connections: { clients: [], grants: [], sessions: [] },
      librarySession: {
        scopes: [
          "library.browse",
          "library.search",
          "library.get_note",
          "library.list_revisions",
          "library.inspect_source",
          "library.remember",
          "library.update_note",
        ],
      },
      libraryViews: {
        views: [
          { id: "decisions", label: "Decisions", noteCount: 0 },
          { id: "commitments", label: "Commitments", noteCount: 0 },
          { id: "meetings", label: "Meetings", noteCount: 0 },
        ],
      },
      library: { notes: [], nextCursor: null },
    });
    const diagnostics = Bun.spawnSync([ownerControlPath, "--admin-diagnostics"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(diagnostics.exitCode, diagnostics.stderr.toString()).toBe(0);
    expect(JSON.parse(diagnostics.stdout.toString())).toMatchObject({
      format: "afternote-diagnostics",
      runtime: { networkBoundary: "broker-only" },
      vault: { integrity: "ok", noteCountBucket: "0" },
    });
    const exportPath = join(directory, "broker-export.json");
    const exported = Bun.spawnSync([
      ownerControlPath,
      "--admin-export",
      "json",
      exportPath,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(exported.exitCode, [
      exported.stderr.toString(),
      existsSync(join(directory, "stderr.log"))
        ? readFileSync(join(directory, "stderr.log"), "utf8")
        : "",
    ].join("\n")).toBe(0);
    expect(JSON.parse(exported.stdout.toString())).toMatchObject({
      exported: true,
      destination: exportPath,
      format: "afternote-vault-v1",
    });
    expect(JSON.parse(readFileSync(exportPath, "utf8"))).toMatchObject({
      format: "afternote-vault",
      notes: [],
    });
    const locked = Bun.spawnSync([ownerControlPath, "--lifecycle-peer-invalidation-smoke"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(locked.exitCode, locked.stderr.toString()).toBe(0);
    const lockSmoke = JSON.parse(locked.stdout.toString());
    expect(lockSmoke.observerInvalidated).toBe(true);
    expect(lockSmoke.prior).toMatchObject({ state: "unlocked" });
    const lockedResult = lockSmoke.result;
    expect(lockedResult).toMatchObject({ state: "locked" });
    const diagnosticsWhileLocked = Bun.spawnSync(
      [ownerControlPath, "--admin-diagnostics"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(diagnosticsWhileLocked.exitCode).not.toBe(0);
    expect(diagnosticsWhileLocked.stdout.toString()).toBe("");
    expect(diagnosticsWhileLocked.stderr.toString()).toContain("vault_locked");
    const unlocked = Bun.spawnSync([ownerControlPath, "--admin-unlock"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unlocked.exitCode, unlocked.stderr.toString()).toBe(0);
    const unlockedResult = JSON.parse(unlocked.stdout.toString());
    expect(unlockedResult).toMatchObject({ state: "unlocked" });
    expect(unlockedResult.epoch).not.toBe(lockedResult.epoch);
    const lockedViaAdmin = Bun.spawnSync([ownerControlPath, "--admin-lock"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(lockedViaAdmin.exitCode, lockedViaAdmin.stderr.toString()).toBe(0);
    const lockedViaAdminResult = JSON.parse(lockedViaAdmin.stdout.toString());
    expect(lockedViaAdminResult).toEqual({
      state: "locked",
      epoch: unlockedResult.epoch,
    });
    const finalUnlock = Bun.spawnSync([ownerControlPath, "--admin-unlock"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(finalUnlock.exitCode, finalUnlock.stderr.toString()).toBe(0);
    const finalUnlockedResult = JSON.parse(finalUnlock.stdout.toString());
    expect(finalUnlockedResult).toMatchObject({ state: "unlocked" });
    expect(finalUnlockedResult.epoch).not.toBe(lockedViaAdminResult.epoch);
    writeFileSync(closeFailurePath, "fail-once", { mode: 0o600 });
    const teardownFailure = Bun.spawnSync(
      [ownerControlPath, "--lifecycle-teardown-failure-smoke"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(teardownFailure.exitCode, teardownFailure.stderr.toString()).toBe(0);
    const teardownFailureResult = JSON.parse(teardownFailure.stdout.toString());
    expect(teardownFailureResult).toMatchObject({
      observerInvalidated: true,
      prior: { state: "unlocked", epoch: finalUnlockedResult.epoch },
      error: { code: "lifecycle_transition_failed" },
    });
    expect(existsSync(closeFailurePath)).toBe(false);
    const restartDeadline = Date.now() + 20_000;
    let restartedHealth: ReturnType<typeof vaultBrokerHealth> | undefined;
    while (!restartedHealth && Date.now() < restartDeadline) {
      try {
        restartedHealth = vaultBrokerHealth({
          service,
          timeoutMs: 500,
          codeRequirement: gatewayCodeRequirement,
        });
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(restartedHealth).toBeDefined();
    const recoveredUnlock = Bun.spawnSync([ownerControlPath, "--admin-unlock"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(recoveredUnlock.exitCode, recoveredUnlock.stderr.toString()).toBe(0);
    const recoveredUnlockedResult = JSON.parse(recoveredUnlock.stdout.toString());
    expect(recoveredUnlockedResult).toMatchObject({ state: "unlocked" });
    expect(recoveredUnlockedResult.epoch).not.toBe(finalUnlockedResult.epoch);
    const wrongOwnerPath = join(directory, "wrong-owner-control-test");
    const wrongOwnerBuild = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O0",
      "-fobjc-arc",
      "-fblocks",
      "-DAFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING=1",
      `-DAFTERNOTE_OWNER_CONTROL_MACH_SERVICE=${JSON.stringify(ownerService)}`,
      `-DAFTERNOTE_BROKER_CODE_REQUIREMENT=${JSON.stringify(gatewayCodeRequirement)}`,
      "-framework",
      "AppKit",
      "-framework",
      "Foundation",
      "-framework",
      "Security",
      "-framework",
      "UniformTypeIdentifiers",
      join(import.meta.dir, "../native/broker_recovery_state.mm"),
      join(import.meta.dir, "../native/connector_overview.mm"),
      join(import.meta.dir, "../native/connector_presentation.mm"),
      join(import.meta.dir, "../native/note_editor_state.mm"),
      join(import.meta.dir, "../native/setup_guide_state.mm"),
      join(import.meta.dir, "../native/plain_text_list_formatting.mm"),
      join(import.meta.dir, "../native/application_installation.mm"),
      join(import.meta.dir, "../native/owner_broker.mm"),
      join(import.meta.dir, "../native/product_surface_router.mm"),
      join(import.meta.dir, "../native/software_update.mm"),
      join(import.meta.dir, "../native/owner_control_app.mm"),
      join(import.meta.dir, "../native/owner_broker_contract.mm"),
      join(import.meta.dir, "../native/native_appearance.mm"),
      join(import.meta.dir, "../native/connections_view.mm"),
      join(import.meta.dir, "../native/note_editor_view.mm"),
      "-o",
      wrongOwnerPath,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      wrongOwnerBuild.exitCode,
      wrongOwnerBuild.stderr.toString(),
    ).toBe(0);
    const signedWrongOwner = Bun.spawnSync([
      "codesign",
      "--force",
      "--sign",
      "-",
      "--identifier",
      "dev.afternote.owner-control.test",
      wrongOwnerPath,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(signedWrongOwner.exitCode, signedWrongOwner.stderr.toString()).toBe(0);
    const wrongOwner = Bun.spawnSync([wrongOwnerPath, "--protocol-smoke"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(wrongOwner.exitCode).not.toBe(0);
    expect(wrongOwner.stdout.toString()).toBe("");
    const unsignedOwnerPath = join(directory, "unsigned-owner-control-test");
    copyFileSync(ownerControlPath, unsignedOwnerPath);
    const removedOwnerSignature = Bun.spawnSync([
      "codesign",
      "--remove-signature",
      unsignedOwnerPath,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      removedOwnerSignature.exitCode,
      removedOwnerSignature.stderr.toString(),
    ).toBe(0);
    const unsignedOwner = Bun.spawnSync([unsignedOwnerPath, "--protocol-smoke"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(unsignedOwner.exitCode).not.toBe(0);
    expect(unsignedOwner.stdout.toString()).toBe("");

    const durable = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const signer: DurableClientSigner = {
      publicKey: durable.publicKey,
      signingMode: "development-exact-build",
      sign(message) {
        return sign("sha256", Buffer.from(message), durable.privateKey)
          .toString("base64url");
      },
    };
    const clientPrivateKeyPath = join(directory, "test-client-private-key.pem");
    writeFileSync(clientPrivateKeyPath, durable.privateKey, { mode: 0o600 });
    const memory = VaultBrokerMemoryClient.activate("codex", {
      service,
      clientStatePath: join(directory, "codex-client.json"),
      signer,
      codeRequirement: gatewayCodeRequirement,
    });
    const server = await createAfternoteMcpServer(memory, memory.vault);
    const client = new Client({ name: "codex-shaped-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "get_note",
        "recall",
        "remember",
      ]);
      const remembered = await client.callTool({
        name: "remember",
        arguments: { content: "Mach service MCP trace canary: juniper-441." },
      });
      const noteId = (remembered.structuredContent as { note: { id: string } }).note.id;
      const recalled = await client.callTool({
        name: "recall",
        arguments: { query: "Which MCP trace canary used juniper?" },
      });
      expect(recalled.structuredContent).toMatchObject({
        results: [{
          note: { id: noteId, revision: 1 },
          citation: { noteId, revision: 1 },
        }],
      });
      const got = await client.callTool({
        name: "get_note",
        arguments: { id: noteId },
      });
      expect(got.structuredContent).toMatchObject({
        note: { id: noteId, revision: 1 },
      });
      await expect(client.callTool({
        name: "forget",
        arguments: { id: noteId },
      })).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }

    const claudeDurable = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const claudeMemory = VaultBrokerMemoryClient.activate("claude-desktop", {
      service,
      clientStatePath: join(directory, "claude-desktop-client.json"),
      signer: {
        publicKey: claudeDurable.publicKey,
        signingMode: "development-exact-build",
        sign(message) {
          return sign("sha256", Buffer.from(message), claudeDurable.privateKey)
            .toString("base64url");
        },
      },
      codeRequirement: gatewayCodeRequirement,
    });
    const claudeServer = await createAfternoteMcpServer(
      claudeMemory,
      claudeMemory.vault,
      { sourceApplication: "Claude Desktop" },
    );
    const claudeClient = new Client({ name: "claude-desktop-shaped-test", version: "1.0.0" });
    const [claudeClientTransport, claudeServerTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      claudeClient.connect(claudeClientTransport),
      claudeServer.connect(claudeServerTransport),
    ]);
    try {
      const remembered = await claudeClient.callTool({
        name: "remember",
        arguments: { content: "Claude Desktop activity canary: cedar-731." },
      });
      const noteId = (remembered.structuredContent as { note: { id: string } }).note.id;
      await claudeClient.callTool({
        name: "recall",
        arguments: { query: "Which Claude Desktop activity canary used cedar?" },
      });
      expect(remembered.structuredContent).toMatchObject({
        note: { id: noteId, source: { application: "Claude Desktop" } },
      });
    } finally {
      await claudeClient.close();
      await claudeServer.close();
    }

    const activitySmoke = Bun.spawnSync([ownerControlPath, "--protocol-smoke"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(activitySmoke.exitCode, activitySmoke.stderr.toString()).toBe(0);
    expect(JSON.parse(activitySmoke.stdout.toString())).toMatchObject({
      connectorOverview: {
        connectors: expect.arrayContaining([expect.objectContaining({
          kind: "claude-desktop",
          savedCount: 1,
          readCount: 1,
          verifiedRoundTrip: true,
        })]),
      },
    });

    const stdioClient = new Client({ name: "codex-stdio-trace", version: "1.0.0" });
    const testHostCodeRequirement = designatedRequirement(process.execPath);
    const shellLaunchedClient = Bun.spawnSync([
      process.execPath,
      "run",
      join(import.meta.dir, "mcp-broker-test-main.ts"),
    ], {
      env: stringEnvironment({
        AFTERNOTE_BROKER_MACH_SERVICE: service,
        AFTERNOTE_TEST_CLIENT_STATE_PATH: join(directory, "shell-client.json"),
        AFTERNOTE_TEST_CLIENT_PRIVATE_KEY_PATH: clientPrivateKeyPath,
        AFTERNOTE_TEST_BROKER_CODE_REQUIREMENT: gatewayCodeRequirement,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shellLaunchedClient.exitCode).not.toBe(0);
    expect(shellLaunchedClient.stderr.toString()).toContain(
      "Parent process does not satisfy the required code signature",
    );
    expect(existsSync(join(directory, "shell-client.json"))).toBe(false);

    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(import.meta.dir, "mcp-broker-test-main.ts")],
      env: stringEnvironment({
        AFTERNOTE_BROKER_MACH_SERVICE: service,
        AFTERNOTE_TEST_CLIENT_STATE_PATH: join(directory, "codex-client.json"),
        AFTERNOTE_TEST_CLIENT_PRIVATE_KEY_PATH: clientPrivateKeyPath,
        AFTERNOTE_TEST_BROKER_CODE_REQUIREMENT: gatewayCodeRequirement,
        AFTERNOTE_TEST_HOST_CODE_REQUIREMENT: testHostCodeRequirement,
      }),
      stderr: "pipe",
    });
    await stdioClient.connect(stdioTransport);
    try {
      expect((await stdioClient.listTools()).tools.map((tool) => tool.name).sort())
        .toEqual(["get_note", "recall", "remember"]);
      const remembered = await stdioClient.callTool({
        name: "remember",
        arguments: { content: "Complete stdio-to-broker trace: spruce-992." },
      });
      const noteId = (remembered.structuredContent as { note: { id: string } }).note.id;
      const recalled = await stdioClient.callTool({
        name: "recall",
        arguments: { query: "Which complete trace used spruce?" },
      });
      expect(
        (recalled.structuredContent as {
          results: Array<{ citation: { noteId: string; revision: number } }>;
        }).results[0]?.citation,
      ).toMatchObject({ noteId, revision: 1 });
    } finally {
      await stdioClient.close();
    }

    const legacyLock = join(directory, "dev.afternote.vault-broker.lock");
    const legacySocket = join(directory, "broker.sock");
    writeFileSync(legacyLock, "replaceable\n");
    writeFileSync(legacySocket, "replaceable\n");
    rmSync(legacyLock);
    rmSync(legacySocket);

    const duplicatePlist = join(directory, "duplicate.plist");
    writeFileSync(duplicatePlist, launchAgent({
      label: duplicateLabel,
      service,
      ownerService,
      gatewayPath,
      workerPath,
      directory,
      vaultPath,
      keyPath,
      gatewayCodeRequirement,
      workerCodeRequirement,
      clientCodeRequirement,
      ownerControlRequirement,
      closeFailurePath,
    }));
    const duplicate = Bun.spawnSync([
      "/bin/launchctl",
      "bootstrap",
      `gui/${userId}`,
      duplicatePlist,
    ], { stdout: "pipe", stderr: "pipe" });
    if (duplicate.exitCode === 0) loadedJobs.push(duplicateLabel);
    await Bun.sleep(250);
    expect(vaultBrokerHealth({
      service,
      codeRequirement: gatewayCodeRequirement,
    })).toMatchObject({
      bootId: recoveredUnlockedResult.epoch,
    });
  }, 45_000);

  it("routes packaged afternote restore through its signed native owner-control XPC boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-broker-restore-xpc-"));
    temporaryDirectories.push(directory);
    const suffix = randomUUID().toLowerCase();
    const service = `dev.afternote.vault-broker.acceptance.restore-${suffix}`;
    const ownerService = `${service}.owner-control`;
    const label = `${service}.primary`;
    const vaultPath = join(directory, "restored", "vault.db");
    const sourceVaultPath = join(directory, "source", "vault.db");
    const sourcePath = join(directory, "legacy-backup.afternote.json");
    const keyPath = join(directory, "test-vault-key");
    const closeFailurePath = join(directory, "inject-close-failure");
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    const sourceVault = localVaultContext(sourceVaultPath);
    const source = new SqliteMemory(sourceVaultPath, sourceVault);
    const note = await source.remember(sourceVault, {
      content: "signed native restore XPC canary",
    });
    source.exportInterchange(sourceVault, sourcePath, "2.0.0-test.0");
    source.close();

    const previousAcceptanceBuild = process.env.AFTERNOTE_ACCEPTANCE_BUILD;
    const previousAcceptanceService = process.env.AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE;
    let artifact: Awaited<ReturnType<typeof buildLocalAlpha>>;
    try {
      process.env.AFTERNOTE_ACCEPTANCE_BUILD = "1";
      process.env.AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE = service;
      artifact = await buildLocalAlpha({
        outputDirectory: join(directory, "package"),
        version: "2.0.0-test.0",
        developmentOwnerPresenceBypass: true,
      });
    } finally {
      if (previousAcceptanceBuild === undefined) delete process.env.AFTERNOTE_ACCEPTANCE_BUILD;
      else process.env.AFTERNOTE_ACCEPTANCE_BUILD = previousAcceptanceBuild;
      if (previousAcceptanceService === undefined) {
        delete process.env.AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE;
      } else {
        process.env.AFTERNOTE_ACCEPTANCE_BROKER_MACH_SERVICE = previousAcceptanceService;
      }
    }
    const gatewayPath = artifact.brokerBinaryPath;
    const workerPath = artifact.brokerWorkerPath;
    const ownerControlAppPath = artifact.ownerControlAppPath;
    const ownerControlPath = join(
      ownerControlAppPath,
      "Contents/MacOS/Afternote",
    );
    const gatewayCodeRequirement = designatedRequirement(gatewayPath);
    const primaryPlist = join(directory, "primary.plist");
    writeFileSync(primaryPlist, launchAgent({
      label,
      service,
      ownerService,
      gatewayPath,
      workerPath,
      directory,
      vaultPath,
      keyPath,
      gatewayCodeRequirement,
      workerCodeRequirement: designatedRequirement(workerPath),
      clientCodeRequirement: "",
      ownerControlRequirement: exactCodeRequirement(ownerControlAppPath),
      closeFailurePath,
    }));
    const loaded = Bun.spawnSync([
      "/bin/launchctl", "bootstrap", `gui/${userId}`, primaryPlist,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(loaded.exitCode, loaded.stderr.toString()).toBe(0);
    loadedJobs.push(label);

    const restored = Bun.spawnSync([
      artifact.binaryPath, "restore", sourcePath,
    ], {
      env: { ...process.env, AFTERNOTE_VAULT_PATH: vaultPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(restored.exitCode, restored.stderr.toString()).toBe(0);
    const result = JSON.parse(restored.stdout.toString());
    expect(result).toMatchObject({
      restored: true,
      state: "unlocked",
      noteCount: 1,
      format: "afternote-vault-v1",
    });
    expect(JSON.stringify(result)).not.toContain(sourcePath);
    expect(JSON.stringify(result)).not.toContain(vaultPath);
    expect(readFileSync(vaultPath).subarray(0, 16).toString())
      .not.toBe("SQLite format 3\0");
    const ownerSmoke = Bun.spawnSync([ownerControlPath, "--protocol-smoke"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(ownerSmoke.exitCode, ownerSmoke.stderr.toString()).toBe(0);
    expect(ownerSmoke.stdout.toString()).toContain(note.id);
    expect(ownerSmoke.stdout.toString()).toContain("signed native restore XPC canary");
  }, 90_000);

});

function launchAgent(input: {
  label: string;
  service: string;
  ownerService: string;
  gatewayPath: string;
  workerPath: string;
  directory: string;
  vaultPath: string;
  keyPath?: string;
  gatewayCodeRequirement: string;
  workerCodeRequirement: string;
  clientCodeRequirement: string;
  ownerControlRequirement: string;
  closeFailurePath: string;
}): string {
  const workerService = `${input.service}.private-worker`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${input.label}</string>
<key>ProgramArguments</key><array><string>${input.gatewayPath}</string></array>
<key>EnvironmentVariables</key><dict>
<key>AFTERNOTE_BROKER_MACH_SERVICE</key><string>${input.service}</string>
<key>AFTERNOTE_OWNER_CONTROL_MACH_SERVICE</key><string>${input.ownerService}</string>
<key>AFTERNOTE_WORKER_GATEWAY_MACH_SERVICE</key><string>${workerService}</string>
<key>AFTERNOTE_BROKER_WORKER_PATH</key><string>${input.workerPath}</string>
<key>AFTERNOTE_OWNER_PRESENCE_TEST_MODE</key><string>approve</string>
<key>AFTERNOTE_VAULT_PATH</key><string>${input.vaultPath}</string>
${input.keyPath
    ? `<key>AFTERNOTE_TEST_VAULT_KEY_PATH</key><string>${input.keyPath}</string>`
    : ""}
<key>AFTERNOTE_TEST_GATEWAY_CODE_REQUIREMENT</key><string>${input.gatewayCodeRequirement}</string>
<key>AFTERNOTE_TEST_WORKER_CODE_REQUIREMENT</key><string>${input.workerCodeRequirement}</string>
<key>AFTERNOTE_TEST_CLIENT_CODE_REQUIREMENT</key><string>${input.clientCodeRequirement}</string>
<key>AFTERNOTE_TEST_OWNER_CONTROL_CODE_REQUIREMENT</key><string>${input.ownerControlRequirement}</string>
<key>AFTERNOTE_TEST_VAULT_CLOSE_FAILURE_PATH</key><string>${input.closeFailurePath}</string>
</dict>
<key>MachServices</key><dict><key>${input.service}</key><true/><key>${input.ownerService}</key><true/><key>${workerService}</key><true/></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>1</integer>
<key>StandardOutPath</key><string>${join(input.directory, "stdout.log")}</string>
<key>StandardErrorPath</key><string>${join(input.directory, "stderr.log")}</string>
</dict></plist>\n`;
}

function designatedRequirement(path: string): string {
  const result = Bun.spawnSync(["codesign", "-d", "-r-", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const requirement = `${result.stdout.toString()}\n${result.stderr.toString()}`
    .match(/(?:# )?designated => (.+)/)?.[1];
  if (!requirement) throw new Error(`Could not read code requirement for ${path}`);
  return requirement.trim();
}

function exactCodeRequirement(path: string): string {
  const designated = designatedRequirement(path);
  if (/\bcdhash H"[a-f0-9]{40,64}"/i.test(designated)) return designated;
  const details = Bun.spawnSync(["codesign", "-d", "--verbose=4", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(details.exitCode, details.stderr.toString()).toBe(0);
  const cdHash = `${details.stdout.toString()}\n${details.stderr.toString()}`
    .match(/(?:^|\n)CDHash=([a-f0-9]{40,64})(?:\n|$)/i)?.[1];
  if (!cdHash) throw new Error(`Could not read code-directory hash for ${path}`);
  return `${designated} and cdhash H"${cdHash}"`;
}

function stringEnvironment(overrides: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...overrides,
  };
}
