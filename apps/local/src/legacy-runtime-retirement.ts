import {
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { localVaultLifecycleLockPath } from "./local-vault";
import { ExclusiveFileLock } from "./sqlcipher-database";

export function assertLegacyRuntimeRetired(
  options: {
    runtimePath: string;
    vaultPath: string;
  },
  acquireLock: LegacyRuntimeLockFactory = acquireNativeLock,
): void {
  let lock: LegacyRuntimeLock;
  try {
    lock = acquireLock(
      localVaultLifecycleLockPath(options.vaultPath),
      "Legacy Afternote runtime still owns the vault lifecycle lock",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Vault lifecycle lock path is invalid")
    ) {
      throw new Error("Legacy Afternote vault lifecycle lock is invalid", {
        cause: error,
      });
    }
    throw error;
  }
  try {
    for (const name of ["runtime.json", "runtime.token"]) {
      if (pathEntryExists(join(options.runtimePath, name))) {
        throw new Error("Legacy Afternote runtime state remains");
      }
    }
  } finally {
    lock.release();
  }
}

type LegacyRuntimeLock = { release(): void };

type LegacyRuntimeLockFactory = (
  path: string,
  busyMessage: string,
) => LegacyRuntimeLock;

function acquireNativeLock(path: string, busyMessage: string): LegacyRuntimeLock {
  return new ExclusiveFileLock(path, busyMessage);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
