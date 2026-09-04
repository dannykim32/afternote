import { chmodSync, existsSync } from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  deletePackagedClientSigner,
  openPackagedClientSigner,
  rawP256PublicKeyToPem,
} from "./client-signer-helper";

declare const AFTERNOTE_KEYCHAIN_ACCESS_GROUP: string | undefined;
declare const AFTERNOTE_RELEASE_BUILD: boolean | undefined;

type SqlValue = string | number | bigint | boolean | null | Uint8Array;

type NativeAddon = {
  open(path: string, key: Uint8Array, readonly: boolean): object;
  close(database: object): void;
  exec(database: object, sql: string): void;
  prepare(database: object, sql: string): object;
  setProgressDeadline(database: object, timeoutMs: number): void;
  clearProgressDeadline(database: object): void;
  backup(source: object, destination: object): void;
  importPlaintext(destination: object, sourcePath: string, schemaVersion: number): void;
  exchangeFiles(firstPath: string, secondPath: string): void;
  acquireFileLock(path: string): object;
  releaseFileLock(lock: object): void;
  getOrCreateVaultKey(service: string): Uint8Array;
  deleteVaultKey(service: string): void;
  getOrCreateDataProtectionVaultKey(service: string, accessGroup: string): Uint8Array;
  readDataProtectionVaultKey(service: string, accessGroup: string): Uint8Array | null;
  createDataProtectionVaultKey(service: string, accessGroup: string): Uint8Array;
  enrollDataProtectionVaultKey(
    service: string,
    accessGroup: string,
    key: Uint8Array,
  ): void;
  deleteDataProtectionVaultKey(service: string, accessGroup: string): void;
  xpcBrokerRequest(
    service: string,
    codeRequirement: string,
    request: string,
    timeoutMs: number,
  ): string;
  requireParentCodeSigningRequirement(codeRequirement: string): void;
  clientSigningPublicKey(tag: string): Uint8Array;
  signWithClientKey(tag: string, message: Uint8Array): Uint8Array;
  deleteClientSigningKey(tag: string): void;
  getOrCreateDevelopmentClientKey(service: string, candidate: Uint8Array): Uint8Array;
  deleteDevelopmentClientKey(service: string): void;
  get<Row>(statement: object, parameters: SqlValue[]): Row | undefined;
  all<Row>(statement: object, parameters: SqlValue[]): Row[];
  run(
    statement: object,
    parameters: SqlValue[],
  ): { changes: number; lastInsertRowid: number };
  start(statement: object, parameters: SqlValue[]): void;
  next<Row>(statement: object): IteratorResult<Row>;
  reset(statement: object): void;
  finalize(statement: object): void;
};

export function packagedVaultKeychainOptions(): {
  accessGroup?: string;
  allowInsecureDevelopmentIdentity?: boolean;
} {
  const accessGroup = typeof AFTERNOTE_KEYCHAIN_ACCESS_GROUP === "string"
    ? AFTERNOTE_KEYCHAIN_ACCESS_GROUP
    : undefined;
  if (accessGroup) return { accessGroup };
  if (typeof AFTERNOTE_RELEASE_BUILD === "boolean" && AFTERNOTE_RELEASE_BUILD) {
    throw new Error("Release build is missing its mandatory Keychain access group");
  }
  return { allowInsecureDevelopmentIdentity: true };
}

