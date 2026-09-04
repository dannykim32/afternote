import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { runIntegrationHostCommand } from "./integration-host-command";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("integration host command deadline", () => {
  it("returns successful host output without treating an absent signal as a timeout", () => {
    expect(runIntegrationHostCommand(
      "Claude Code",
      "/bin/sh",
      ["-c", "printf ready"],
      1_000,
      (_host, command) => command,
    )).toBe("ready");
  });

  it("kills and reaps a host CLI that exceeds the setup deadline", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-host-timeout-"));
    temporaryDirectories.push(directory);
    const command = join(directory, "hanging-host");
    writeFileSync(command, "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o755 });
    chmodSync(command, 0o755);
    const startedAt = performance.now();
    expect(() =>
      runIntegrationHostCommand(
        "Codex",
        command,
        ["mcp", "list"],
        50,
        (_host, candidate) => candidate,
      )
    )
      .toThrow("Codex configuration timed out");
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });
});
