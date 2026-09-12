import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  probeMcpClientIdentity,
  requestVaultBroker,
  VaultBrokerMemoryClient,
  VaultBrokerTransportError,
} from "./vault-broker-client";

describe("vault broker MCP client", () => {
  it("types restart-related native XPC failures for bounded recovery", () => {
    for (const [message, code] of [
      ["Broker XPC service is unavailable", "unavailable"],
      ["Could not create the broker XPC connection", "unavailable"],
      ["Broker XPC request timed out", "timed_out"],
    ] as const) {
      const failure = captureFailure(() => requestVaultBroker("health", {}, {
        service: "dev.afternote.test-broker",
        codeRequirement: "identifier dev.afternote.test-broker",
        transport() {
          throw new Error(message);
        },
      }));
      expect(failure).toBeInstanceOf(VaultBrokerTransportError);
      expect(failure).toMatchObject({ code, message });
    }
  });

  it("does not classify malformed or policy-related XPC failures as recoverable", () => {
    const original = new Error("Broker XPC response is invalid");
    const failure = captureFailure(() => requestVaultBroker("health", {}, {
      service: "dev.afternote.test-broker",
      codeRequirement: "identifier dev.afternote.test-broker",
      transport() {
        throw original;
      },
    }));
    expect(failure).toBe(original);
  });

  it("publishes client state only after the durable signer proves readiness", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-client-probe-"));
    const statePath = join(directory, "codex.json");
    try {
      expect(() => probeMcpClientIdentity("codex", {
        clientStatePath: statePath,
        openSigner() {
          throw new Error("signer unavailable");
        },
      })).toThrow("signer unavailable");
      expect(existsSync(statePath)).toBe(false);

      let observedTag = "";
      const result = probeMcpClientIdentity("codex", {
        clientStatePath: statePath,
        openSigner: (tag) => ({
          publicKey: "test-public-key",
          signingMode: "secure-enclave",
          sign(message) {
            observedTag = tag;
            expect(message).toStartWith("afternote-mcp-client-readiness:");
            return "test-signature";
          },
        }),
      });
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      expect(state).toEqual({
        format: "afternote-mcp-client",
        schemaVersion: 1,
        kind: "codex",
        installIdentity: result.installIdentity,
      });
      expect(observedTag).toBe(
        `dev.afternote.mcp-client.codex.${result.installIdentity}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses owner-presence timeouts for pairing and activation", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-broker-client-"));
    const calls: Array<{ method: string; timeoutMs: number | undefined }> = [];
    const request: typeof requestVaultBroker = (method, _params, options) => {
      calls.push({ method, timeoutMs: options?.timeoutMs });
      if (method === "client.begin") return {
        state: "proof_required",
        requestId: "00000000-0000-4000-8000-000000000001",
        clientProofTranscript: "pairing-proof",
      };
      if (method === "client.complete_pairing") return {
        clientId: "00000000-0000-4000-8000-000000000002",
        grantId: "00000000-0000-4000-8000-000000000003",
      };
      if (method === "session.begin") return {
        activationId: "00000000-0000-4000-8000-000000000004",
        ownerDecisionTranscript: "owner-decision",
        clientProofTranscript: "client-proof",
        sessionProofTranscript: "session-proof",
      };
      if (method === "session.complete") return {
        sessionId: "00000000-0000-4000-8000-000000000005",
        clientId: "00000000-0000-4000-8000-000000000002",
        grantId: "00000000-0000-4000-8000-000000000003",
        capabilities: ["memory.remember", "memory.recall", "memory.get_note"],
        forgetPolicy: "never",
        expiresAt: "2026-08-28T08:00:00.000Z",
        brokerBootId: "00000000-0000-4000-8000-000000000006",
        vaultId: "a".repeat(64),
      };
      throw new Error(`Unexpected broker method: ${method}`);
    };

    try {
      VaultBrokerMemoryClient.activate("codex", {
        clientStatePath: join(directory, "codex.json"),
        request,
        signer: {
          publicKey: "test-public-key",
          signingMode: "development-exact-build",
          sign: () => "test-signature",
        },
      });
      expect(calls).toEqual([
        { method: "client.begin", timeoutMs: undefined },
        { method: "client.complete_pairing", timeoutMs: 125_000 },
        { method: "session.begin", timeoutMs: undefined },
        { method: "session.complete", timeoutMs: 125_000 },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function captureFailure(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected operation to throw an Error");
  }
  throw new Error("Expected operation to fail");
}
