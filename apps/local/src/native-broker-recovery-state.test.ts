import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("native broker recovery policy", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-broker-recovery-"));
  const runner = join(directory, "broker-recovery-state-smoke");

  beforeAll(() => {
    const build = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O2",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      join(import.meta.dir, "../native/broker_recovery_state.mm"),
      join(import.meta.dir, "../native/broker_recovery_state_smoke.mm"),
      "-o",
      runner,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("bounds transient retries and exposes deterministic backoff", () => {
    const result = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      firstDelayMs: 250,
      firstFailure: "retry",
      maxFailure: "unavailable",
      recovered: "recovered",
    });
  });
});
