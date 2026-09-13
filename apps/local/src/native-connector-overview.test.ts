import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("native connector overview boundary", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-connector-overview-"));
  const runner = join(directory, "connector-overview-smoke");

  beforeAll(() => {
    const build = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O2",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      join(import.meta.dir, "../native/connector_overview.mm"),
      join(import.meta.dir, "../native/connector_overview_smoke.mm"),
      "-o",
      runner,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("parses only the redacted broker contract into typed connector state", () => {
    const result = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      accepted: true,
      active: true,
      rejectedExtraField: true,
      rejectedUnknownScope: true,
      savedCount: 2,
      verifiedRoundTrip: true,
    });
  });
});
