import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nativeDirectory = join(import.meta.dir, "..", "native");
const buildDirectory = mkdtempSync(join(tmpdir(), "afternote-software-update-"));
const binary = join(buildDirectory, "software-update-smoke");
const releaseBinary = join(buildDirectory, "software-update-release");

afterAll(() => rmSync(buildDirectory, { recursive: true, force: true }));

describe("native software update module", () => {
  it("exposes owner-controlled checks through one update driver seam", () => {
    const compile = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-framework",
      "AppKit",
      "-framework",
      "Foundation",
      join(nativeDirectory, "software_update.mm"),
      join(nativeDirectory, "software_update_smoke.mm"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const run = Bun.spawnSync([binary]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });

  it("compiles the release adapter against the pinned Sparkle framework", () => {
    const compile = Bun.spawnSync([
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-fblocks",
      "-DAFTERNOTE_RELEASE_BUILD=1",
      "-F", join(nativeDirectory, "release-deps"),
      "-framework", "Sparkle",
      "-framework", "AppKit",
      "-framework", "Foundation",
      join(nativeDirectory, "software_update.mm"),
      join(nativeDirectory, "software_update_smoke.mm"),
      "-Wl,-rpath,@executable_path/../Frameworks",
      "-o", releaseBinary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  });
});
