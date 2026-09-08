import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { buildDiagnosticBundle, privateDatabaseBytes } from "./diagnostics";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("share-safe diagnostics", () => {
  it("includes live owner-only WAL bytes in the coarse database-size bucket", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-diagnostics-"));
    directories.push(directory);
    const path = join(directory, "vault.db");
    const database = new Database(path, { create: true });
    try {
      chmodSync(path, 0o600);
      database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      database.exec("create table payload (value blob not null);");
      database.query("insert into payload (value) values (?)").run(
        new Uint8Array(2 * 1024 * 1024),
      );
      const mainBytes = statSync(path).size;
      const liveBytes = privateDatabaseBytes(path);
      expect(liveBytes).toBeGreaterThan(mainBytes);

      const bundle = buildDiagnosticBundle({
        applicationVersion: "test",
        standalone: false,
        apiVersion: 6,
        vault: {
          schemaVersion: 4,
          integrity: "ok",
          noteCount: 0,
          revisionCount: 0,
          databaseBytes: liveBytes,
        },
      });
      expect(bundle.vault.databaseBytesBucket).toBe("1-9-mib");
      expect(bundle).not.toHaveProperty("telemetry");
      expect(bundle.checks.map((check) => check.code)).not.toContain(
        "telemetry.transport",
      );
    } finally {
      database.close();
    }
  });
});
