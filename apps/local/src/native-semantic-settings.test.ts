import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;
describeMacos("native semantic settings", () => {
  it("requires explicit installation, rejects malformed and stale replies, and offers retry and activation", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-semantic-ui-"));
    try {
      const runner = join(directory, "semantic-settings-smoke");
      const build = Bun.spawnSync([
        "clang++", "-std=c++17", "-O2", "-fobjc-arc", "-fblocks", "-framework", "AppKit",
        join(import.meta.dir, "../native/native_appearance.mm"),
        join(import.meta.dir, "../native/semantic_settings.mm"),
        join(import.meta.dir, "../native/semantic_settings_smoke.mm"), "-o", runner,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const smoke = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
      expect(smoke.exitCode, smoke.stdout.toString() + smoke.stderr.toString()).toBe(0);
      expect(Object.values(JSON.parse(smoke.stdout.toString()))).toEqual(Array(16).fill(true));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
