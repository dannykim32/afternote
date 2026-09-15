import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

describe("local CLI process", () => {
  it("does not publish a residual loopback runtime or stop command", () => {
    const home = mkdtempSync(join(tmpdir(), "afternote-retired-runtime-cli-"));
    try {
      const mainPath = join(import.meta.dir, "main.ts");
      for (const retiredCommand of ["runtime", "stop", "telemetry"] as const) {
        const result = Bun.spawnSync([
          process.execPath,
          "run",
          mainPath,
          retiredCommand,
        ], {
          env: {
            HOME: home,
            LANG: process.env.LANG ?? "en_US.UTF-8",
            PATH: "/usr/bin:/bin",
            TMPDIR: process.env.TMPDIR ?? tmpdir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString()).toBe(
          `Unknown Afternote Local command: ${retiredCommand}\n`,
        );
      }
      expect(existsSync(join(home, ".afternote", "runtime"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("routes connector identity rotation before host discovery and requires the packaged artifact", () => {
    for (const [integration, action] of ["codex", "claude-code", "claude-desktop"].flatMap(
      (kind) => ["rotate-identity", "prepare-reconnect"].map((action) => [kind, action] as const),
    )) {
      const home = mkdtempSync(join(tmpdir(), "afternote-rotation-cli-"));
      try {
        const mainPath = join(import.meta.dir, "main.ts");
        const result = Bun.spawnSync([
          process.execPath,
          "run",
          mainPath,
          integration,
          action,
        ], {
          env: {
            HOME: home,
            LANG: process.env.LANG ?? "en_US.UTF-8",
            PATH: "/usr/bin:/bin",
            TMPDIR: process.env.TMPDIR ?? tmpdir(),
          },
          stdout: "pipe",
          stderr: "pipe",
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toBe(
          "MCP client identity rotation requires the packaged Afternote Local artifact\n",
        );
        expect(existsSync(join(home, ".afternote"))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("prints one concise error without exposing a Bun stack trace", () => {
    const mainPath = join(import.meta.dir, "main.ts");
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      mainPath,
      "diagnostics",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Missing diagnostic bundle destination\n",
    );
  });

  it("bounds multiline and terminal-controlled errors to one display-safe line", () => {
    const mainPath = join(import.meta.dir, "main.ts");
    const result = Bun.spawnSync([
      process.execPath,
      "run",
      mainPath,
      "bad\ncommand\u001b[31m",
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(
      "Unknown Afternote Local command: bad command [31m\n",
    );
    expect(result.stderr.toString()).not.toContain("\u001b");
  });
});