export function getOrCreateKeychainVaultKey(
  vaultId: string,
  options: { accessGroup?: string; allowInsecureDevelopmentIdentity?: boolean },
): Uint8Array {
  if (!options.accessGroup && !options.allowInsecureDevelopmentIdentity) {
    throw new Error(
      "Development Keychain identity is not stable; explicitly allow the exact-build fallback",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(vaultId)) throw new Error("Vault ID is invalid");
  const key = options.accessGroup
    ? loadAddon().getOrCreateDataProtectionVaultKey(
        keychainService(vaultId),
        options.accessGroup,
      )
    : loadAddon().getOrCreateVaultKey(keychainService(vaultId));
  if (key.byteLength !== 32) {
    key.fill(0);
    throw new Error("Keychain returned an invalid vault key");
  }
  const copied = Uint8Array.from(key);
  key.fill(0);
  return copied;
}

export function readDataProtectionKeychainVaultKey(
  vaultId: string,
  accessGroup: string,
): Uint8Array | null {
  assertReleaseKeychainInput(vaultId, accessGroup);
  const key = loadAddon().readDataProtectionVaultKey(
    keychainService(vaultId),
    accessGroup,
  );
  if (key === null) return null;
  return copyAndZeroVaultKey(key);
}

export function createDataProtectionKeychainVaultKey(
  vaultId: string,
  accessGroup: string,
): Uint8Array {
  assertReleaseKeychainInput(vaultId, accessGroup);
  return copyAndZeroVaultKey(loadAddon().createDataProtectionVaultKey(
    keychainService(vaultId),
    accessGroup,
  ));
}

export function enrollDataProtectionKeychainVaultKey(
  vaultId: string,
  accessGroup: string,
  key: Uint8Array,
): void {
  assertReleaseKeychainInput(vaultId, accessGroup);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("Data-protection vault key must be exactly 32 bytes");
  }
  loadAddon().enrollDataProtectionVaultKey(
    keychainService(vaultId),
    accessGroup,
    key,
  );
}

function assertReleaseKeychainInput(vaultId: string, accessGroup: string): void {
  if (!/^[a-f0-9]{64}$/.test(vaultId)) throw new Error("Vault ID is invalid");
  if (!/^[A-Z0-9]{10}\.[A-Za-z0-9.-]{1,244}$/.test(accessGroup)) {
    throw new Error("Data-protection Keychain access group is invalid");
  }
}

function copyAndZeroVaultKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    key?.fill(0);
    throw new Error("Keychain returned an invalid vault key");
  }
  const copied = Uint8Array.from(key);
  key.fill(0);
  return copied;
}

export function deleteKeychainVaultKeyForTest(vaultId: string, accessGroup?: string): void {
  if (!/^[a-f0-9]{64}$/.test(vaultId)) throw new Error("Vault ID is invalid");
  if (accessGroup) {
    loadAddon().deleteDataProtectionVaultKey(keychainService(vaultId), accessGroup);
  } else {
    loadAddon().deleteVaultKey(keychainService(vaultId));
  }
}

function keychainService(vaultId: string): string {
  return `dev.afternote.vault.${vaultId.slice(0, 32)}`;
}

export function requestVaultBrokerXpc(
  service: string,
  codeRequirement: string,
  request: string,
  timeoutMs = 5_000,
): string {
  if (!/^[A-Za-z0-9.-]{1,255}$/.test(service)) {
    throw new Error("Broker Mach service name is invalid");
  }
  if (!request || Buffer.byteLength(request) > 1_048_576) {
    throw new Error("Broker request is malformed or oversized");
  }
  assertCodeSigningRequirement(codeRequirement, "Broker");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 130_000) {
    throw new Error("Broker request timeout is invalid");
  }
  return loadAddon().xpcBrokerRequest(service, codeRequirement, request, timeoutMs);
}

export function requireParentCodeSigningRequirement(codeRequirement: string): void {
  assertCodeSigningRequirement(codeRequirement, "Parent");
  loadAddon().requireParentCodeSigningRequirement(codeRequirement);
}

export function getOrCreateClientSigningPublicKey(tag: string): string {
  assertClientSigningTag(tag);
  const raw = Buffer.from(loadAddon().clientSigningPublicKey(tag));
  return rawP256PublicKeyToPem(raw);
}

export function signWithClientKey(tag: string, message: string): string {
  assertClientSigningTag(tag);
  if (!message || Buffer.byteLength(message) > 1_048_576) {
    throw new Error("Client signing message is invalid");
  }
  return Buffer.from(
    loadAddon().signWithClientKey(tag, Buffer.from(message)),
  ).toString("base64url");
}

export function deleteClientSigningKeyForTest(tag: string): void {
  assertClientSigningTag(tag);
  if (typeof AFTERNOTE_RELEASE_BUILD === "boolean" && AFTERNOTE_RELEASE_BUILD) {
    deletePackagedClientSigner(tag);
    return;
  }
  loadAddon().deleteClientSigningKey(tag);
}

