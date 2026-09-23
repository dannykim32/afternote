import { MemoryError } from "@afternote/memory";
import type { BrokerTransportBinding } from "./vault-broker";
import { VAULT_BROKER_PROTOCOL_VERSION } from "./vault-broker-metadata";

export const MAXIMUM_MESSAGE_BYTES = 1_048_576;
export type GatewayPeerRole = "memory-client" | "owner-control";

export type GatewayEnvelope = {
  kind: "client" | "owner-presence" | "connection-closed";
  peerRole: GatewayPeerRole;
  connectionId: string;
  peerPid: number;
  payload: unknown;
};

export type BrokerRequest = {
  protocolVersion: number;
  requestId: string;
  sequence?: number;
  method: string;
  params: Record<string, unknown>;
};

export class BrokerProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function parseGatewayEnvelope(value: unknown): GatewayEnvelope {
  assertExactObject(value, ["connectionId", "kind", "payload", "peerPid", "peerRole"]);
  const envelope = value as Record<string, unknown>;
  if (
    envelope.kind !== "client" &&
    envelope.kind !== "owner-presence" &&
    envelope.kind !== "connection-closed"
  ) {
    throw new BrokerProtocolError("invalid_request", "Broker gateway kind is invalid");
  }
  if (
    envelope.peerRole !== "memory-client" &&
    envelope.peerRole !== "owner-control"
  ) {
    throw new BrokerProtocolError("invalid_request", "Broker gateway peer role is invalid");
  }
  binding(envelope as GatewayEnvelope);
  return envelope as GatewayEnvelope;
}

export function parseBrokerRequest(value: unknown, peerRole: GatewayPeerRole = "memory-client"): BrokerRequest {
  assertExactObject(value, ["method", "params", "protocolVersion", "requestId",
    ...(peerRole === "owner-control" ? ["sequence"] : [])]);
  const request = value as Record<string, unknown>;
  if (request.protocolVersion !== VAULT_BROKER_PROTOCOL_VERSION) {
    throw new BrokerProtocolError("unsupported_version", "Broker protocol version is invalid");
  }
  uuid(request.requestId, "request ID");
  if (peerRole === "owner-control" &&
    (!Number.isSafeInteger(request.sequence) || (request.sequence as number) <= 0)) {
    throw new BrokerProtocolError("invalid_request", "Owner-control request sequence is invalid");
  }
  if (typeof request.method !== "string" || !/^[a-z._]{1,64}$/.test(request.method)) {
    throw new BrokerProtocolError("invalid_request", "Broker method is invalid");
  }
  if (!request.params || typeof request.params !== "object" || Array.isArray(request.params)) {
    throw new BrokerProtocolError("invalid_request", "Broker request parameters are invalid");
  }
  return request as BrokerRequest;
}

export function binding(value: GatewayEnvelope): BrokerTransportBinding {
  if (
    typeof value.connectionId !== "string" ||
    !/^[0-9A-F-]{36}$/i.test(value.connectionId) ||
    !Number.isSafeInteger(value.peerPid) ||
    value.peerPid <= 0
  ) {
    throw new BrokerProtocolError("invalid_request", "Broker connection identity is invalid");
  }
  return { connectionId: value.connectionId, peerPid: value.peerPid };
}

export function success(requestId: string, result: unknown): string {
  return JSON.stringify({
    protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: true,
    result,
  });
}

export function serializedError(requestId: string | null, code: string, message: string): string {
  return JSON.stringify({
    protocolVersion: VAULT_BROKER_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: { code, message },
  });
}

export function requestIdFromEnvelope(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = (value as Record<string, unknown>).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" && /^[0-9a-f-]{36}$/i.test(requestId)
    ? requestId
    : null;
}

export function assertExactObject(value: unknown, keys: string[]): asserts value is object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerProtocolError("invalid_request", "Broker request object is invalid");
  }
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new BrokerProtocolError("invalid_request", "Broker request fields are invalid");
  }
}

export function boundedString(value: unknown, maximum: number, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new BrokerProtocolError("invalid_request", `${name} is invalid`);
  }
  return value;
}

export function uuid(value: unknown, name: string): string {
  const parsed = boundedString(value, 36, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new BrokerProtocolError("invalid_request", `${name} is invalid`);
  }
  return parsed;
}

export function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Broker request failed";
  const message = error.message.replace(/[\r\n]/g, " ");
  return message.length <= 300 ? message : "Broker request failed";
}

const SAFE_UNTYPED_PEER_ERRORS = new Set([
  "Broker boot does not match",
  "Client is revoked",
  "Client signature is invalid",
  "Grant is revoked",
  "Revoked MCP client public keys cannot be paired again",
  "Codex requires explicit reconnect preparation",
  "Claude Code requires explicit reconnect preparation",
  "Claude Desktop requires explicit reconnect preparation",
  "Request signature is invalid",
  "Request was replayed",
  "Request transport does not match the active session",
  "Session was not found",
  "Session is expired",
  "Session is disconnected",
  "Session is revoked",
  "Session signature is invalid",
  "Trusted work session is expired",
  "Vault encryption migration recovery state is invalid",
  "Vault restore recovery state is invalid",
]);

const SAFE_UNTYPED_PEER_ERROR_PATTERNS = [
  /^Session does not grant memory\.(?:remember|recall|get_note|forget)$/,
  /^Session does not grant archive\.(?:search|read)$/,
] as const;

export function peerSafeErrorMessage(error: unknown): string {
  if (error instanceof BrokerProtocolError || error instanceof MemoryError) {
    return safeErrorMessage(error);
  }
  const message = safeErrorMessage(error);
  return SAFE_UNTYPED_PEER_ERRORS.has(message) ||
      SAFE_UNTYPED_PEER_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    ? message
    : "Broker request failed";
}
