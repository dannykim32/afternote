export type OwnerPresenceBinding = {
  connectionId: string;
  peerPid: number;
};

export type PendingOwnerPresence = {
  requestId: string;
  challengeExpiresAt: number;
  binding: OwnerPresenceBinding;
};

export type OwnerPresenceClaimIssue =
  | "role_mismatch"
  | "binding_mismatch"
  | "expired";

export class OwnerPresenceCoordinatorError extends Error {
  constructor(
    readonly code: "replayed",
    message: string,
  ) {
    super(message);
    this.name = "OwnerPresenceCoordinatorError";
  }
}

export class OwnerPresenceCoordinator<Pending extends PendingOwnerPresence> {
  readonly #pending = new Map<string, Pending>();

  get size(): number {
    return this.#pending.size;
  }

  get(challengeId: string): Pending | undefined {
    return this.#pending.get(challengeId);
  }

  set(challengeId: string, pending: Pending): this {
    this.#pending.set(challengeId, pending);
    return this;
  }

  delete(challengeId: string): boolean {
    return this.#pending.delete(challengeId);
  }

  clear(): void {
    this.#pending.clear();
  }

  [Symbol.iterator](): MapIterator<[string, Pending]> {
    return this.#pending[Symbol.iterator]();
  }

  claim<Role extends string>(input: {
    challengeId: string;
    peerRole: Role;
    binding: OwnerPresenceBinding;
    now: number;
    expectedRole(pending: Pending): Role;
  }): { pending: Pending; issue: OwnerPresenceClaimIssue | null } {
    const pending = this.#pending.get(input.challengeId);
    if (!pending) {
      throw new OwnerPresenceCoordinatorError(
        "replayed",
        "Owner-presence challenge is unavailable",
      );
    }
    this.#pending.delete(input.challengeId);
    const expectedRole = input.expectedRole(pending);
    if (input.peerRole !== expectedRole) {
      return { pending, issue: "role_mismatch" };
    }
    if (
      input.binding.connectionId !== pending.binding.connectionId ||
      input.binding.peerPid !== pending.binding.peerPid
    ) {
      return { pending, issue: "binding_mismatch" };
    }
    if (pending.challengeExpiresAt <= input.now) {
      return { pending, issue: "expired" };
    }
    return { pending, issue: null };
  }
}
