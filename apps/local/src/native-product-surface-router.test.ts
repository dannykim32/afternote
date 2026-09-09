import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nativeDirectory = join(import.meta.dir, "..", "native");
const buildDirectory = mkdtempSync(join(tmpdir(), "afternote-surface-router-"));
const binary = join(buildDirectory, "product-surface-router-smoke");

afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

describe("native product surface router", () => {
  it("keeps navigation, recovery gating, and reconnect routing deterministic", () => {
    const compile = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-framework",
      "Foundation",
      join(nativeDirectory, "product_surface_router.mm"),
      join(nativeDirectory, "product_surface_router_smoke.mm"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const run = Bun.spawnSync([binary]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });
});
