import { BrokerProtocolError, type GatewayPeerRole } from "./broker-wire-protocol";

// Exact method allowlist. These roles come from the native gateway, not request
// parameters. A route grants no session scopes and performs no operation itself.
const METHODS = {
  "health": ["either", "health"],
  "client.begin": ["memory-client", "client.begin"],
  "client.complete_pairing": ["memory-client", "client.complete_pairing"],
  "session.begin": ["memory-client", "session.begin"],
  "session.complete": ["memory-client", "session.complete"],
  "memory.execute": ["memory-client", "memory.execute"],
  "owner.session.begin": ["owner-control", "owner.session.begin"],
  "owner.routine_authentication": ["owner-control", "owner.routine_authentication"],
  "owner.set_routine_authentication": ["owner-control", "owner.set_routine_authentication"],
  "owner.connector_overview": ["owner-control", "owner.connector_overview"],
  "owner.inspect_connections": ["owner-control", "owner.inspect_connections"],
  "owner.inspect_audit": ["owner-control", "owner.inspect_audit"],
  "owner.revoke_client": ["owner-control", "owner.revoke_client"],
  "owner.revoke_connector": ["owner-control", "owner.revoke_connector"],
  "library.session.begin": ["owner-control", "library.session.begin"],
  "library.refresh_search": ["owner-control", "library.execute"],
  "library.views": ["owner-control", "library.execute"],
  "library.browse": ["owner-control", "library.execute"],
  "library.search": ["owner-control", "library.execute"],
  "library.get_note": ["owner-control", "library.execute"],
  "library.list_revisions": ["owner-control", "library.execute"],
  "library.remember": ["owner-control", "library.execute"],
  "library.update_note": ["owner-control", "library.execute"],
  "library.delete": ["owner-control", "library.execute"],
  "admin.export": ["owner-control", "admin.begin"],
  "admin.diagnostics": ["owner-control", "admin.begin"],
  "admin.prepare_client_rotation": ["owner-control", "admin.begin"],
  "admin.prepare_connector_reconnect": ["owner-control", "admin.begin"],
  "lifecycle.status": ["owner-control", "lifecycle.status"],
  "lifecycle.lock": ["owner-control", "lifecycle.transition"],
  "lifecycle.unlock": ["owner-control", "lifecycle.transition"],
  "recovery.status": ["owner-control", "recovery.status"],
  "recovery.migrate": ["owner-control", "recovery.migrate"],
  "recovery.restore": ["owner-control", "recovery.restore"],
} as const;

type BrokerDispatchTarget = (typeof METHODS)[keyof typeof METHODS][1];

/** Phase one: admission requirements, including for unknown methods.
 * The worker must consume a protected request sequence, check recovery, then require
 * an unlocked vault in that order, before resolving the target below.
 * Namespace exemptions do not make unknown methods callable.
 */
export function brokerRequestAdmission(method: string, peerRole: GatewayPeerRole): {
  consumeOwnerSequence: boolean;
  checkRecovery: boolean;
  requireUnlockedVault: boolean;
} {
  const recovery = method.startsWith("recovery.");
  const lifecycle = method.startsWith("lifecycle.");
  return {
    consumeOwnerSequence: peerRole === "owner-control" && (
      method.startsWith("owner.") || method.startsWith("library.") ||
      method.startsWith("admin.") || lifecycle || recovery
    ),
    checkRecovery: method !== "health" && !recovery,
    requireUnlockedVault: method !== "health" && !lifecycle && !recovery,
  };
}

/** Phase two: exact method and trusted-role dispatch after admission succeeds.
 * This check is not a substitute for the handler's session/approval checks.
 */
export function brokerDispatchTarget(method: string, peerRole: GatewayPeerRole): BrokerDispatchTarget {
  if (!Object.hasOwn(METHODS, method)) {
    throw new BrokerProtocolError("not_found", "Broker method is not available");
  }
  const [role, target] = METHODS[method as keyof typeof METHODS];
  if (role !== "either" && role !== peerRole) {
    throw new BrokerProtocolError(
      "identity_mismatch",
      "Broker method is unavailable to this trusted client role",
    );
  }
  return target;
}
