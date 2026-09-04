import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const KEY_BYTES = 32;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function developmentVaultKeyPath(home: string): string {
  if (!isAbsolute(home)) throw new Error("Development vault home must be absolute");
  return join(home, ".afternote", "development-vault.key");
}

export function getOrCreateDevelopmentVaultKey(path: string): Uint8Array {
  if (!isAbsolute(path) || !path.endsWith("/.afternote/development-vault.key")) {
    throw new Error("Development vault-key path is invalid");
  }
  const directory = path.slice(0, -"/development-vault.key".length);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const directoryStatus = lstatSync(directory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error("Development vault-key directory is invalid");
  }
  if ((directoryStatus.mode & 0o077) !== 0) {
    throw new Error("Development vault-key directory permissions are too broad");
  }
  if (existsSync(path)) return readDevelopmentVaultKey(path);

  const candidate = randomBytes(KEY_BYTES);
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    );
    created = true;
    writeFileSync(descriptor, candidate);
    fsyncSync(descriptor);
    chmodSync(path, PRIVATE_FILE_MODE);
    return Uint8Array.from(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return readDevelopmentVaultKey(path);
    }
    if (created) unlinkSync(path);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    candidate.fill(0);
  }
}

export function readDevelopmentVaultKey(path: string): Uint8Array {
  const descriptor = openExistingDevelopmentVaultKey(path);
  try {
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== KEY_BYTES) {
      bytes.fill(0);
      throw new Error("Development vault key has an invalid length");
    }
    const key = Uint8Array.from(bytes);
    bytes.fill(0);
    return key;
  } finally {
    closeSync(descriptor);
  }
}

export function developmentVaultKeySnapshot(path: string): {
  bytes: number;
  digest: string;
  inode: number;
} {
  const descriptor = openExistingDevelopmentVaultKey(path);
  try {
    const status = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    try {
      return {
        bytes: status.size,
        digest: createHash("sha256").update(bytes).digest("hex"),
        inode: status.ino,
      };
    } finally {
      bytes.fill(0);
    }
  } finally {
    closeSync(descriptor);
  }
}

function openExistingDevelopmentVaultKey(path: string): number {
  if (!isAbsolute(path) || !path.endsWith("/.afternote/development-vault.key")) {
    throw new Error("Development vault-key path is invalid");
  }
  const directory = path.slice(0, -"/development-vault.key".length);
  const directoryStatus = lstatSync(directory);
  if (
    directoryStatus.isSymbolicLink() ||
    !directoryStatus.isDirectory() ||
    directoryStatus.uid !== process.getuid?.()
  ) {
    throw new Error("Development vault-key directory is invalid");
  }
  if ((directoryStatus.mode & 0o077) !== 0) {
    throw new Error("Development vault-key directory permissions are too broad");
  }
  const pathStatus = lstatSync(path);
  if (pathStatus.isSymbolicLink() || !pathStatus.isFile()) {
    throw new Error("Development vault key is not a regular file");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || status.uid !== process.getuid?.()) {
      throw new Error("Development vault key is not a regular file");
    }
    if ((status.mode & 0o077) !== 0) {
      throw new Error("Development vault-key permissions are too broad");
    }
    if (status.size !== KEY_BYTES) {
      throw new Error("Development vault key has an invalid length");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
