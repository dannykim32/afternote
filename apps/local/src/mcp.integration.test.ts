import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createAfternoteMcpServer } from "@afternote/mcp";
import type { Memory, MemoryCapability, VaultContext } from "@afternote/memory";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { SqliteMemory } from "./sqlite-memory";

type RememberResult = {
  note: {
    id: string;
    content: string;
    source: { timestamp?: string } | null;
  };
};

type RecallResult = {
  results: Array<{
    note: {
      id: string;
      content: string;
      source: { application?: string } | null;
    };
    citation: {
      noteId: string;
    };
  }>;
};

type GetNoteResult = {
  note: {
    id: string;
    content: string;
    source: { application?: string } | null;
  };
};

type ForgetResult = {
  id: string;
  forgotten: boolean;
};

const tempDirectories: string[] = [];
const localVault: VaultContext = {
  vaultId: "a".repeat(64),
  deployment: "local",
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function openMcpClient(
  databasePath: string,
  capabilities?: MemoryCapability[],
) {
  const memory = new SqliteMemory(databasePath, localVault);
  const scopedMemory = capabilities
    ? new Proxy(memory, {
        get(target, property) {
          if (property === "capabilities") {
            return async () => [...capabilities];
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Memory
    : memory;
  const server = await createAfternoteMcpServer(scopedMemory, localVault);
  const client = new Client({ name: "afternote-test", version: "2.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    async close() {
      await client.close();
      await server.close();
      memory.close();
    },
  };
}

function structuredContent<T>(result: { structuredContent?: unknown }): T {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent as T;
}

describe("Afternote Local MCP", () => {
  it("registers only the tools in the activated client grant", async () => {
    const session = await openMcpClient(":memory:", [
      "memory.remember",
      "memory.recall",
      "memory.get_note",
    ]);

    try {
      const tools = await session.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_note",
        "recall",
        "remember",
      ]);
      expect(tools.tools.map((tool) => tool.name)).not.toContain("forget");
      for (const tool of tools.tools.filter((entry) =>
        entry.name === "recall" || entry.name === "get_note"
      )) {
        expect(tool.description).toContain("untrusted data");
      }
    } finally {
      await session.close();
    }
  });

  it("refuses to bind MCP tools to a different vault context", async () => {
    const memory = new SqliteMemory(":memory:", localVault);
    const wrongVault: VaultContext = {
      vaultId: "b".repeat(64),
      deployment: "local",
    };

    try {
      await expect(
        Promise.resolve(createAfternoteMcpServer(memory, wrongVault)),
      ).rejects.toMatchObject({
        code: "unauthorized",
        message: "Vault context does not match this memory service",
      });
    } finally {
      memory.close();
    }
  });

  it("recalls a remembered note after the local process restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-local-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");

    const firstSession = await openMcpClient(databasePath);
    const remembered = structuredContent<RememberResult>(
      await firstSession.client.callTool({
        name: "remember",
        arguments: {
          content: "Send John the revised proposal this afternoon.",
          source: { application: "claude-code" },
        },
      }),
    );
    await firstSession.close();

    const secondSession = await openMcpClient(databasePath);
    const recalled = structuredContent<RecallResult>(
      await secondSession.client.callTool({
        name: "recall",
        arguments: { query: "What did I need to send John?" },
      }),
    );
    await secondSession.close();

    expect(recalled.results).toHaveLength(1);
    expect(recalled.results[0]).toMatchObject({
      note: {
        id: remembered.note.id,
        content: "Send John the revised proposal this afternoon.",
        source: { application: "claude-code" },
      },
      citation: { noteId: remembered.note.id },
    });
  });

  it("gets a remembered note by its durable identifier", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-local-"));
    tempDirectories.push(directory);
    const session = await openMcpClient(join(directory, "vault.db"));

    const remembered = structuredContent<RememberResult>(
      await session.client.callTool({
        name: "remember",
        arguments: {
          content: "The garage code is in the blue envelope.",
          source: { application: "claude" },
        },
      }),
    );
    const retrieved = structuredContent<GetNoteResult>(
      await session.client.callTool({
        name: "get_note",
        arguments: { id: remembered.note.id },
      }),
    );
    await session.close();

    expect(retrieved.note).toMatchObject({
      id: remembered.note.id,
      content: "The garage code is in the blue envelope.",
      source: { application: "claude" },
    });
  });

  it("preserves the user-authored note exactly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-local-"));
    tempDirectories.push(directory);
    const databasePath = join(directory, "vault.db");
    const firstSession = await openMcpClient(databasePath);
    const original = "\n  - Keep this indentation  \n";

    const remembered = structuredContent<RememberResult>(
      await firstSession.client.callTool({
        name: "remember",
        arguments: { content: original },
      }),
    );
    await firstSession.close();

    const secondSession = await openMcpClient(databasePath);
    const retrieved = structuredContent<GetNoteResult>(
      await secondSession.client.callTool({
        name: "get_note",
        arguments: { id: remembered.note.id },
      }),
    );
    await secondSession.close();

    expect(retrieved.note.content).toBe(original);
  });

  it("normalizes connector timestamps at the MCP boundary", async () => {
    const session = await openMcpClient(":memory:");
    try {
      const remembered = structuredContent<RememberResult>(
        await session.client.callTool({
          name: "remember",
          arguments: {
            content: "The contract was signed before lunch.",
            source: { timestamp: "2026-08-28T11:45:00-06:00" },
          },
        }),
      );
      expect(remembered.note.source?.timestamp).toBe(
        "2026-08-28T17:45:00.000Z",
      );

      const invalid = await session.client.callTool({
        name: "remember",
        arguments: {
          content: "This date has no durable instant.",
          source: { timestamp: "last Friday" },
        },
      });
      expect(invalid.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("forgets a note so it can no longer be recalled or retrieved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-local-"));
    tempDirectories.push(directory);
    const session = await openMcpClient(join(directory, "vault.db"));

    const remembered = structuredContent<RememberResult>(
      await session.client.callTool({
        name: "remember",
        arguments: { content: "Kim recommended the North Loop bakery." },
      }),
    );
    const forgotten = structuredContent<ForgetResult>(
      await session.client.callTool({
        name: "forget",
        arguments: { id: remembered.note.id },
      }),
    );
    const recalled = structuredContent<RecallResult>(
      await session.client.callTool({
        name: "recall",
        arguments: { query: "Which bakery did Kim recommend?" },
      }),
    );
    const retrieved = await session.client.callTool({
      name: "get_note",
      arguments: { id: remembered.note.id },
    });
    await session.close();

    expect(forgotten).toEqual({ id: remembered.note.id, forgotten: true });
    expect(recalled.results).toEqual([]);
    expect(retrieved.isError).toBe(true);
  });
});
