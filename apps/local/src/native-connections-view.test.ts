import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("Connections screen ownership", () => {
  it("renders and routes controls without linking the app coordinator or broker", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-connections-view-"));
    try {
      const runner = join(directory, "connections-view");
      const build = Bun.spawnSync([
        "clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-framework", "AppKit",
        "-framework", "Foundation",
        ...["native_appearance.mm", "connector_presentation.mm", "connections_view.mm",
          "connections_view_smoke.mm"].map((file) => join(import.meta.dir, "../native", file)),
        "-o", runner,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const smoke = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
      expect(smoke.exitCode, smoke.stderr.toString()).toBe(0);
      expect(smoke.stderr.toString()).not.toContain("Unable to simultaneously satisfy constraints");
      expect(JSON.parse(smoke.stdout.toString())).toEqual({
        routes: true, passive: true, replacement: true, history: true, busy: true, weakTarget: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
