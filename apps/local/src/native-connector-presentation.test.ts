import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("native connector presentation", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-connector-state-"));
  const runner = join(directory, "connector-presentation-smoke");

  beforeAll(() => {
    const build = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O2",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      join(import.meta.dir, "../native/connector_presentation.mm"),
      join(import.meta.dir, "../native/connector_presentation_smoke.mm"),
      "-o",
      runner,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps every connector badge and action on one state table", () => {
    const result = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const rows = JSON.parse(result.stdout.toString()) as Array<{
      name: string;
      state: number;
      action: number;
      badge: string;
      summary: string;
    }>;
    expect(rows.map(({ name, badge, action }) => ({ name, badge, action }))).toEqual([
      { name: "connected-even-if-status-refreshes", badge: "Active", action: 0 },
      { name: "tool-missing", badge: "Not installed", action: 1 },
      { name: "available", badge: "Available", action: 2 },
      { name: "approval", badge: "Finish in Claude", action: 5 },
      { name: "revoked", badge: "Available", action: 3 },
      { name: "legacy", badge: "Needs attention", action: 4 },
      { name: "disabled", badge: "Disabled", action: 6 },
      { name: "runtime", badge: "Needs attention", action: 5 },
      { name: "identity", badge: "Needs attention", action: 5 },
      { name: "conflict", badge: "Needs attention", action: 6 },
      { name: "command-error", badge: "Needs attention", action: 5 },
    ]);
    expect(rows.find((row) => row.name === "command-error")?.summary).toBe(
      "Status command failed",
    );
  });
});
