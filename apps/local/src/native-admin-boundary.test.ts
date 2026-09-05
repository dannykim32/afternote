import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const sourceDirectory = import.meta.dir;
const nativeAppSource = readFileSync(
  join(sourceDirectory, "../native/owner_control_app.mm"),
  "utf8",
);
const cliSource = readFileSync(join(sourceDirectory, "local-cli.ts"), "utf8");
const gatewaySource = readFileSync(
  join(sourceDirectory, "../native/vault_broker_gateway.mm"),
  "utf8",
);
const sqlcipherAddonSource = readFileSync(
  join(sourceDirectory, "../native/sqlcipher_addon.cc"),
  "utf8",
);

describe("native owner administration production boundary", () => {
  it("routes public admin commands through the signed owner-control executable", () => {
    expect(cliSource).toContain("runNativeAdminCommand");
    expect(cliSource).toContain('"--admin-export"');
    expect(cliSource).toContain('"--admin-diagnostics"');
    expect(cliSource).toContain('"--admin-telemetry"');
    expect(cliSource).toContain('"--admin-lock"');
    expect(cliSource).toContain('"--admin-unlock"');
    expect(cliSource).toContain('"--admin-migrate"');
    expect(cliSource).toContain('"--admin-restore"');
    expect(cliSource).toContain(
      '["--admin-prepare-client-rotation", McpClientIdentityKind, string, string]',
    );
    expect(cliSource).toContain("rotateMcpClientIdentity(kind");
    expect(cliSource).toContain(
      'join(homedir(), ".afternote", "clients", `${kind}.json`)',
    );
    for (const prohibited of [
      "ensureLocalRuntime(runtimeOptions())",
      "connectLocalRuntime(options)",
      "inspectStoppedVault(options.vaultPath",
      "getOrCreateKeychainVaultKey(localVaultContext(options.vaultPath)",
      "stoppedTelemetryStatus(options.vaultPath)",
      "migratePlaintextVault",
      "inventoryLegacyPlaintextArtifacts",
      "hasPlaintextSqliteHeader",
      "SqliteMemory.restoreInterchange",
      "getOrCreateKeychainVaultKey",
      "packagedVaultKeychainOptions",
    ]) {
      expect(cliSource).not.toContain(prohibited);
    }
  });

  it("allowlists the packaged worker environment", () => {
    expect(gatewaySource).toContain('value.rfind("HOME=", 0) == 0');
    expect(gatewaySource).toContain('value.rfind("TMPDIR=", 0) == 0');
    expect(gatewaySource).toContain(
      '#if defined(AFTERNOTE_GATEWAY_TESTING) || defined(AFTERNOTE_ACCEPTANCE_TRACE)',
    );
    expect(gatewaySource).not.toContain(
      'if (value.rfind("DYLD_LIBRARY_PATH=", 0) == 0) continue;',
    );
  });

  it("uses a PID-bound, mutually signed XPC channel for the private worker", () => {
    expect(gatewaySource).toContain("CreateWorkerListener");
    expect(gatewaySource).toContain(
      "xpc_connection_set_peer_code_signing_requirement(listener, requirement)",
    );
    expect(gatewaySource).toContain("peer_pid != worker->pid");
    expect(gatewaySource).not.toContain("fdopen(request_pipe[1]");
    expect(gatewaySource).not.toContain("fprintf(worker->input");
  });

  it("validates broker responses in the native helper and never accepts note plaintext", () => {
    expect(nativeAppSource).toContain("IsAdminResult");
    expect(nativeAppSource).toContain("RunAdminCommand");
    expect(nativeAppSource).toContain('admin.export');
    expect(nativeAppSource).toContain('admin.diagnostics');
    expect(nativeAppSource).toContain('admin.telemetry');
    expect(nativeAppSource).toContain('admin.prepare_client_rotation');
    expect(nativeAppSource).toContain('"--admin-prepare-client-rotation"');
    expect(nativeAppSource).toContain('@"prepared", @"kind", @"installIdentity", @"replacementInstallIdentity"');
    expect(nativeAppSource).toContain('isEqual:params[@"replacementInstallIdentity"]');
    expect(nativeAppSource).toContain(
      '(result[@"clientId"] == NSNull.null || IsUUID(result[@"clientId"]))',
    );
    expect(nativeAppSource).toContain('lifecycle.lock');
    expect(nativeAppSource).toContain('lifecycle.unlock');
    expect(nativeAppSource).toContain("IsLifecycleResult");
    expect(nativeAppSource).toContain('recovery.migrate');
    expect(nativeAppSource).toContain('"--admin-migrate"');
    expect(nativeAppSource).toContain('recovery.restore');
    expect(nativeAppSource).toContain('"--admin-restore"');
    expect(nativeAppSource).toContain("IsRecoveryResult");
    expect(nativeAppSource).toContain("afternote-diagnostics");
    expect(nativeAppSource).toContain("afternote-vault-v1");
    expect(nativeAppSource).toContain("afternote-markdown-v1");
    expect(nativeAppSource).not.toContain("SqliteMemory");
    expect(nativeAppSource).not.toContain("runtime.token");
  });

  it("keeps create-new and enroll-existing as distinct native Keychain operations", () => {
    expect(sqlcipherAddonSource).toContain(
      "napi_value CreateDataProtectionVaultKey(",
    );
    expect(sqlcipherAddonSource).toContain(
      '{"createDataProtectionVaultKey", nullptr, CreateDataProtectionVaultKey',
    );
    expect(sqlcipherAddonSource).not.toContain(
      '{"createDataProtectionVaultKey", nullptr, GetOrCreateDataProtectionVaultKey',
    );
    expect(sqlcipherAddonSource).toContain(
      'return Throw(environment, "Data-protection vault key already exists")',
    );
    expect(sqlcipherAddonSource).toContain(
      "std::memset(CFDataGetMutableBytePtr(key_data), 0, candidate_length)",
    );
    expect(sqlcipherAddonSource).toContain(
      "kSecAttrAccessibleWhenUnlockedThisDeviceOnly",
    );
    expect(sqlcipherAddonSource).not.toContain(
      "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly",
    );
    expect(sqlcipherAddonSource).toContain("SecItemUpdate(update_query, update)");
  });

  it("exposes owner-approved export and share-safe diagnostics in Settings", () => {
    expect(nativeAppSource).toContain('buttonWithTitle:@"Export notes"');
    expect(nativeAppSource).toContain('action:@selector(exportNotes:)');
    expect(nativeAppSource).toContain('buttonWithTitle:@"Save diagnostics"');
    expect(nativeAppSource).toContain('action:@selector(saveDiagnostics:)');
    expect(nativeAppSource).toContain('requestMethod:@"admin.export"');
    expect(nativeAppSource).toContain('requestMethod:@"admin.diagnostics"');
    expect(nativeAppSource).toContain("WriteExclusivePrivateData");
    expect(nativeAppSource).toContain("O_EXCL | O_NOFOLLOW");
  });

  it("provides a trackable feedback path without automatic diagnostic upload", () => {
    expect(nativeAppSource).toContain('buttonWithTitle:@"Send feedback"');
    expect(nativeAppSource).toContain('action:@selector(sendFeedback:)');
    expect(nativeAppSource).toContain(
      '@"mailto:hello@afternote.dev?subject=Afternote%20feedback"',
    );
    expect(nativeAppSource).not.toContain("uploadDiagnostics");
  });

  it("removes the loopback runtime and its bearer authority from the package", () => {
    expect(existsSync(join(sourceDirectory, "local-runtime.ts"))).toBe(false);
    expect(cliSource).not.toContain("runtime.token");
  });

  it("keeps unattended owner approval compile-time and development-only", () => {
    expect(gatewaySource).toContain("AFTERNOTE_DEVELOPMENT_OWNER_PRESENCE_BYPASS");
    expect(gatewaySource).toContain("Owner-presence bypass is restricted to development builds");
    expect(gatewaySource).toContain('return {true, "approved"};');
    expect(nativeAppSource).toContain("OWNER PRESENCE BYPASS ACTIVE");
    expect(nativeAppSource).toContain('return @"development-bypass"');
  });
});
