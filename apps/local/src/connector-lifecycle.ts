import { integrationIdentityIsHealthy } from "./integration-identity";

export type ConnectorLifecycleAction = "install" | "status" | "remove";

export type ConnectorProblemCode =
  | "connector_missing"
  | "connector_legacy"
  | "connector_conflict"
  | "identity_unavailable"
  | "runtime_unavailable"
  | null;

export type ConnectorLifecycleStatus = {
  toolAvailable: boolean;
  installed: boolean;
  healthy: boolean;
  configHealthy: boolean;
  identityHealthy: boolean;
  runtimeHealthy: boolean;
  repairable: boolean;
  problemCode: ConnectorProblemCode;
  command: string;
  args: readonly string[];
};

export interface ConnectorHostAdapter<Configuration, Status extends ConnectorLifecycleStatus> {
  readonly displayName: string;
  readonly afternoteCommand: string;
  readonly toolCommand: string | null;
  readonly unavailableError: string;
  readonly conflictError: string;
  readonly removalRefusedError: string;
  readonly stillInstalledError: string;
  readonly installRollbackError: string;
  readonly removalRollbackError: string;
  unavailableStatus(): Status;
  readConfiguration(): Configuration | null;
  status(configuration: Configuration | null): Status;
  isOwnedLegacy(configuration: Configuration | null): boolean;
  withRuntimeStatus(status: Status): Promise<Status>;
  existingConfigurationError(status: Status): string;
  installedConfigurationError(status: Status): string;
  add(): void;
  remove(configuration: Configuration): void;
  restore(previous: Configuration | null): void;
  identityIsHealthy(): Promise<boolean>;
}

export async function manageConnectorLifecycle<
  Configuration,
  Status extends ConnectorLifecycleStatus,
>(
  action: ConnectorLifecycleAction,
  standalone: boolean,
  adapter: ConnectorHostAdapter<Configuration, Status>,
): Promise<Status & { changed?: boolean; removed?: boolean; backup?: null }> {
  if (!standalone) {
    throw new Error(
      `${adapter.displayName} integration must be configured from a standalone Afternote artifact`,
    );
  }
  if (!adapter.toolCommand) {
    if (action === "status") return adapter.unavailableStatus();
    throw new Error(adapter.unavailableError);
  }

  const current = adapter.readConfiguration();
  const classified = adapter.status(current);
  const legacyOwned = adapter.isOwnedLegacy(current);
  if (action === "status") return adapter.withRuntimeStatus(classified);

  if (action === "install") {
    if (current && !classified.configHealthy && !legacyOwned) {
      throw new Error(adapter.conflictError);
    }
    if (classified.configHealthy) {
      const validated = await adapter.withRuntimeStatus(classified);
      if (!validated.healthy) {
        throw new Error(adapter.existingConfigurationError(validated));
      }
      return { ...validated, changed: false, backup: null };
    }

    if (!await integrationIdentityIsHealthy(() => adapter.identityIsHealthy())) {
      throw new Error("Afternote client signing identity is unavailable");
    }
    try {
      if (legacyOwned && current) adapter.remove(current);
      adapter.add();
      const installed = await adapter.withRuntimeStatus(
        adapter.status(adapter.readConfiguration()),
      );
      if (!installed.healthy) {
        throw new Error(adapter.installedConfigurationError(installed));
      }
      return { ...installed, changed: true, backup: null };
    } catch (error) {
      try {
        adapter.restore(current);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          adapter.installRollbackError,
        );
      }
      throw error;
    }
  }

  if (!current) return { ...classified, removed: false, backup: null };
  if (!classified.configHealthy) throw new Error(adapter.removalRefusedError);
  try {
    adapter.remove(current);
    const removed = adapter.status(adapter.readConfiguration());
    if (removed.installed) throw new Error(adapter.stillInstalledError);
    return { ...removed, removed: true, backup: null };
  } catch (error) {
    try {
      adapter.restore(current);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        adapter.removalRollbackError,
      );
    }
    throw error;
  }
}
