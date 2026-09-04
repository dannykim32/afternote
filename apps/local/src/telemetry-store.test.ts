import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import type { VaultContext } from "@afternote/memory";
import { LocalTelemetryStore } from "./telemetry-store";

const directories: string[] = [];
const vault: VaultContext = { vaultId: "a".repeat(64), deployment: "local" };

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LocalTelemetryStore", () => {
  it("persists explicit consent in an owner-only vault-bound state file", () => {
    const path = statePath();
    const first = new LocalTelemetryStore(path, vault, "2.0.0-test");
    expect(first.status()).toMatchObject({ enabled: false, nextPayload: null });

    const enabled = first.enable();
    expect(enabled.nextPayload).toMatchObject({
      applicationVersion: "2.0.0-test",
      telemetrySchemaVersion: 1,
    });
    expect(statSync(path).mode & 0o077).toBe(0);
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain(`"vaultId": "${vault.vaultId}"`);

    const reopened = new LocalTelemetryStore(path, vault, "2.0.1-test");
    expect(reopened.status().nextPayload).toMatchObject({
      installationId: enabled.nextPayload?.installationId,
      applicationVersion: "2.0.1-test",
    });
  });

  it("fails closed for corrupt, permissive, or differently bound state", () => {
    const path = statePath();
    writeFileSync(path, "not json", { mode: 0o600 });
    expect(new LocalTelemetryStore(path, vault, "test").status().enabled).toBe(false);

    writeFileSync(path, validEnabledState({ ...vault, vaultId: "b".repeat(64) }));
    expect(new LocalTelemetryStore(path, vault, "test").status().enabled).toBe(false);

    chmodSync(path, 0o644);
    writeFileSync(path, validEnabledState(vault));
    expect(new LocalTelemetryStore(path, vault, "test").status().enabled).toBe(false);
  });

  it("rotates expired identifiers and deletes them on disable", () => {
    const path = statePath();
    writeFileSync(
      path,
      validEnabledState(vault, "2000-01-01T00:00:00.000Z"),
      { mode: 0o600 },
    );
    const store = new LocalTelemetryStore(path, vault, "test");
    const rotated = store.status();
    expect(rotated.nextPayload?.installationId).not.toBe("A".repeat(43));
    expect(rotated.identifierCreatedAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(store.disable()).toMatchObject({
      enabled: false,
      identifierCreatedAt: null,
      identifierRotatesAt: null,
      nextPayload: null,
    });
    expect(readFileSync(path, "utf8")).not.toContain(
      rotated.nextPayload?.installationId ?? "unreachable",
    );
  });
});

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "afternote-telemetry-"));
  directories.push(directory);
  return join(directory, "telemetry.json");
}

function validEnabledState(
  stateVault: VaultContext,
  createdAt = new Date().toISOString(),
): string {
  return JSON.stringify({
    version: 1,
    vault: stateVault,
    enabled: true,
    installationId: "A".repeat(43),
    identifierCreatedAt: createdAt,
    updatedAt: createdAt,
  });
}