export type DurableClientSigner = {
  publicKey: string;
  signingMode: "secure-enclave" | "development-exact-build";
  sign(message: string): string;
};

export function openDurableClientSigner(
  tag: string,
  options: { allowInsecureDevelopmentIdentity?: boolean } = {},
): DurableClientSigner {
  assertClientSigningTag(tag);
  if (typeof AFTERNOTE_RELEASE_BUILD === "boolean" && AFTERNOTE_RELEASE_BUILD) {
    return openPackagedClientSigner(tag);
  }
  try {
    const publicKey = getOrCreateClientSigningPublicKey(tag);
    return {
      publicKey,
      signingMode: "secure-enclave",
      sign: (message) => signWithClientKey(tag, message),
    };
  } catch (error) {
    if (
      !options.allowInsecureDevelopmentIdentity ||
      !isDevelopmentClientIdentityUnavailable(error)
    ) {
      throw error;
    }
  }

  const generated = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const candidate = generated.privateKey.export({ type: "pkcs8", format: "der" });
  let stored: Uint8Array | undefined;
  try {
    stored = loadAddon().getOrCreateDevelopmentClientKey(tag, candidate);
    const privateKey = createPrivateKey({
      key: Buffer.from(stored),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = createPublicKey(privateKey)
      .export({ type: "spki", format: "pem" })
      .toString();
    return {
      publicKey,
      signingMode: "development-exact-build",
      sign(message: string): string {
        if (!message || Buffer.byteLength(message) > 1_048_576) {
          throw new Error("Client signing message is invalid");
        }
        return sign("sha256", Buffer.from(message), privateKey).toString("base64url");
      },
    };
  } finally {
    candidate.fill(0);
    stored?.fill(0);
  }
}

export function isDevelopmentClientIdentityUnavailable(error: unknown): boolean {
  return error instanceof Error && (
    error.message.includes("(-34018)") ||
    error.message.includes("(-25308)")
  );
}

export function deleteDevelopmentClientKeyForTest(tag: string): void {
  assertClientSigningTag(tag);
  loadAddon().deleteDevelopmentClientKey(tag);
}

function assertClientSigningTag(tag: string): void {
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(tag)) {
    throw new Error("Client signing-key tag is invalid");
  }
}

function assertCodeSigningRequirement(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 4_096 ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error(`${name} code-signing requirement is invalid`);
  }
}

export class SqlcipherStatement<
  Row = Record<string, unknown>,
  Parameters extends SqlValue[] = SqlValue[],
