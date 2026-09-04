import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("native setup guide proof", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-setup-proof-"));
  const runner = join(directory, "setup-guide-state-smoke");

  beforeAll(() => {
    const build = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-O2",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      join(import.meta.dir, "../native/setup_guide_state.mm"),
      join(import.meta.dir, "../native/setup_guide_state_smoke.mm"),
      "-o",
      runner,
    ], { stdout: "pipe", stderr: "pipe" });
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires one successful save-to-cited-recall flow", () => {
    const result = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual([
      { name: "correlated", value: true },
      { name: "different-client", value: false },
      { name: "different-note", value: false },
      { name: "recall-before-save", value: false },
      { name: "failed-recall", value: false },
      { name: "missing-outcome", value: false },
    ]);
  });
});
