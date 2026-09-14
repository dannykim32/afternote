import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const describeMacos = process.platform === "darwin" ? describe : describe.skip;

describeMacos("Notes editor ownership", () => {
  it("owns drafts, controls, revision presentation, and plaintext cleanup without a broker", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-note-editor-"));
    try {
      const runner = join(directory, "note-editor");
      const build = Bun.spawnSync([
        "clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-framework", "AppKit",
        "-framework", "Foundation",
        ...["native_appearance.mm", "note_editor_state.mm", "plain_text_list_formatting.mm",
          "note_editor_view.mm", "note_editor_view_smoke.mm"].map((file) => join(import.meta.dir, "../native", file)),
        "-o", runner,
      ], { stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const smoke = Bun.spawnSync([runner], { stdout: "pipe", stderr: "pipe" });
      expect(smoke.exitCode, smoke.stdout.toString() + smoke.stderr.toString()).toBe(0);
      expect(smoke.stderr.toString()).not.toContain("Unable to simultaneously satisfy constraints");
      expect(JSON.parse(smoke.stdout.toString())).toEqual({
        empty: true, current: true, editing: true, busy: true,
        passiveUpdatesPreserveDraft: true, routes: true, discard: true, history: true,
        saveFeedback: true, citation: true, editCurrentRoute: true, newNote: true,
        formatting: true, conflictDraft: true, conflictBaseline: true, noteIsolation: true,
        plaintextCleared: true, reauthDoesNotRestorePlaintext: true, weakTarget: true, layout: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
