import { describe, expect, it } from "bun:test";
import {
  OwnerPresenceCoordinator,
  OwnerPresenceCoordinatorError,
} from "./owner-presence-coordinator";

type Pending = {
  kind: "connector" | "owner";
  requestId: string;
  challengeExpiresAt: number;
  binding: { connectionId: string; peerPid: number };
};

describe("owner-presence coordinator interface", () => {
  it("consumes a challenge exactly once and binds it to role, connection, PID, and expiry", () => {
    const coordinator = new OwnerPresenceCoordinator<Pending>();
    const pending: Pending = {
      kind: "connector",
      requestId: "request-1",
      challengeExpiresAt: 2_000,
      binding: { connectionId: "connection-1", peerPid: 42 },
    };
    coordinator.set("challenge-1", pending);

    expect(coordinator.claim({
      challengeId: "challenge-1",
      peerRole: "memory-client",
      binding: pending.binding,
      now: 1_000,
      expectedRole: (value) => value.kind === "connector"
        ? "memory-client"
        : "owner-control",
    })).toEqual({ pending, issue: null });
    expect(() => coordinator.claim({
      challengeId: "challenge-1",
      peerRole: "memory-client",
      binding: pending.binding,
      now: 1_000,
      expectedRole: () => "memory-client",
    })).toThrow(OwnerPresenceCoordinatorError);
  });

  it("consumes mismatched and expired challenges while reporting a stable issue", () => {
    const coordinator = new OwnerPresenceCoordinator<Pending>();
    const pending: Pending = {
      kind: "owner",
      requestId: "request-2",
      challengeExpiresAt: 2_000,
      binding: { connectionId: "connection-2", peerPid: 84 },
    };
    coordinator.set("wrong-role", pending);
    expect(coordinator.claim({
      challengeId: "wrong-role",
      peerRole: "memory-client",
      binding: pending.binding,
      now: 1_000,
      expectedRole: () => "owner-control",
    }).issue).toBe("role_mismatch");

    coordinator.set("expired", pending);
    expect(coordinator.claim({
      challengeId: "expired",
      peerRole: "owner-control",
      binding: pending.binding,
      now: 2_000,
      expectedRole: () => "owner-control",
    }).issue).toBe("expired");
  });
});
