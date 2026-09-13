import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { buildDiagnosticBundle } from "./diagnostics";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("native integration command runner", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-integration-runner-"));
  const runner = join(directory, "afternote-owner-control-test");

  beforeAll(() => {
    const build = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O2",
      "-fobjc-arc",
      "-fblocks",
      "-DAFTERNOTE_OWNER_CONTROL_PROTOCOL_TESTING=1",
      '-DAFTERNOTE_BROKER_CODE_REQUIREMENT="identifier \\\"dev.afternote.test\\\""',
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
      "-o",
      runner,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  }, 30_000);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const writeCommand = (name: string, source: string) => {
    const path = join(directory, name);
    writeFileSync(path, source, { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  };

  const run = (command: string, environment?: Record<string, string>) => {
    const smoke = Bun.spawnSync([
      runner,
      "--integration-command-smoke",
      command,
    ], {
      env: { ...process.env, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(
      smoke.exitCode,
      `${smoke.stderr.toString()}\n${smoke.stdout.toString()}`,
    ).toBe(0);
    return JSON.parse(smoke.stdout.toString()) as {
      result?: { healthy: boolean; installed: boolean };
      error?: string;
    };
  };

  it("accepts a healthy object result", () => {
    const command = writeCommand(
      "success",
      "#!/bin/sh\nprintf '{\"healthy\":true,\"installed\":true}\\n'\n",
    );
    expect(run(command)).toEqual({
      result: { healthy: true, installed: true },
    });
  });

  it("rejects malformed JSON and reports bounded command failures", () => {
    const malformed = writeCommand(
      "malformed",
      "#!/bin/sh\nprintf 'not-json\\n'\n",
    );
    const failed = writeCommand(
      "failed",
      "#!/bin/sh\nprintf 'client setup failed\\n' >&2\nexit 9\n",
    );
    expect(run(malformed)).toEqual({
      error: "Afternote returned an invalid integration status.",
    });
    expect(run(failed)).toEqual({ error: "client setup failed" });
  });

  it("reports a missing packaged command", () => {
    expect(run(join(directory, "missing"))).toEqual({
      error: "The packaged Afternote command could not be found.",
    });
  });

  it("terminates a packaged helper that exceeds the app deadline", () => {
    const hanging = writeCommand(
      "hanging",
      "#!/bin/sh\nexec /bin/sleep 10\n",
    );
    const startedAt = performance.now();
    expect(run(hanging, {
      AFTERNOTE_TEST_INTEGRATION_TIMEOUT_MS: "50",
    })).toEqual({ error: "Afternote integration setup timed out." });
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  it("keeps concurrent connector status generations independent", () => {
    const smoke = Bun.spawnSync([
      runner,
      "--integration-generation-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(smoke.exitCode, smoke.stderr.toString()).toBe(0);
    expect(JSON.parse(smoke.stdout.toString())).toEqual({
      claudeDesktopStatusStayedCurrent: true,
      claudeStatusStayedCurrent: true,
      codexInstallStayedCurrent: true,
      codexStatusBecameStale: true,
    });
  });

  it("opens cited search evidence read-only at its exact revision", () => {
    const smoke = Bun.spawnSync([
      runner,
      "--citation-inspector-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(smoke.exitCode, smoke.stderr.toString()).toBe(0);
    expect(JSON.parse(smoke.stdout.toString())).toEqual({
      browseUsesCurrent: true,
      citationUsesExactRevision: true,
    });
  });

  it("recovers a restarted broker without retaining plaintext or replaying mutations", () => {
    const smoke = Bun.spawnSync([
      runner,
      "--broker-recovery-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(
      smoke.exitCode,
      `${smoke.stderr.toString()}\n${smoke.stdout.toString()}`,
    ).toBe(0);
    expect(JSON.parse(smoke.stdout.toString())).toEqual({
      boundedFailure: true,
      disconnectRaceRestartsRecovery: true,
      freshGenerationClearsStaleAttempt: true,
      immediateAuthorityClear: true,
      lockedVaultRemainsActionable: true,
      recoversUnauthenticated: true,
      retriesWereBounded: true,
      zeroMutationReplay: true,
    });
  });

  it("rejects existing export destinations before the save panel accepts them", () => {
    const smoke = Bun.spawnSync([
      runner,
      "--save-destination-smoke",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(smoke.exitCode, smoke.stderr.toString()).toBe(0);
    expect(JSON.parse(smoke.stdout.toString())).toEqual({
      existingPathRejected: true,
      newPathAccepted: true,
      rejectionExplainsNoOverwrite: true,
    });
  });

  it("accepts the diagnostics object emitted by the broker", () => {
    const zeroCounts = () => ({ authorized: 0, success: 0, denied: 0, error: 0 });
    const fixture = buildDiagnosticBundle({
      applicationVersion: "2.0.0-test",
      standalone: true,
      ownerPresenceMode: "required",
      apiVersion: 7,
      runtimeStatus: "running",
      networkBoundary: "broker-only",
      vault: {
        schemaVersion: 10,
        integrity: "ok",
        noteCount: 12,
        revisionCount: 15,
        databaseBytes: 4096,
      },
      connectorActivity: (["codex", "claude", "claude-desktop"] as const).map(
        (kind) => ({
          kind,
          attributedNoteCount: kind === "claude-desktop" ? 2 : 0,
          operations: {
            remember: zeroCounts(),
            recall: zeroCounts(),
            getNote: zeroCounts(),
          },
        }),
      ),
    });
    const path = join(directory, "diagnostics.json");
    writeFileSync(path, JSON.stringify(fixture), { mode: 0o600 });
    const smoke = Bun.spawnSync([
      runner,
      "--diagnostic-contract-smoke",
      path,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(smoke.exitCode, smoke.stderr.toString()).toBe(0);
    expect(JSON.parse(smoke.stdout.toString())).toEqual({ accepted: true });
  });
});
