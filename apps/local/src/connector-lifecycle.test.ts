import { describe, expect, it } from "bun:test";
import { createClaudeCodeConnectorAdapter } from "./claude-code-integration";
import { createCodexConnectorAdapter } from "./codex-integration";
import { manageConnectorLifecycle } from "./connector-lifecycle";

describe("connector lifecycle interface", () => {
  it("reports the same absent-configuration semantics through both host adapters", async () => {
    const afternoteCommand = "/Applications/Afternote.app/Contents/MacOS/afternote";
    const codex = await manageConnectorLifecycle(
      "status",
      true,
      createCodexConnectorAdapter({
        afternoteCommand,
        toolCommand: "/Applications/Codex.app/Contents/Resources/codex",
        readServer: () => null,
      }),
    );
    const claude = await manageConnectorLifecycle(
      "status",
      true,
      createClaudeCodeConnectorAdapter({
        afternoteCommand,
        toolCommand: "/Applications/Claude.app/Contents/MacOS/claude",
        readServer: () => null,
      }),
    );

    for (const status of [codex, claude]) {
      expect(status).toMatchObject({
        toolAvailable: true,
        installed: false,
        healthy: false,
        configHealthy: false,
        repairable: true,
        problemCode: "connector_missing",
      });
    }
  });
});
