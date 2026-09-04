import { randomBytes } from "node:crypto";
import type { VaultContext } from "@afternote/memory";
import { readFileSync } from "node:fs";
import { privateRegularFileInfo, writePrivateFile } from "./private-files";

const TELEMETRY_STATE_VERSION = 1;
export const TELEMETRY_SCHEMA_VERSION = 1;
const IDENTIFIER_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_TELEMETRY_STATE_BYTES = 16_000;

type TelemetryState = {
  version: typeof TELEMETRY_STATE_VERSION;
  vault: VaultContext;
  enabled: boolean;
  installationId: string | null;
  identifierCreatedAt: string | null;
  updatedAt: string;
};

export type TelemetryPayload = {
  telemetrySchemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  installationId: string;
  applicationVersion: string;
  osFamily: NodeJS.Platform;
  architecture: string;
};

export type TelemetryStatus = {
  enabled: boolean;
  telemetrySchemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  identifierCreatedAt: string | null;
  identifierRotatesAt: string | null;
  transmission: "not-configured";
  nextPayload: TelemetryPayload | null;
};

export class LocalTelemetryStore {
  #state: TelemetryState;

  constructor(
    private readonly statePath: string,
    private readonly vault: VaultContext,
    private readonly applicationVersion: string,
  ) {
    this.#state = readTelemetryState(statePath, vault);
  }

  status(): TelemetryStatus {
    this.#rotateIfExpired();
    return this.#statusView();
  }

  peekStatus(): TelemetryStatus {
    return this.#statusView();
  }

  enable(): TelemetryStatus {
    if (!this.#state.enabled || !this.#state.installationId) {
      const now = new Date().toISOString();
      this.#state = {
        version: TELEMETRY_STATE_VERSION,
        vault: this.vault,
        enabled: true,
        installationId: randomIdentifier(),
        identifierCreatedAt: now,
        updatedAt: now,
      };
      this.#persist();
    } else {
      this.#rotateIfExpired();
    }
    return this.#statusView();
  }

  disable(): TelemetryStatus {
    const now = new Date().toISOString();
    this.#state = {
      version: TELEMETRY_STATE_VERSION,
      vault: this.vault,
      enabled: false,
      installationId: null,
      identifierCreatedAt: null,
      updatedAt: now,
    };
    this.#persist();
    return this.#statusView();
  }

  reset(): TelemetryStatus {
    if (!this.#state.enabled) return this.disable();
    const now = new Date().toISOString();
    this.#state.installationId = randomIdentifier();
    this.#state.identifierCreatedAt = now;
    this.#state.updatedAt = now;
    this.#persist();
    return this.#statusView();
  }

  #rotateIfExpired(): void {
    if (!this.#state.enabled || !this.#state.identifierCreatedAt) return;
    const createdAt = Date.parse(this.#state.identifierCreatedAt);
    if (
      !Number.isFinite(createdAt) ||
      createdAt > Date.now() ||
      Date.now() - createdAt >= IDENTIFIER_LIFETIME_MS
    ) {
      const now = new Date().toISOString();
      this.#state.installationId = randomIdentifier();
      this.#state.identifierCreatedAt = now;
      this.#state.updatedAt = now;
      this.#persist();
    }
  }

  #statusView(): TelemetryStatus {
    const createdAt = this.#state.identifierCreatedAt;
    const enabled =
      this.#state.enabled && Boolean(this.#state.installationId && createdAt);
    return {
      enabled,
      telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
      identifierCreatedAt: enabled ? createdAt : null,
      identifierRotatesAt:
        enabled && createdAt
          ? new Date(Date.parse(createdAt) + IDENTIFIER_LIFETIME_MS).toISOString()
          : null,
      transmission: "not-configured",
      nextPayload:
        enabled && this.#state.installationId
          ? {
              telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
              installationId: this.#state.installationId,
              applicationVersion: this.applicationVersion,
              osFamily: process.platform,
              architecture: process.arch,
            }
          : null,
    };
  }

  #persist(): void {
    writePrivateFile(this.statePath, `${JSON.stringify(this.#state, null, 2)}\n`);
  }
}

function readTelemetryState(path: string, vault: VaultContext): TelemetryState {
  const disabled = (): TelemetryState => ({
    version: TELEMETRY_STATE_VERSION,
    vault,
    enabled: false,
    installationId: null,
    identifierCreatedAt: null,
    updatedAt: new Date(0).toISOString(),
  });
  const info = privateRegularFileInfo(path);
  if (!info || info.size > MAX_TELEMETRY_STATE_BYTES) return disabled();
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<TelemetryState>;
    if (
      value.version !== TELEMETRY_STATE_VERSION ||
      value.vault?.vaultId !== vault.vaultId ||
      value.vault?.deployment !== vault.deployment ||
      typeof value.enabled !== "boolean" ||
      typeof value.updatedAt !== "string" ||
      !isNormalizedTimestamp(value.updatedAt)
    ) return disabled();
    if (!value.enabled) return disabled();
    if (
      typeof value.installationId !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.installationId) ||
      typeof value.identifierCreatedAt !== "string" ||
      !isNormalizedTimestamp(value.identifierCreatedAt)
    ) return disabled();
    return value as TelemetryState;
  } catch {
    return disabled();
  }
}

function randomIdentifier(): string {
  return randomBytes(32).toString("base64url");
}

function isNormalizedTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