> {
  #closed = false;

  constructor(
    private readonly addon: NativeAddon,
    private readonly handle: object,
    private readonly onClose: () => void,
  ) {}

  get(...parameters: Parameters): Row | undefined {
    this.#assertOpen();
    return this.addon.get<Row>(this.handle, parameters);
  }

  all(...parameters: Parameters): Row[] {
    this.#assertOpen();
    return this.addon.all<Row>(this.handle, parameters);
  }

  run(...parameters: Parameters): { changes: number; lastInsertRowid: number } {
    this.#assertOpen();
    return this.addon.run(this.handle, parameters);
  }

  *iterate(...parameters: Parameters): IterableIterator<Row> {
    this.#assertOpen();
    this.addon.start(this.handle, parameters);
    try {
      while (true) {
        const result = this.addon.next<Row>(this.handle);
        if (result.done) return;
        yield result.value;
      }
    } finally {
      if (!this.#closed) this.addon.reset(this.handle);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.addon.finalize(this.handle);
    this.#closed = true;
    this.onClose();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLCipher statement is closed");
  }
}

export function atomicExchangeFiles(firstPath: string, secondPath: string): void {
  loadAddon().exchangeFiles(firstPath, secondPath);
}

export class ExclusiveFileLock {
  readonly #addon = loadAddon();
  readonly #handle: object;
  #released = false;

  constructor(path: string, busyMessage?: string) {
    try {
      this.#handle = this.#addon.acquireFileLock(path);
    } catch (error) {
      if (
        busyMessage
        && error instanceof Error
        && error.message.includes("owns the requested exclusive lock")
      ) {
        throw new Error(busyMessage, { cause: error });
      }
      throw error;
    }
  }

  release(): void {
    if (this.#released) return;
    this.#addon.releaseFileLock(this.#handle);
    this.#released = true;
  }
}

export class SqlcipherDatabase {
  readonly #addon: NativeAddon;
  readonly #handle: object;
  readonly #statements = new Set<WeakRef<{ close(): void }>>();
  readonly #statementFinalizer = new FinalizationRegistry<WeakRef<{ close(): void }>>(
    (reference) => this.#statements.delete(reference),
  );
  #closed = false;

  constructor(
    path: string,
    options: { key: Uint8Array; readonly?: boolean },
  ) {
    if (options.key.byteLength !== 32) {
      throw new Error("SQLCipher key must be exactly 32 bytes");
    }
    this.#addon = loadAddon();
    this.#handle = this.#addon.open(path, options.key, options.readonly ?? false);
    if (path !== ":memory:" && !options.readonly) chmodSync(path, 0o600);
  }

  exec(sql: string): void {
    this.#assertOpen();
    this.#addon.exec(this.#handle, sql);
  }

  query<Row = Record<string, unknown>, Parameters extends SqlValue[] = SqlValue[]>(
    sql: string,
  ): SqlcipherStatement<Row, Parameters> {
    this.#assertOpen();
    const statement = new SqlcipherStatement<Row, Parameters>(
      this.#addon,
      this.#addon.prepare(this.#handle, sql),
      () => {
        this.#statements.delete(reference);
        this.#statementFinalizer.unregister(reference);
      },
    );
    const reference = new WeakRef(statement);
    this.#statements.add(reference);
    this.#statementFinalizer.register(statement, reference, reference);
    return statement;
  }

  transaction<Result>(operation: () => Result): () => Result {
    return () => {
      this.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.exec("ROLLBACK");
        } catch {
          // Preserve the operation failure. A broken rollback makes the connection unusable.
        }
        throw error;
      }
    };
  }

  async withProgressDeadline<Result>(
    timeoutMs: number,
    operation: () => Promise<Result> | Result,
  ): Promise<Result> {
    this.#assertOpen();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("SQLite progress deadline is invalid");
    }
    this.#addon.setProgressDeadline(this.#handle, timeoutMs);
    try {
      return await operation();
    } finally {
      this.#addon.clearProgressDeadline(this.#handle);
    }
  }

  backupTo(destination: SqlcipherDatabase): void {
    this.#assertOpen();
    destination.#assertOpen();
    this.#addon.backup(this.#handle, destination.#handle);
  }

  importPlaintext(sourcePath: string, schemaVersion: number): void {
    this.#assertOpen();
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
      throw new Error("Schema version must be a non-negative integer");
    }
    this.#addon.importPlaintext(this.#handle, sourcePath, schemaVersion);
  }

  close(): void {
    if (this.#closed) return;
    for (const reference of [...this.#statements]) reference.deref()?.close();
    this.#statements.clear();
    this.#addon.close(this.#handle);
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("SQLCipher database is closed");
  }
}

let loadedAddon: NativeAddon | undefined;

function loadAddon(): NativeAddon {
  if (loadedAddon) return loadedAddon;
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The Afternote SQLCipher adapter currently requires macOS arm64");
  }
  const development = resolve(
    import.meta.dir,
    "../native/build/afternote_sqlcipher.node",
  );
  const adjacent = join(dirname(process.execPath), "afternote_sqlcipher.node");
  const standalone = typeof AFTERNOTE_STANDALONE !== "undefined";
  const path = standalone ? adjacent : existsSync(adjacent) ? adjacent : development;
  if (!existsSync(path)) {
    throw new Error(
      standalone
        ? `Packaged Afternote SQLCipher adapter is missing at ${path}`
        : `Afternote SQLCipher adapter is missing at ${path}; run bun run scripts/build-local-sqlcipher-addon.ts`,
    );
  }
  const require = createRequire(import.meta.url);
  loadedAddon = require(path) as NativeAddon;
  return loadedAddon;
}

declare const AFTERNOTE_STANDALONE: boolean;
