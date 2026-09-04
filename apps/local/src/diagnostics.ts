import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { privateRegularFileInfo } from "./private-files";
import { SqlcipherDatabase } from "./sqlcipher-database";
import type { TelemetryStatus } from "./telemetry-store";

export const LOCAL_DIAGNOSTICS_API_VERSION = 7;

export type VaultDiagnosticSnapshot = {
  schemaVersion: number;
  integrity: "ok" | "failed" | "not-created";
  noteCount: number;
  revisionCount: number;
  databaseBytes: number;
};

type CountBucket = "0" | "1-9" | "10-99" | "100-999" | "1000+";
type ByteBucket = "under-1-mib" | "1-9-mib" | "10-99-mib" | "100-mib-plus";
export type DiagnosticErrorCode =
  | "runtime.unavailable"
  | "vault.unavailable"
  | "vault.permissions";

export function buildDiagnosticBundle(input: {
  applicationVersion: string;
  standalone: boolean;
  ownerPresenceMode?: "required" | "development-bypass";
  apiVersion: number;
  runtimeStatus?: "running" | "stopped" | "unavailable";
  networkBoundary?: "loopback-only" | "broker-only";
  vault: VaultDiagnosticSnapshot | null;
  telemetry: TelemetryStatus;
  errors?: DiagnosticErrorCode[];
}) {
  const runtimeStatus = input.runtimeStatus ?? "running";
  const errors = input.errors ?? [];
  return {
    format: "afternote-diagnostics",
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    application: {
      version: input.applicationVersion,
      standalone: input.standalone,
      ownerPresenceMode: input.ownerPresenceMode ?? "required",
    },
    system: {
      osFamily: process.platform,
      architecture: process.arch,
    },
    runtime: {
      status: runtimeStatus,
      apiVersion: input.apiVersion,
      networkBoundary: input.networkBoundary ?? "loopback-only",
    },
    vault: {
      schemaVersion: input.vault?.schemaVersion ?? null,
      integrity: input.vault?.integrity ?? "unknown",
      noteCountBucket: input.vault ? countBucket(input.vault.noteCount) : "unknown",
      revisionCountBucket: input.vault
        ? countBucket(input.vault.revisionCount)
        : "unknown",
      databaseBytesBucket: input.vault
        ? byteBucket(input.vault.databaseBytes)
        : "unknown",
    },
    telemetry: {
      enabled: input.telemetry.enabled,
      telemetrySchemaVersion: input.telemetry.telemetrySchemaVersion,
      transmission: input.telemetry.transmission,
    },
    checks: [
      {
        code: `runtime.${runtimeStatus}`,
        status: runtimeStatus === "unavailable" ? "failed" : "ok",
      },
      {
        code: "vault.integrity",
        status:
          input.vault?.integrity === "ok"
            ? "ok"
            : input.vault?.integrity === "not-created"
              ? "not-created"
              : "failed",
      },
      { code: "telemetry.transport", status: "not-configured" },
    ],
    errors: errors.map((code) => ({ code })),
  } as const;
}

export function inspectStoppedVault(path: string, encryptionKey?: Uint8Array): {
  vault: VaultDiagnosticSnapshot | null;
  errors: DiagnosticErrorCode[];
} {
  if (!existsSync(path)) {
    return {
      vault: {
        schemaVersion: 0,
        integrity: "not-created",
        noteCount: 0,
        revisionCount: 0,
        databaseBytes: 0,
      },
      errors: [],
    };
  }
  if (!privateRegularFileInfo(path)) {
    return { vault: null, errors: ["vault.permissions"] };
  }
  try {
    const database = encryptionKey
      ? new SqlcipherDatabase(path, { key: encryptionKey, readonly: true })
      : new Database(path, { readonly: true });
    try {
      const queryable = database as unknown as {
        query<Row>(sql: string): { get(): Row | undefined };
      };
      const schemaVersion = queryable
        .query<{ user_version: number }>("PRAGMA user_version;")
        .get()?.user_version ?? 0;
      const integrity = queryable
        .query<{ quick_check: string }>("PRAGMA quick_check;")
        .get()?.quick_check === "ok" ? "ok" : "failed";
      const noteCount = schemaVersion >= 1
        ? queryable.query<{ count: number }>("select count(*) as count from notes").get()?.count ?? 0
        : 0;
      const revisionCount = schemaVersion >= 2
        ? queryable.query<{ count: number }>("select count(*) as count from note_revisions").get()?.count ?? 0
        : 0;
      return {
        vault: {
          schemaVersion,
          integrity,
          noteCount,
          revisionCount,
          databaseBytes: privateDatabaseBytes(path),
        },
        errors: integrity === "ok" ? [] : ["vault.unavailable"],
      };
    } finally {
      database.close();
    }
  } catch {
    return { vault: null, errors: ["vault.unavailable"] };
  }
}

export function privateDatabaseBytes(path: string): number {
  return (privateRegularFileInfo(path)?.size ?? 0) +
    (privateRegularFileInfo(`${path}-wal`)?.size ?? 0);
}

function countBucket(value: number): CountBucket {
  if (value <= 0) return "0";
  if (value < 10) return "1-9";
  if (value < 100) return "10-99";
  if (value < 1_000) return "100-999";
  return "1000+";
}

function byteBucket(value: number): ByteBucket {
  if (value < 1024 * 1024) return "under-1-mib";
  if (value < 10 * 1024 * 1024) return "1-9-mib";
  if (value < 100 * 1024 * 1024) return "10-99-mib";
  return "100-mib-plus";
}
