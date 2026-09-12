import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  INTEGRATION_HOST_CODE_REQUIREMENTS,
  runIntegrationHostCommand,
} from "./integration-host-command";
import { MCP_HOST_CODE_REQUIREMENTS } from "./mcp-broker-adapter";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("integration host command deadline", () => {
  it("uses the exact runtime publisher requirements during connector setup", () => {
    expect(INTEGRATION_HOST_CODE_REQUIREMENTS.Codex)
      .toBe(MCP_HOST_CODE_REQUIREMENTS.codex);
    expect(INTEGRATION_HOST_CODE_REQUIREMENTS["Claude Code"])
      .toBe(MCP_HOST_CODE_REQUIREMENTS.claude);
    expect(INTEGRATION_HOST_CODE_REQUIREMENTS["Claude Desktop"])
      .toContain('identifier "com.anthropic.claudefordesktop"');
    expect(INTEGRATION_HOST_CODE_REQUIREMENTS["Claude Desktop"])
      .toContain('certificate leaf[subject.OU] = "Q6L2SF6YDW"');
    expect(MCP_HOST_CODE_REQUIREMENTS["claude-desktop"])
      .toContain('identifier "disclaimer"');
    expect(MCP_HOST_CODE_REQUIREMENTS["claude-desktop"])
      .toContain('certificate leaf[subject.OU] = "Q6L2SF6YDW"');
    for (const requirement of Object.values(INTEGRATION_HOST_CODE_REQUIREMENTS)) {
      expect(requirement).toContain("1.2.840.113635.100.6.1.13");
      expect(requirement).toContain("1.2.840.113635.100.6.2.6");
    }
  });

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
