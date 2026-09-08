import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { VaultContext } from "@afternote/memory";

export function localVaultContext(path: string): VaultContext {
  return {
    vaultId: createHash("sha256")
      .update(canonicalVaultPath(path))
      .digest("hex"),
    deployment: "local",
  };
}

export function localVaultLifecycleLockPath(path: string): string {
  const canonicalPath = canonicalVaultPath(path);
  return join(
    dirname(canonicalPath),
    `.${basename(canonicalPath)}.afternote.lock`,
  );
}

export function canonicalVaultPath(path: string): string {
  const absolutePath = resolve(path);
  if (existsSync(absolutePath)) return realpathSync.native(absolutePath);
  const parent = dirname(absolutePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  return join(realpathSync.native(parent), basename(absolutePath));
}
