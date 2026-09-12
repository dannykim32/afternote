import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAfternoteMcpServer } from "@afternote/mcp";
import type { Memory, Note, VaultContext } from "@afternote/memory";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  createAcceptanceTraceSink,
  DeferredVaultBrokerMemoryClient,
} from "./mcp-broker-adapter";
import {
  VaultBrokerRequestError,
  VaultBrokerTransportError,
} from "./vault-broker-client";

describe("deferred MCP broker activation", () => {
  it("turns a revoked development key failure into connector-level recovery guidance", async () => {
    const memory = new DeferredVaultBrokerMemoryClient(
      () => {
        throw new Error("Could not read the development client key (-25293)");
      },
      { connectorKind: "claude" },
    );

    const failure = await memory.recall(memory.vault, "fixture", 1)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Claude Code access needs to be reconnected. Open Afternote > Connections, " +
        "choose Prepare reconnect for Claude Code, then start a new Claude Code session.",
    );
    expect((failure as Error).message).not.toContain("-25293");
    expect((failure as { code?: string }).code).toBe("unauthorized");
  });

  it("turns broker revocation into connector-level recovery guidance", async () => {
    let activations = 0;
    const memory = new DeferredVaultBrokerMemoryClient(
      () => {
        activations += 1;
        return {
          vault: { vaultId: "a".repeat(64), deployment: "local" },
          recall: async () => {
            throw new VaultBrokerRequestError("denied", "Client is revoked");
          },
        } as unknown as Memory & { readonly vault: VaultContext };
      },
      { connectorKind: "codex" },
    );

    await expect(memory.recall(memory.vault, "fixture", 1)).rejects.toThrow(
      "Codex access needs to be reconnected. Open Afternote > Connections, " +
        "choose Prepare reconnect for Codex, then start a new Codex session.",
    );
    expect(activations).toBe(1);
  });

  it("turns a durable reconnect gate into connector-level recovery guidance", async () => {
    const memory = new DeferredVaultBrokerMemoryClient(
      () => {
        throw new VaultBrokerRequestError(
          "denied",
          "Codex requires explicit reconnect preparation",
        );
      },
      { connectorKind: "codex" },
    );

    await expect(memory.recall(memory.vault, "fixture", 1)).rejects.toThrow(
      "Codex access needs to be reconnected. Open Afternote > Connections, " +
        "choose Prepare reconnect for Codex, then start a new Codex session.",
    );
  });

  it("writes redacted events only to an owner-private acceptance channel", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-acceptance-trace-"));
    const path = join(directory, "trace.jsonl");
    writeFileSync(path, "", { mode: 0o600 });
    try {
      const sink = createAcceptanceTraceSink({ enabled: true, path });
      const event = {
        kind: "mcp-broker-operation" as const,
        operation: "recall" as const,
        attempt: 1 as const,
        reactivation: false,
        outcome: "succeeded" as const,
        durationMs: 7,
      };
      sink?.(event);
      expect(readFileSync(path, "utf8")).toBe(
        `AFTERNOTE_ACCEPTANCE_TRACE ${JSON.stringify(event)}\n`,
      );

      chmodSync(path, 0o644);
      expect(() => createAcceptanceTraceSink({ enabled: true, path }))
        .toThrow("owner-only regular file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits redacted activation and operation timing without note or query contents", async () => {
    const trace: unknown[] = [];
    const activatedVault: VaultContext = {
      vaultId: "d".repeat(64),
      deployment: "local",
    };
    const secretQuery = "private acceptance query must never reach the trace";
    const clock = queuedClock([0, 3, 3, 8]);
    const memory = new DeferredVaultBrokerMemoryClient(
      () => ({
        vault: activatedVault,
        recall: async () => [],
      } as unknown as Memory & { readonly vault: VaultContext }),
      { clock, trace: (event) => trace.push(event) },
    );

    await expect(memory.recall(memory.vault, secretQuery, 1)).resolves.toEqual([]);
    expect(trace).toEqual([
      {
        kind: "mcp-broker-activation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "succeeded",
        durationMs: 3,
      },
      {
        kind: "mcp-broker-operation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "succeeded",
        durationMs: 5,
      },
    ]);
    expect(JSON.stringify(trace)).not.toContain(secretQuery);
  });

  it("records trusted-work-session reactivation attempts and outcomes separately", async () => {
    const trace: unknown[] = [];
    const activatedVault: VaultContext = {
      vaultId: "e".repeat(64),
      deployment: "local",
    };
    let activations = 0;
    const memory = new DeferredVaultBrokerMemoryClient(
      () => {
        activations += 1;
        const activation = activations;
        return {
          vault: activatedVault,
          recall: async () => {
            if (activation === 1) {
              throw new VaultBrokerRequestError(
                "denied",
                "Trusted work session is expired",
              );
            }
            return [];
          },
        } as unknown as Memory & { readonly vault: VaultContext };
      },
      {
        clock: queuedClock([0, 3, 3, 8, 8, 10, 10, 14]),
        trace: (event) => trace.push(event),
      },
    );

    await expect(memory.recall(memory.vault, "private retry query", 1)).resolves.toEqual([]);
    expect(trace).toEqual([
      {
        kind: "mcp-broker-activation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "succeeded",
        durationMs: 3,
      },
      {
        kind: "mcp-broker-operation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "stale_session",
        durationMs: 5,
      },
      {
        kind: "mcp-broker-activation",
        operation: "recall",
        attempt: 2,
        reactivation: true,
        outcome: "succeeded",
        durationMs: 2,
      },
      {
        kind: "mcp-broker-operation",
        operation: "recall",
        attempt: 2,
        reactivation: true,
        outcome: "succeeded",
        durationMs: 4,
      },
    ]);
  });

  it("records a failed reactivation without exposing the broker error", async () => {
    const trace: unknown[] = [];
    const activatedVault: VaultContext = {
      vaultId: "f".repeat(64),
      deployment: "local",
    };
    let activations = 0;
    const privateError = "private broker detail must not reach the trace";
    const memory = new DeferredVaultBrokerMemoryClient(
      () => {
        activations += 1;
        if (activations === 2) throw new Error(privateError);
        return {
          vault: activatedVault,
          recall: async () => {
            throw new VaultBrokerRequestError("denied", "Broker boot does not match");
          },
        } as unknown as Memory & { readonly vault: VaultContext };
      },
      {
        clock: queuedClock([0, 1, 1, 2, 2, 5]),
        trace: (event) => trace.push(event),
      },
    );

    await expect(memory.recall(memory.vault, "private query", 1)).rejects.toThrow(
      privateError,
    );
    expect(trace).toEqual([
      {
        kind: "mcp-broker-activation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "succeeded",
        durationMs: 1,
      },
      {
        kind: "mcp-broker-operation",
        operation: "recall",
        attempt: 1,
        reactivation: false,
        outcome: "stale_session",
        durationMs: 1,
      },
      {
        kind: "mcp-broker-activation",
        operation: "recall",
        attempt: 2,
        reactivation: true,
        outcome: "failed",
        durationMs: 3,
      },
    ]);
    expect(JSON.stringify(trace)).not.toContain(privateError);
  });

  it("completes MCP initialization before requesting owner presence", async () => {
    let activations = 0;
    const activatedVault: VaultContext = {
      vaultId: "a".repeat(64),
      deployment: "local",
    };
    const note: Note = {
      id: "note-1",
      content: "A brokered memory",
      source: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      revision: 1,
    };
    const activated = {
      vault: activatedVault,
      remember: async (vault: VaultContext) => {
        expect(vault).toEqual(activatedVault);
        return note;
      },
    } as unknown as Memory & { readonly vault: VaultContext };
    const memory = new DeferredVaultBrokerMemoryClient(() => {
      activations += 1;
      return activated;
    });
    const server = await createAfternoteMcpServer(memory, memory.vault);
    const client = new Client({ name: "deferred-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "get_note",
        "recall",
        "remember",
      ]);
      expect(activations).toBe(0);

      const result = await client.callTool({
        name: "remember",
        arguments: { content: note.content },
      });
      expect(result.isError).not.toBe(true);
      expect(activations).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("re-activates inside one MCP process after lock rotates the broker boot", async () => {
    let activations = 0;
    const activatedVault: VaultContext = {
      vaultId: "b".repeat(64),
      deployment: "local",
    };
    const note: Note = {
      id: "test-fixture-not-a-saved-note",
      content: "TEST_FIXTURE_NOT_A_SAVED_NOTE: MCP reactivation sentinel",
      source: null,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      revision: 1,
    };
    const memory = new DeferredVaultBrokerMemoryClient(() => {
      activations += 1;
      const activation = activations;
      return {
        vault: activatedVault,
        recall: async (vault: VaultContext) => {
          expect(vault).toEqual(activatedVault);
          if (activation === 1) {
            throw new VaultBrokerRequestError("denied", "Broker boot does not match");
          }
          return [{
            note,
            citation: {
              noteId: note.id,
              revision: note.revision,
              excerpt: note.content,
              source: note.source,
              createdAt: note.createdAt,
            },
            score: 1,
          }];
        },
      } as unknown as Memory & { readonly vault: VaultContext };
    });
    const server = await createAfternoteMcpServer(memory, memory.vault);
    const client = new Client({ name: "post-unlock-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      const result = await client.callTool({
        name: "recall",
        arguments: { query: "Recall the TEST_FIXTURE_NOT_A_SAVED_NOTE sentinel" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        results: [{
          note: { id: note.id, revision: 1 },
          citation: { noteId: note.id, revision: 1 },
        }],
      });
      expect(activations).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("reports the locked vault after a broker transport restart in one MCP process", async () => {
    let activations = 0;
    let recallAttempts = 0;
    const trace: unknown[] = [];
    const activatedVault: VaultContext = {
      vaultId: "b".repeat(64),
      deployment: "local",
    };
    const memory = new DeferredVaultBrokerMemoryClient(() => {
      activations += 1;
      if (activations === 2) {
        throw new VaultBrokerRequestError(
          "vault_locked",
          "Afternote vault is locked",
        );
      }
      return {
        vault: activatedVault,
        recall: async () => {
          recallAttempts += 1;
          throw unavailableBrokerTransportError();
        },
      } as unknown as Memory & { readonly vault: VaultContext };
    }, { trace: (event) => trace.push(event) });

    await expect(memory.recall(memory.vault, "fixture", 1)).rejects.toThrow(
      "Afternote vault is locked",
    );
    expect(activations).toBe(2);
    expect(recallAttempts).toBe(1);
    expect(trace).toContainEqual(expect.objectContaining({
      kind: "mcp-broker-operation",
      operation: "recall",
      attempt: 1,
      outcome: "transport_restart",
    }));
  });

  it("continues a read-only Recall after a broker transport restart", async () => {
    let activations = 0;
    let recallAttempts = 0;
    const activatedVault: VaultContext = {
      vaultId: "b".repeat(64),
      deployment: "local",
    };
    const memory = new DeferredVaultBrokerMemoryClient(() => {
      activations += 1;
      const activation = activations;
      return {
        vault: activatedVault,
        recall: async () => {
          recallAttempts += 1;
          if (activation === 1) throw unavailableBrokerTransportError();
          return [];
        },
      } as unknown as Memory & { readonly vault: VaultContext };
    });

    await expect(memory.recall(memory.vault, "fixture", 1)).resolves.toEqual([]);
    expect(activations).toBe(2);
    expect(recallAttempts).toBe(2);
  });

  it("does not replay Remember after an ambiguous broker transport failure", async () => {
    let activations = 0;
    let rememberAttempts = 0;
    const activatedVault: VaultContext = {
      vaultId: "b".repeat(64),
      deployment: "local",
    };
    const transportError = unavailableBrokerTransportError();
    const memory = new DeferredVaultBrokerMemoryClient(() => {
      activations += 1;
      return {
        vault: activatedVault,
        remember: async () => {
          rememberAttempts += 1;
          throw transportError;
        },
      } as unknown as Memory & { readonly vault: VaultContext };
    });

    await expect(memory.remember(memory.vault, { content: "fixture" }))
      .rejects.toBe(transportError);
    expect(activations).toBe(1);
    expect(rememberAttempts).toBe(1);
  });

  it("does not reactivate a locked vault or an explicitly revoked client", async () => {
    const activatedVault: VaultContext = {
      vaultId: "c".repeat(64),
      deployment: "local",
    };
    for (const error of [
      new VaultBrokerRequestError("vault_locked", "Afternote vault is locked"),
      new VaultBrokerRequestError("denied", "Client is revoked"),
    ]) {
      let activations = 0;
      const memory = new DeferredVaultBrokerMemoryClient(() => {
        activations += 1;
        return {
          vault: activatedVault,
          recall: async () => {
            throw error;
          },
        } as unknown as Memory & { readonly vault: VaultContext };
      });

      await expect(memory.recall(memory.vault, "fixture", 1)).rejects.toThrow(
        error.message,
      );
      expect(activations).toBe(1);
    }
  });
});

function queuedClock(values: number[]): () => number {
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error("Test clock was read too many times");
    return value;
  };
}

function unavailableBrokerTransportError(): VaultBrokerTransportError {
  const nativeError = new Error("Broker XPC service is unavailable");
  return new VaultBrokerTransportError(
    "unavailable",
    nativeError.message,
    nativeError,
  );
}
