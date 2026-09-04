import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nativeDirectory = join(import.meta.dir, "..", "native");
const buildDirectory = mkdtempSync(join(tmpdir(), "afternote-editor-state-"));
const binary = join(buildDirectory, "note-editor-state-smoke");

afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

describe("native note editor state", () => {
  test("keeps save feedback and revision menu rules deterministic", () => {
    const compile = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      join(nativeDirectory, "note_editor_state.mm"),
      join(nativeDirectory, "note_editor_state_smoke.mm"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode).toBe(0);
    expect(new TextDecoder().decode(compile.stderr)).toBe("");

    const run = Bun.spawnSync([binary]);
    expect(run.exitCode).toBe(0);
  });
});
