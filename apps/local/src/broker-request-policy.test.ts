import { describe, expect, it } from "bun:test";
import { brokerDispatchTarget, brokerRequestAdmission } from "./broker-request-policy";
import { BrokerProtocolError } from "./broker-wire-protocol";

// Intentionally independent of the production allowlist: adding a route requires
// an explicit decision about its trusted role and its admission requirements.
const connectorMethods = [
  "client.begin", "client.complete_pairing", "session.begin", "session.complete", "memory.execute",
];
const ownerMethods = [
  "owner.session.begin", "owner.routine_authentication", "owner.set_routine_authentication",
  "owner.connector_overview", "owner.inspect_connections", "owner.inspect_audit",
  "owner.revoke_client", "owner.revoke_connector", "library.session.begin",
  "library.refresh_search", "library.views", "library.browse", "library.search", "library.get_note",
  "library.list_revisions", "library.remember", "library.update_note", "library.delete",
  "admin.export", "admin.diagnostics", "admin.prepare_client_rotation",
  "admin.prepare_connector_reconnect",
  "lifecycle.status", "lifecycle.lock", "lifecycle.unlock",
  "recovery.status", "recovery.migrate", "recovery.restore",
];

describe("broker request policy", () => {
  it("permits health on either role without owner replay or vault admission", () => {
    for (const role of ["owner-control", "memory-client"] as const) {
      expect(brokerDispatchTarget("health", role)).toBe("health");
      expect(brokerRequestAdmission("health", role)).toEqual({
        consumeOwnerSequence: false, checkRecovery: false, requireUnlockedVault: false,
      });
    }
  });

  it.each(connectorMethods)("routes %s only for ordinary connectors", (method) => {
    expect<string>(brokerDispatchTarget(method, "memory-client")).toBe(method);
    expectRoleDenied(method, "owner-control");
    for (const role of ["owner-control", "memory-client"] as const) {
      expect(brokerRequestAdmission(method, role)).toEqual({
        consumeOwnerSequence: false, checkRecovery: true, requireUnlockedVault: true,
      });
    }
  });

  it.each(ownerMethods)("routes %s only for the native Owner", (method) => {
    const expectedTarget = method.startsWith("library.") && method !== "library.session.begin"
      ? "library.execute" : method.startsWith("admin.") ? "admin.begin"
      : method === "lifecycle.lock" || method === "lifecycle.unlock" ? "lifecycle.transition" : method;
    expect<string>(brokerDispatchTarget(method, "owner-control")).toBe(expectedTarget);
    expectRoleDenied(method, "memory-client");
    for (const role of ["owner-control", "memory-client"] as const) {
      expect(brokerRequestAdmission(method, role)).toEqual({
        consumeOwnerSequence: role === "owner-control",
        checkRecovery: !method.startsWith("recovery."),
        requireUnlockedVault: !method.startsWith("recovery.") && !method.startsWith("lifecycle."),
      });
    }
  });

  it.each([
    "owner.unknown", "library.unknown", "admin.unknown", "lifecycle.unknown", "recovery.unknown",
    "memory.unknown", "health.extra", "library.execute", "admin.begin", "lifecycle.transition",
    "constructor", "toString", "__proto__", "", "HEALTH",
  ])("never dispatches an unlisted method, including %s", (method) => {
    for (const role of ["owner-control", "memory-client"] as const) {
      expect(() => brokerDispatchTarget(method, role)).toThrow(
        new BrokerProtocolError("not_found", "Broker method is not available"),
      );
    }
  });

  it("retains namespace admission for unknown methods without admitting a route", () => {
    expect(brokerRequestAdmission("owner.unknown", "owner-control")).toEqual({
      consumeOwnerSequence: true, checkRecovery: true, requireUnlockedVault: true,
    });
    expect(brokerRequestAdmission("lifecycle.unknown", "owner-control")).toEqual({
      consumeOwnerSequence: true, checkRecovery: true, requireUnlockedVault: false,
    });
    expect(brokerRequestAdmission("recovery.unknown", "owner-control")).toEqual({
      consumeOwnerSequence: true, checkRecovery: false, requireUnlockedVault: false,
    });
  });
});

function expectRoleDenied(method: string, role: "memory-client" | "owner-control") {
  expect(() => brokerDispatchTarget(method, role)).toThrow(
    new BrokerProtocolError("identity_mismatch", "Broker method is unavailable to this trusted client role"),
  );
}
