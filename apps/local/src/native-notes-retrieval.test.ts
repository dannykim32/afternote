import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;
describeMacos("Notes retrieval ownership", () => {
  it("isolates submitted queries, pages, cancellations, and cleared sessions without AppKit or a broker", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-notes-retrieval-"));
    try {
      const runner = join(directory, "retrieval");
      const build = Bun.spawnSync([
        "clang++", "-std=c++17", "-fobjc-arc", "-framework", "Foundation",
        ...["notes_retrieval.mm", "notes_retrieval_smoke.mm"].map((file) => join(import.meta.dir, "../native", file)),
        "-o", runner,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const smoke = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
      expect(smoke.exitCode, smoke.stdout.toString() + smoke.stderr.toString()).toBe(0);
      expect(JSON.parse(smoke.stdout.toString())).toEqual({
        initial: true, searchRequest: true, superseded: true, citation: true,
        duplicateCompletion: true, pageRequest: true, pagination: true,
        refreshReplaces: true, appendErrorRetry: true, navigationCancellation: true,
        browseRequest: true, browseResult: true, cursorIsolation: true,
        clearRejectsLateReplies: true, freshSession: true, foreignRequest: true, emptyResults: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
