import { randomUUID } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { MemoryError } from "@afternote/memory";
import {
  BrokerProtocolError, binding, parseBrokerRequest, parseGatewayEnvelope,
  peerSafeErrorMessage, requestIdFromEnvelope, serializedError, success,
} from "./broker-wire-protocol";

const requestId = randomUUID();
const connectionId = randomUUID();
const request = { protocolVersion: 1, requestId, method: "health", params: {} };
const gateway = { kind: "client", peerRole: "memory-client", connectionId, peerPid: 123, payload: request };

describe("broker wire protocol", () => {
  it("parses trusted gateway context separately from client payloads", () => {
    for (const kind of ["client", "owner-presence", "connection-closed"]) {
      for (const peerRole of ["memory-client", "owner-control"]) {
        const parsed = parseGatewayEnvelope({ ...gateway, kind, peerRole });
        expect(binding(parsed)).toEqual({ connectionId, peerPid: 123 });
        expect(parsed.payload).toEqual(request);
      }
    }
    expect(parseBrokerRequest(request)).toEqual(request);
    // An unknown but well-formed method reaches admission before dispatch rejects it.
    expect(parseBrokerRequest({ ...request, method: "owner.unknown" }).method).toBe("owner.unknown");
  });

  it("rejects unknown gateway fields, kinds, roles, and malformed peer bindings", () => {
    for (const value of [null, [], {}, { ...gateway, extra: true },
      { ...gateway, kind: "unknown" }, { ...gateway, peerRole: "admin" },
      { ...gateway, connectionId: "bad" }, { ...gateway, peerPid: 0 },
      { ...gateway, peerPid: 1.5 }, { ...gateway, peerPid: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => parseGatewayEnvelope(value)).toThrow(BrokerProtocolError);
    }
  });

  it("rejects malformed requests without silently dropping fields", () => {
    for (const value of [null, [], {}, { ...request, role: "owner-control" },
      { ...request, protocolVersion: 2 }, { ...request, requestId: "bad" },
      { ...request, method: "health/other" }, { ...request, method: "a".repeat(65) },
      { ...request, params: null }, { ...request, params: [] }]) {
      expect(() => parseBrokerRequest(value)).toThrow(BrokerProtocolError);
    }
  });

  it("correlates malformed envelopes only with a bounded ID, not arbitrary text", () => {
    expect(requestIdFromEnvelope(gateway)).toBe(requestId);
    expect(requestIdFromEnvelope({ payload: { requestId, extra: "invalid" } })).toBe(requestId);
    for (const value of [null, [], {}, { payload: null }, { payload: [] },
      { payload: { requestId: "/Users/private/vault.db" } }]) {
      expect(requestIdFromEnvelope(value)).toBeNull();
    }
  });

  it("preserves the response envelope and nullable error correlation", () => {
    expect(JSON.parse(success(requestId, { count: 1 }))).toEqual({
      protocolVersion: 1, requestId, ok: true, result: { count: 1 },
    });
    expect(JSON.parse(serializedError(null, "invalid_request", "Malformed"))).toEqual({
      protocolVersion: 1, requestId: null, ok: false,
      error: { code: "invalid_request", message: "Malformed" },
    });
  });

  it("exposes only typed or allowlisted peer errors and suppresses internal details", () => {
    expect(peerSafeErrorMessage(new BrokerProtocolError("vault_locked", "Afternote vault is locked")))
      .toBe("Afternote vault is locked");
    expect(peerSafeErrorMessage(new MemoryError("not_found", "Note not found"))).toBe("Note not found");
    expect(peerSafeErrorMessage(new Error("Session is expired"))).toBe("Session is expired");
    expect(peerSafeErrorMessage(new Error("Session does not grant memory.recall")))
      .toBe("Session does not grant memory.recall");
    for (const error of [new Error("SQL error at /Users/private/vault.db"),
      new Error("Session does not grant admin.export"), "secret",
      new BrokerProtocolError("denied", "a".repeat(301))]) {
      expect(peerSafeErrorMessage(error)).toBe("Broker request failed");
    }
    expect(peerSafeErrorMessage(new BrokerProtocolError("denied", "first\nsecond\rthird")))
      .toBe("first second third");
  });
});
