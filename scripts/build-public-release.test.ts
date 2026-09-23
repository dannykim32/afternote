import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { PUBLIC_RELEASE_COMMANDS } from "./build-public-release";
import { releaseCommandEnvironment } from "./release-environment";

describe("public release command gates", () => {
  it("type checks with the pinned Bun runtime without an ambient Node executable", () => {
    const result = Bun.spawnSync([process.execPath, "run", "typecheck"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: releaseCommandEnvironment({}),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }, 30_000);

  it("requires native XPC integration instead of accepting its default skip", () => {
    expect(PUBLIC_RELEASE_COMMANDS).toContainEqual({ args: ["run", "test:desktop"], phase: "quality" });
    expect(PUBLIC_RELEASE_COMMANDS).toContainEqual({ args: ["run", "test:desktop:semantic"], phase: "quality" });
  });
  it("runs the 10,000-note performance gate in its own process", () => {
    expect(PUBLIC_RELEASE_COMMANDS).toContainEqual({
      args: ["run", "test:quality"],
      phase: "quality",
    });
  });

  it("prepares pinned native dependencies before any gate that builds them", () => {
    expect(PUBLIC_RELEASE_COMMANDS[0]).toEqual({
      args: ["run", "prepare:native-release"],
      phase: "release-preparation",
    });
    expect(PUBLIC_RELEASE_COMMANDS.findIndex(({ args }) =>
      args[1] === "test"
    )).toBeGreaterThan(0);
  });

  it("publishes the signed appcast with the notarized DMG and checksums", () => {
    const source = readFileSync(new URL("./build-public-release.ts", import.meta.url), "utf8");
    expect(source).toContain("report.appcast");
    expect(source).toContain("report.finalDmg");
    expect(source).toContain("report.checksums");
  });
});
