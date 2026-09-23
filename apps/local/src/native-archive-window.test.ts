import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";

(process.platform === "darwin" ? describe : describe.skip)("native Archive viewer", () => {
  it("bounds requests and clears plaintext on lock, expiry and late completions", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-archive-view-"));
    try {
      const runner = join(directory, "viewer");
      const build = Bun.spawnSync(["clang++", "-std=c++17", "-fobjc-arc", "-fblocks",
        "-framework", "AppKit", "-framework", "UniformTypeIdentifiers",
        ...["archive_window.mm", "archive_import.mm", "native_appearance.mm", "archive_window_smoke.mm"]
          .map((name) => join(import.meta.dir, "../native", name)), "-o", runner]);
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const screenshots = process.env.AFTERNOTE_ARCHIVE_SCREENSHOTS;
      const run = Bun.spawnSync([runner, ...(screenshots ? [screenshots] : [])]);
      expect(run.exitCode, run.stderr.toString()).toBe(0);
      expect(JSON.parse(run.stdout.toString())).toEqual({
        staleListIgnored: true, boundedRead: true, readOnly: true, nextPage: true,
        lockClears: true, boundedSearch: true, staleSearchIgnored: true, staleRowsCleared: true,
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
