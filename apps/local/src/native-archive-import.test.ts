import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, expect, it } from "bun:test";

const native = process.platform === "darwin" ? describe : describe.skip;
native("native Owner Archive import", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-native-archive-"));
  const runner = join(directory, "import-smoke");
  beforeAll(() => {
    const build = Bun.spawnSync(["clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-framework", "Foundation",
      join(import.meta.dir, "../native/archive_import.mm"), join(import.meta.dir, "../native/archive_import_smoke.mm"), "-o", runner]);
    expect(build.exitCode, build.stderr.toString()).toBe(0);
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  function run(path: string, resume = false) {
    const result = Bun.spawnSync([runner, path, resume ? "resume" : "normal"]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  }
  it("preserves BOM, Unicode across input boundaries, and a million-word transcript through pause/retry", () => {
    const text = "\uFEFF" + "a".repeat(65531) + "🧭\r\n" + "cedar ".repeat(1_000_000);
    const path = join(directory, "large.txt");
    writeFileSync(path, text);
    const result = run(path, true);
    expect(result.saved).toBe(true);
    expect(result.begins).toBe(1);
    expect(result.retries).toBeGreaterThan(0);
    expect(result.contentSha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(result.archive.sha256).toBe(result.contentSha256);
    expect(result.archive.savedBytes).toBe(Buffer.byteLength(text));
    expect(result.passages).toBeGreaterThan(700);
  });
  it("rejects malformed UTF-8 before reserving an import, plus symlinks and empty files", () => {
    for (const bytes of [[0xF0, 0x9F], [0xED, 0xA0, 0x80], [0xC0, 0xAF], [0x80], []]) {
      const path = join(directory, `invalid-${bytes.join("-")}.txt`);
      writeFileSync(path, new Uint8Array(bytes));
      expect(run(path)).toMatchObject({ saved: false, begins: 0 });
    }
    const target = join(directory, "valid.txt"), link = join(directory, "symlink.txt");
    writeFileSync(target, "valid"); symlinkSync(target, link);
    expect(run(link)).toMatchObject({ saved: false, begins: 0 });
  });
});
