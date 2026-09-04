import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ensureMcpClientIdentity,
  rotateMcpClientIdentity,
} from "./mcp-client-identity";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP development client identity rotation", () => {
  it("repairs an inaccessible exact-build identity once, then verifies the replacement", async () => {
    const calls: string[] = [];
    let stale = true;

    const result = await ensureMcpClientIdentity("codex", {
      probe: () => {
        calls.push("probe");
        if (stale) throw new Error("Could not read the development client key (-25308)");
        return { signingMode: "development-exact-build" as const };
      },
      rotate: async () => {
        calls.push("rotate");
        stale = false;
        return { rotated: true as const };
      },
    });

    expect(calls).toEqual(["probe", "rotate", "probe"]);
    expect(result).toEqual({
      healthy: true,
      kind: "codex",
      repaired: true,
      signingMode: "development-exact-build",
    });
  });

  it("does not rotate for an unrelated signer failure", async () => {
    let rotated = false;
    await expect(ensureMcpClientIdentity("claude", {
      probe: () => {
        throw new Error("Client signing-key tag is invalid");
      },
      rotate: async () => {
        rotated = true;
        return { rotated: true as const };
      },
    })).rejects.toThrow("tag is invalid");
    expect(rotated).toBe(false);
  });

  it("publishes a new owner-only identity only after exact owner approval", async () => {
    const fixture = identityFixture("codex");
    const replacementIdentity = "22222222-2222-4222-8222-222222222222";
    const requests: unknown[] = [];

    const result = await rotateMcpClientIdentity("codex", {
      statePath: fixture.statePath,
      generateInstallIdentity: () => replacementIdentity,
      now: () => new Date("2026-08-29T18:45:00.000Z"),
      approve: async (request) => {
        requests.push(request);
        return {
          prepared: true,
          kind: "codex",
          installIdentity: fixture.installIdentity,
          replacementInstallIdentity: replacementIdentity,
          clientId: "33333333-3333-4333-8333-333333333333",
        };
      },
    });

    expect(requests).toEqual([{
      kind: "codex",
      installIdentity: fixture.installIdentity,
      replacementInstallIdentity: replacementIdentity,
    }]);
    expect(result).toEqual({
      rotated: true,
      kind: "codex",
      previousInstallIdentity: fixture.installIdentity,
      installIdentity: replacementIdentity,
      backupPath: result.backupPath,
    });
    expect(readFileSync(result.backupPath, "utf8")).toBe(fixture.contents);
    expect(JSON.parse(readFileSync(fixture.statePath, "utf8"))).toEqual({
      format: "afternote-mcp-client",
      schemaVersion: 1,
      kind: "codex",
      installIdentity: replacementIdentity,
    });
    expect(lstatSync(result.backupPath).mode & 0o077).toBe(0);
    expect(lstatSync(fixture.statePath).mode & 0o077).toBe(0);
  });

  it("leaves the identity byte-for-byte unchanged without exact owner approval", async () => {
    const fixture = identityFixture("claude");
    for (const approve of [
      async () => {
        throw new Error("Owner authentication was denied");
      },
      async () => ({
        prepared: true as const,
        kind: "codex" as const,
        installIdentity: fixture.installIdentity,
        replacementInstallIdentity: "22222222-2222-4222-8222-222222222222",
        clientId: "33333333-3333-4333-8333-333333333333",
      }),
      async () => ({
        prepared: true as const,
        kind: "claude" as const,
        installIdentity: "44444444-4444-4444-8444-444444444444",
        replacementInstallIdentity: "22222222-2222-4222-8222-222222222222",
        clientId: "33333333-3333-4333-8333-333333333333",
      }),
    ]) {
      await expect(rotateMcpClientIdentity("claude", {
        statePath: fixture.statePath,
        generateInstallIdentity: () => "22222222-2222-4222-8222-222222222222",
        approve,
      })).rejects.toThrow();
      expect(readFileSync(fixture.statePath, "utf8")).toBe(fixture.contents);
    }
  });

  it("refuses unsafe or non-canonical identity state before owner approval", async () => {
    const directory = temporaryDirectory("afternote-mcp-identity-unsafe-");
    const valid = identityContents("codex", "11111111-1111-4111-8111-111111111111");
    const cases = [
      { name: "world-readable", prepare(path: string) {
        writeFileSync(path, valid, { mode: 0o644 });
        chmodSync(path, 0o644);
      } },
      { name: "symlink", prepare(path: string) {
        const target = join(directory, "target.json");
        writeFileSync(target, valid, { mode: 0o600 });
        symlinkSync(target, path);
      } },
      { name: "directory", prepare(path: string) { mkdirSync(path); } },
      { name: "extra-field", prepare(path: string) {
        writeFileSync(path, JSON.stringify({
          ...JSON.parse(valid),
          publicKey: "must-not-live-here",
        }), { mode: 0o600 });
      } },
    ];

    for (const candidate of cases) {
      const path = join(directory, `${candidate.name}.json`);
      candidate.prepare(path);
      let approvalCalled = false;
      await expect(rotateMcpClientIdentity("codex", {
        statePath: path,
        approve: async () => {
          approvalCalled = true;
          throw new Error("unreachable");
        },
      })).rejects.toThrow("owner-only regular file");
      expect(approvalCalled).toBe(false);
    }
  });

  it("refuses a pre-existing unsafe backup directory without following it", async () => {
    const fixture = identityFixture("codex");
    const outsideDirectory = temporaryDirectory("afternote-mcp-backup-target-");
    chmodSync(outsideDirectory, 0o755);
    symlinkSync(outsideDirectory, join(fixture.directory, "rotation-backups"));
    let approvalCalled = false;

    await expect(rotateMcpClientIdentity("codex", {
      statePath: fixture.statePath,
      generateInstallIdentity: () => "22222222-2222-4222-8222-222222222222",
      approve: async () => {
        approvalCalled = true;
        return {
          prepared: true,
          kind: "codex",
          installIdentity: fixture.installIdentity,
          replacementInstallIdentity: "22222222-2222-4222-8222-222222222222",
          clientId: "33333333-3333-4333-8333-333333333333",
        };
      },
    })).rejects.toThrow("backup directory must be an owner-only directory");

    expect(approvalCalled).toBe(false);
    expect(lstatSync(outsideDirectory).mode & 0o777).toBe(0o755);
    expect(readFileSync(fixture.statePath, "utf8")).toBe(fixture.contents);
  });
});

function identityFixture(kind: "codex" | "claude") {
  const directory = temporaryDirectory("afternote-mcp-identity-");
  const statePath = join(directory, `${kind}.json`);
  const installIdentity = "11111111-1111-4111-8111-111111111111";
  const contents = identityContents(kind, installIdentity);
  writeFileSync(statePath, contents, { mode: 0o600 });
  chmodSync(statePath, 0o600);
  return { directory, statePath, installIdentity, contents };
}

function identityContents(kind: "codex" | "claude", installIdentity: string): string {
  return `${JSON.stringify({
    format: "afternote-mcp-client",
    schemaVersion: 1,
    kind,
    installIdentity,
  }, null, 2)}\n`;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}
