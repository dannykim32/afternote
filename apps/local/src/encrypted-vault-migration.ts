import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  atomicExchangeFiles,
  ExclusiveFileLock,
  SqlcipherDatabase,
} from "./sqlcipher-database";

export type LegacyPlaintextDecision =
  | { action: "keep" }
  | { action: "delete" }
  | { action: "move"; destinationPath: string };

export type LegacyArtifactDecision = {
  path: string;
  decision: LegacyPlaintextDecision;
};

export type EncryptionMigrationFault =
  | "after_candidate_created"
  | "after_rollback_created"
  | "after_source_prepared"
  | "after_candidate_verified"
  | "after_swap";

export type EncryptionMigrationReadiness =
  | "plaintext"
  | "resumable"
  | "ineligible";

type MigrationMarker = {
  version: 1;
  phase: "candidate_verified" | "swapped" | "cleanup_complete";
  candidateName: string;
  rollbackName: string;
  legacyName: string;
  sourceDigest: string;
  coordinationDigest: string | null;
  completion: {
    legacyPlaintextRetained: boolean;
    legacyArtifactsFound: number;
    legacyArtifactsRetained: number;
  } | null;
};

type MigrationOptionsBase = {
  databasePath: string;
  key: Uint8Array;
  legacyDecision: LegacyPlaintextDecision;
  legacyArtifactDecisions?: LegacyArtifactDecision[];
  additionalLegacyArtifactPaths?: string[];
  injectFault?: (phase: EncryptionMigrationFault) => void;
  lifecycleLock?: ExclusiveFileLock;
};

type MigrationOptions = MigrationOptionsBase & (
  | { deferFinalization: true; coordinationDigest: string }
  | { deferFinalization?: false; coordinationDigest?: undefined }
);

type MigrationResult = {
  encryptedRollbackPath: string;
  legacyPlaintextPath: string | null;
  legacyPlaintextRetained: boolean;
  retainedPlaintextPaths: string[];
  legacyArtifactsFound: number;
  legacyArtifactsRetained: number;
};

export type EncryptionMigrationApprovalSnapshot = {
  readiness: Exclude<EncryptionMigrationReadiness, "ineligible">;
  databaseDigest: string;
  markerDigest: string | null;
  artifacts: { path: string; digest: string }[];
};

export function encryptionMigrationReadiness(
  databasePath: string,
): EncryptionMigrationReadiness {
  const resolvedDatabase = resolve(databasePath);
  if (!existsSync(resolvedDatabase)) return "ineligible";
  const sourceInfo = lstatSync(resolvedDatabase);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Refusing unsafe vault path: ${resolvedDatabase}`);
  }
  const markerPath = `${resolvedDatabase}.encryption-migration.json`;
  if (readMarker(markerPath, resolvedDatabase)) return "resumable";
  const descriptor = openSync(
    resolvedDatabase,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const header = Buffer.alloc(16);
    return readSync(descriptor, header, 0, header.length, 0) === header.length &&
        header.equals(Buffer.from("SQLite format 3\0"))
      ? "plaintext"
      : "ineligible";
  } finally {
    closeSync(descriptor);
  }
}

export function encryptionMigrationRecoveryPending(databasePath: string): boolean {
  const resolvedDatabase = resolve(databasePath);
  try {
    return readMarker(
      `${resolvedDatabase}.encryption-migration.json`,
      resolvedDatabase,
    ) !== null;
  } catch {
    throw new Error("Vault encryption migration recovery state is invalid");
  }
}

export function encryptionMigrationRecoveryCoordinationDigest(
  databasePath: string,
): string | null {
  const resolvedDatabase = resolve(databasePath);
  return readMarker(
    `${resolvedDatabase}.encryption-migration.json`,
    resolvedDatabase,
  )?.coordinationDigest ?? null;
}

export function encryptionMigrationApprovalSnapshot(
  databasePath: string,
): EncryptionMigrationApprovalSnapshot {
  const resolvedDatabase = resolve(databasePath);
  const readiness = encryptionMigrationReadiness(resolvedDatabase);
  if (readiness === "ineligible") {
    throw new Error("Vault is not eligible for plaintext migration");
  }
  const markerPath = `${resolvedDatabase}.encryption-migration.json`;
  const artifacts = inventoryLegacyPlaintextArtifacts(resolvedDatabase).map((path) => ({
    path,
    digest: hashFile(path),
  }));
  return {
    readiness,
    databaseDigest: hashFile(resolvedDatabase),
    markerDigest: existsSync(markerPath) ? hashFile(markerPath) : null,
    artifacts,
  };
}

export function finalizePlaintextVaultMigration(
  databasePath: string,
  coordinationDigest: string,
  lifecycleLock?: ExclusiveFileLock,
): void {
  const resolvedDatabase = realpathSync.native(resolve(databasePath));
  const parent = dirname(resolvedDatabase);
  const markerPath = `${resolvedDatabase}.encryption-migration.json`;
  const lock = lifecycleLock ? undefined : new ExclusiveFileLock(
    join(parent, `.${basename(resolvedDatabase)}.afternote.lock`),
    "Vault encryption migration finalization requires exclusive ownership",
  );
  try {
    const marker = readMarker(markerPath, resolvedDatabase);
    if (
      !marker ||
      marker.phase !== "cleanup_complete" ||
      marker.coordinationDigest !== coordinationDigest
    ) {
      throw new Error("Encryption migration completion marker is unavailable");
    }
    rmSync(markerPath);
    syncDirectory(parent);
  } finally {
    lock?.release();
  }
}

export function migratePlaintextVault(options: MigrationOptions): MigrationResult {
  const hasCoordinationDigest = typeof options.coordinationDigest === "string";
  if (
    (options.deferFinalization === true) !== hasCoordinationDigest ||
    (hasCoordinationDigest && !/^[a-f0-9]{64}$/.test(options.coordinationDigest!))
  ) {
    throw new Error("Encryption migration coordination digest is invalid");
  }
  const databasePath = realpathSync.native(resolve(options.databasePath));
  const lockPath = join(
    dirname(databasePath),
    `.${basename(databasePath)}.afternote.lock`,
  );
  const lock = options.lifecycleLock ? undefined : new ExclusiveFileLock(
    lockPath,
    "Vault encryption migration requires exclusive ownership",
  );
  try {
    return migratePlaintextVaultUnlocked({ ...options, databasePath });
  } finally {
    lock?.release();
  }
}

function migratePlaintextVaultUnlocked(options: MigrationOptions): MigrationResult {
  const databasePath = resolve(options.databasePath);
  const parent = dirname(databasePath);
  const markerPath = `${databasePath}.encryption-migration.json`;
  const candidatePath = `${databasePath}.encryption-candidate`;
  const rollbackPath = `${databasePath}.encrypted-rollback`;
  const sourceInfo = lstatSync(databasePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Refusing unsafe plaintext vault path: ${databasePath}`);
  }
  const inventory = inventoryLegacyPlaintextArtifacts(
    databasePath,
    options.additionalLegacyArtifactPaths,
  );
  const decisions = new Map(
    (options.legacyArtifactDecisions ?? []).map((entry) => [
      realpathSync.native(resolve(entry.path)),
      entry.decision,
    ]),
  );
  for (const artifact of inventory) {
    if (!decisions.has(artifact)) {
      throw new Error(`Legacy plaintext artifact requires an explicit decision: ${artifact}`);
    }
  }
  validateLegacyArtifactDecisions(inventory, [...decisions].map(([path, decision]) => ({
    path,
    decision,
  })));
  const fingerprint = hashFile(databasePath).slice(0, 16);
  const legacyPath = `${databasePath}.legacy-plaintext-${fingerprint}`;
  let marker = readMarker(markerPath, databasePath);
  validateCombinedLegacyMovePlan({
    databasePath,
    markerPath,
    candidatePath,
    rollbackPath,
    legacyPath,
    marker,
    inventory,
    decisions,
    liveDecision: options.legacyDecision,
  });
  const coordinationDigest = options.coordinationDigest ?? null;
  if (marker?.coordinationDigest === null && coordinationDigest !== null) {
    marker = { ...marker, coordinationDigest };
    writeMarker(markerPath, marker);
  } else if (marker && marker.coordinationDigest !== coordinationDigest) {
    throw new Error("Encryption migration recovery policy changed");
  }
  if (marker?.phase === "cleanup_complete") {
    const completedPaths = markerPaths(databasePath, marker);
    if (existsSync(completedPaths.candidatePath)) {
      throw new Error(
        "Encryption migration completion marker conflicts with a remaining displaced vault",
      );
    }
    assertEncryptedCandidate(databasePath, options.key);
    assertEncryptedCandidate(completedPaths.rollbackPath, options.key);
    const completion = marker.completion!;
    const retainedLivePath = options.legacyDecision.action === "move"
      ? resolve(options.legacyDecision.destinationPath)
      : legacyPath;
    return {
      encryptedRollbackPath: rollbackPath,
      legacyPlaintextPath: completion.legacyPlaintextRetained && existsSync(retainedLivePath)
        ? retainedLivePath
        : null,
      legacyPlaintextRetained: completion.legacyPlaintextRetained,
      retainedPlaintextPaths: [],
      legacyArtifactsFound: completion.legacyArtifactsFound,
      legacyArtifactsRetained: completion.legacyArtifactsRetained,
    };
  }

  if (!marker) {
    removeUnpublishedGeneratedFile(candidatePath);
    removeUnpublishedGeneratedFile(rollbackPath);
    if (existsSync(legacyPath)) {
      throw new Error(`Refusing encryption migration with untracked artifact: ${legacyPath}`);
    }
    const source = new Database(databasePath);
    let before: VaultSnapshot;
    try {
      before = snapshot(source);
      if (before.schemaVersion < 8 || before.schemaVersion > 11) {
        throw new Error(
          `Encryption migration requires schema 8 through 11, found ${before.schemaVersion}`,
        );
      }
      if (before.integrity !== "ok") throw new Error("Plaintext vault failed integrity_check");
    } finally {
      source.close();
    }

    const candidate = new SqlcipherDatabase(candidatePath, { key: options.key });
    try {
      candidate.importPlaintext(databasePath, before.schemaVersion);
      clearImportedBrokerAuthority(candidate);
      const after = snapshot(candidate);
      assertEqualSnapshot(before, after);
      syncFile(candidatePath);
      options.injectFault?.("after_candidate_created");
      const rollback = new SqlcipherDatabase(rollbackPath, { key: options.key });
      try {
        candidate.backupTo(rollback);
        assertEqualSnapshot(before, snapshot(rollback));
      } finally {
        rollback.close();
      }
      syncFile(rollbackPath);
      options.injectFault?.("after_rollback_created");
    } finally {
      candidate.close();
    }
    preparePlaintextForExchange(databasePath, before);
    options.injectFault?.("after_source_prepared");
    chmodSync(candidatePath, 0o600);
    chmodSync(rollbackPath, 0o600);
    syncFile(candidatePath);
    syncFile(rollbackPath);
    syncDirectory(parent);
    marker = {
      version: 1,
      phase: "candidate_verified",
      candidateName: basename(candidatePath),
      rollbackName: basename(rollbackPath),
      legacyName: basename(legacyPath),
      sourceDigest: snapshotDigest(before),
      coordinationDigest,
      completion: null,
    };
    writeMarker(markerPath, marker);
    options.injectFault?.("after_candidate_verified");
  }

  const paths = markerPaths(databasePath, marker);
  if (marker.phase === "candidate_verified") {
    if (!isEncryptedVault(databasePath, options.key)) {
      const currentSource = new Database(databasePath);
      let currentDigest: string;
      try {
        currentDigest = snapshotDigest(snapshot(currentSource));
      } finally {
        currentSource.close();
      }
      if (currentDigest !== marker.sourceDigest) {
        removeGeneratedFile(paths.candidatePath);
        removeGeneratedFile(paths.rollbackPath);
        rmSync(markerPath);
        syncDirectory(parent);
        return migratePlaintextVaultUnlocked(options);
      }
      assertEncryptedCandidate(paths.candidatePath, options.key);
      atomicExchangeFiles(databasePath, paths.candidatePath);
      syncDirectory(parent);
    }
    marker = { ...marker, phase: "swapped" };
    writeMarker(markerPath, marker);
    options.injectFault?.("after_swap");
  }

  assertEncryptedCandidate(databasePath, options.key);
  let legacyPlaintextPath: string | null = null;
  if (existsSync(paths.candidatePath)) {
    if (options.legacyDecision.action === "delete") {
      rmSync(paths.candidatePath);
    } else {
      const destination = options.legacyDecision.action === "move"
        ? resolve(options.legacyDecision.destinationPath)
        : paths.legacyPath;
      movePlaintextFile(paths.candidatePath, destination);
      chmodSync(destination, 0o600);
      syncDirectory(dirname(destination));
      legacyPlaintextPath = destination;
    }
    syncDirectory(parent);
  } else if (options.legacyDecision.action !== "delete") {
    const destination = options.legacyDecision.action === "move"
      ? resolve(options.legacyDecision.destinationPath)
      : paths.legacyPath;
    if (existsSync(destination)) legacyPlaintextPath = destination;
  }
  const retainedPlaintextPaths = applyLegacyArtifactDecisions(inventory, decisions);
  const result = {
    encryptedRollbackPath: paths.rollbackPath,
    legacyPlaintextPath,
    legacyPlaintextRetained: legacyPlaintextPath !== null,
    retainedPlaintextPaths,
    legacyArtifactsFound: inventory.length,
    legacyArtifactsRetained: retainedPlaintextPaths.length,
  };
  if (options.deferFinalization) {
    marker = {
      ...marker,
      phase: "cleanup_complete",
      completion: {
        legacyPlaintextRetained: result.legacyPlaintextRetained,
        legacyArtifactsFound: result.legacyArtifactsFound,
        legacyArtifactsRetained: result.legacyArtifactsRetained,
      },
    };
    writeMarker(markerPath, marker);
  } else {
    rmSync(markerPath, { force: true });
    syncDirectory(parent);
  }
  return result;
}

const IMPORTED_BROKER_STATE_TABLES = [
  "broker_request_replays",
  "broker_connector_idempotency",
  "broker_browser_captures",
  "broker_forget_decisions",
  "broker_sessions",
  "broker_grants",
  "broker_connector_reconnects",
  "broker_pairing_requests",
  "broker_clients",
  "broker_owner_decisions",
  "broker_audit_events",
  "broker_lifecycle_state",
] as const;

function clearImportedBrokerAuthority(database: SqlcipherDatabase): void {
  const present = new Set(
    database.query<{ name: string }, []>(`
      select name from sqlite_schema
      where type = 'table' and name like 'broker_%'
    `).all().map((row) => row.name),
  );
  database.exec("pragma foreign_keys = off");
  try {
    database.transaction(() => {
      for (const table of IMPORTED_BROKER_STATE_TABLES) {
        if (present.has(table)) database.exec(`delete from ${table}`);
      }
    })();
  } finally {
    database.exec("pragma foreign_keys = on");
  }
}

export function inventoryLegacyPlaintextArtifacts(
  databasePath: string,
  additionalPaths: string[] = [],
): string[] {
  const resolvedDatabase = resolve(databasePath);
  const parent = dirname(resolvedDatabase);
  const databaseName = basename(resolvedDatabase);
  const discovered = readdirSync(parent, { withFileTypes: true })
    .filter((entry) =>
      entry.isFile() &&
      (entry.name.endsWith(".afternote.json") ||
        (entry.name.startsWith(`${databaseName}.pre-migration-v`) && entry.name.endsWith(".db"))),
    )
    .map((entry) => join(parent, entry.name));
  const backupsDirectory = join(parent, "backups");
  if (existsSync(backupsDirectory) && lstatSync(backupsDirectory).isDirectory()) {
    discovered.push(
      ...readdirSync(backupsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => join(backupsDirectory, entry.name)),
    );
  }
  for (const path of additionalPaths) discovered.push(resolve(path));
  return [...new Set(discovered.map((path) => realpathSync.native(path)))].sort();
}

export function validateLegacyArtifactDecisions(
  inventory: string[],
  decisions: LegacyArtifactDecision[],
): void {
  const decisionMap = new Map(decisions.map((entry) => {
    const path = resolve(entry.path);
    return [existsSync(path) ? realpathSync.native(path) : path, entry.decision] as const;
  }));
  const sources = new Set(inventory.map(canonicalDestinationIdentity));
  const destinations = new Map<string, string>();
  for (const source of inventory) {
    const decision = decisionMap.get(source)!;
    if (decision.action !== "move") continue;
    const destination = resolve(decision.destinationPath);
    const destinationIdentity = canonicalDestinationIdentity(destination);
    const priorSource = destinations.get(destinationIdentity);
    if (priorSource && priorSource !== source) {
      throw new Error("Legacy plaintext move destinations must be unique");
    }
    if (sources.has(destinationIdentity)) {
      throw new Error("Legacy plaintext move destination must not replace an inventoried source");
    }
    if (existsSync(destination)) {
      const destinationInfo = lstatSync(destination);
      if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) {
        throw new Error(`Refusing unsafe legacy plaintext destination: ${destination}`);
      }
      if (hashFile(source) !== hashFile(destination)) {
        throw new Error(`Legacy plaintext destination already exists: ${destination}`);
      }
    }
    destinations.set(destinationIdentity, source);
  }
}

function validateCombinedLegacyMovePlan(options: {
  databasePath: string;
  markerPath: string;
  candidatePath: string;
  rollbackPath: string;
  legacyPath: string;
  marker: MigrationMarker | null;
  inventory: string[];
  decisions: ReadonlyMap<string, LegacyPlaintextDecision>;
  liveDecision: LegacyPlaintextDecision;
}): void {
  const protectedPaths = new Set([
    options.databasePath,
    options.markerPath,
    options.candidatePath,
    options.rollbackPath,
    ...options.inventory,
  ].map(canonicalDestinationIdentity));
  const artifactDestinations = new Set<string>();
  for (const source of options.inventory) {
    const decision = options.decisions.get(source)!;
    if (decision.action !== "move") continue;
    const destination = canonicalDestinationIdentity(decision.destinationPath);
    if (protectedPaths.has(destination)) {
      throw new Error("Legacy plaintext move destination conflicts with migration input");
    }
    artifactDestinations.add(destination);
  }
  if (options.liveDecision.action === "delete") return;
  const liveDestinationPath = options.liveDecision.action === "move"
    ? resolve(options.liveDecision.destinationPath)
    : options.legacyPath;
  const liveDestination = canonicalDestinationIdentity(liveDestinationPath);
  if (protectedPaths.has(liveDestination)) {
    throw new Error("Live plaintext destination conflicts with migration input");
  }
  if (artifactDestinations.has(liveDestination)) {
    throw new Error("Live and artifact plaintext move destinations must be unique");
  }
  if (!existsSync(liveDestinationPath)) return;
  const priorLiveMoveCompleted = options.marker?.phase === "swapped" &&
    !existsSync(options.candidatePath) &&
    plaintextVaultMatchesDigest(liveDestinationPath, options.marker.sourceDigest);
  const resumablePublishedCopy = options.marker?.phase === "swapped" &&
    existsSync(options.candidatePath) &&
    hashFile(options.candidatePath) === hashFile(liveDestinationPath);
  if (!priorLiveMoveCompleted && !resumablePublishedCopy) {
    throw new Error("Live plaintext destination already exists");
  }
}

function plaintextVaultMatchesDigest(path: string, expectedDigest: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const database = new Database(path, { readonly: true });
    try {
      return snapshotDigest(snapshot(database)) === expectedDigest;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function canonicalDestinationIdentity(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync.native(resolved);
  const suffix: string[] = [];
  let ancestor = resolved;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync.native(ancestor), ...suffix);
}

function applyLegacyArtifactDecisions(
  inventory: string[],
  decisions: ReadonlyMap<string, LegacyPlaintextDecision>,
): string[] {
  const retained: string[] = [];
  for (const path of inventory) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing unsafe legacy plaintext artifact: ${path}`);
    }
    const decision = decisions.get(path)!;
    if (decision.action === "keep") {
      retained.push(path);
    } else if (decision.action === "delete") {
      rmSync(path);
    } else {
      const destination = resolve(decision.destinationPath);
      movePlaintextFile(path, destination);
      retained.push(destination);
    }
  }
  return retained;
}

function movePlaintextFile(source: string, destination: string): void {
  const canonicalSource = realpathSync.native(source);
  if (existsSync(destination) && realpathSync.native(destination) === canonicalSource) {
    throw new Error("Legacy plaintext move destination must differ from its source");
  }
  if (existsSync(destination)) {
    if (hashFile(source) !== hashFile(destination)) {
      throw new Error(`Legacy plaintext destination already exists: ${destination}`);
    }
    rmSync(source);
    syncDirectory(dirname(source));
    return;
  }
  try {
    renameSync(source, destination);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
    const partial = `${destination}.afternote-partial`;
    if (existsSync(partial)) {
      const info = lstatSync(partial);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Refusing unsafe partial legacy plaintext copy: ${partial}`);
      }
      rmSync(partial);
    }
    copyFileSync(source, partial, constants.COPYFILE_EXCL);
    chmodSync(partial, 0o600);
    syncFile(partial);
    if (hashFile(source) !== hashFile(partial)) {
      rmSync(partial, { force: true });
      throw new Error("Cross-volume legacy plaintext copy failed verification");
    }
    renameSync(partial, destination);
    syncDirectory(dirname(destination));
    rmSync(source);
  }
  chmodSync(destination, 0o600);
  syncDirectory(dirname(source));
  syncDirectory(dirname(destination));
}

type VaultSnapshot = {
  schemaVersion: number;
  integrity: string;
  schema: unknown[];
  notes: unknown[];
  revisions: unknown[];
  embeddings: unknown[];
  chunks: unknown[];
  smartViews: unknown[];
  organization: unknown[];
  facets: unknown[];
  temporalIndex: unknown[];
  temporalAnnotations: unknown[];
  archiveDigest?: string;
};

type QueryDatabase = {
  query(sql: string): {
    get(): Record<string, unknown> | undefined;
    all(): Array<Record<string, unknown>>;
    iterate(): Iterable<Record<string, unknown>>;
  };
};

function snapshot(database: Database | SqlcipherDatabase): VaultSnapshot {
  const queryable = database as unknown as QueryDatabase;
  const rows = (sql: string) => queryable.query(sql).all().map(normalizeRow);
  const schemaVersion = Number(
    queryable.query("pragma user_version").get()?.user_version ?? 0,
  );
  return {
    schemaVersion,
    integrity: String(
      queryable.query("pragma integrity_check").get()?.integrity_check ?? "failed",
    ),
    schema: rows("select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name"),
    notes: rows("select rowid, id, content, source_json, created_at, updated_at, current_revision, source_search from notes order by id"),
    revisions: rows("select note_id, revision, content, source_json, created_at from note_revisions order by note_id, revision"),
    embeddings: rows("select * from note_embeddings order by note_id"),
    chunks: rows("select * from note_embedding_chunks order by note_id, chunk_index"),
    smartViews: rows("select * from note_smart_views order by note_id, view_id"),
    organization: rows("select * from note_organization order by note_id"),
    facets: rows("select * from note_organization_facets order by note_id, facet_kind, facet_key"),
    temporalIndex: schemaVersion >= 9
      ? rows("select * from note_temporal_index order by note_id")
      : [],
    temporalAnnotations: schemaVersion >= 9
      ? rows("select * from note_temporal_annotations order by note_id, annotation_index")
      : [],
    ...(schemaVersion >= 11 ? { archiveDigest: archiveSnapshotDigest(queryable) } : {}),
  };
}

function archiveSnapshotDigest(database: QueryDatabase): string {
  const hash = createHash("sha256");
  // Iterate one bounded Passage at a time: never serialize an entire transcript
  // through the native adapter's one-MiB response boundary.
  for (const sql of [
    "select * from conversation_archives order by id",
    "select * from conversation_passages order by archive_id, passage_index",
  ]) {
    hash.update(sql);
    for (const row of database.query(sql).iterate()) {
      hash.update(JSON.stringify(normalizeRow(row)) + "\n");
    }
  }
  return hash.digest("hex");
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex") : value,
  ]));
}

function assertEqualSnapshot(expected: VaultSnapshot, actual: VaultSnapshot): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Encrypted vault failed exact canonical equality");
  }
}

function snapshotDigest(snapshotValue: VaultSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshotValue)).digest("hex");
}

function assertEncryptedCandidate(path: string, key: Uint8Array): void {
  const database = new SqlcipherDatabase(path, { key, readonly: true });
  try {
    const state = snapshot(database);
    if (
      (state.schemaVersion < 8 || state.schemaVersion > 11) ||
      state.integrity !== "ok"
    ) {
      throw new Error("Encrypted migration candidate failed validation");
    }
  } finally {
    database.close();
  }
}

function preparePlaintextForExchange(path: string, expected: VaultSnapshot): void {
  const database = new Database(path);
  try {
    database.exec("pragma busy_timeout=2000");
    database.query("pragma wal_checkpoint(full)").get();
    database.query("pragma journal_mode=delete").get();
    assertEqualSnapshot(expected, snapshot(database));
  } finally {
    database.close();
  }
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
  syncFile(path);
  syncDirectory(dirname(path));
}

function isEncryptedVault(path: string, key: Uint8Array): boolean {
  try {
    assertEncryptedCandidate(path, key);
    return true;
  } catch {
    return false;
  }
}

function markerPaths(databasePath: string, marker: MigrationMarker) {
  const parent = dirname(databasePath);
  return {
    candidatePath: safeSibling(parent, marker.candidateName),
    rollbackPath: safeSibling(parent, marker.rollbackName),
    legacyPath: safeSibling(parent, marker.legacyName),
  };
}

function safeSibling(parent: string, name: string): string {
  if (basename(name) !== name || name === "." || name === "..") {
    throw new Error("Invalid encryption migration marker path");
  }
  return join(parent, name);
}

function readMarker(markerPath: string, databasePath: string): MigrationMarker | null {
  let entry;
  try {
    entry = lstatSync(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Refusing unsafe encryption migration marker: ${markerPath}`);
  }
  const descriptor = openSync(
    markerPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let serialized: string;
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile() || before.size < 1 || before.size > 8_192 ||
      before.dev !== entry.dev || before.ino !== entry.ino
    ) {
      throw new Error("Encryption migration marker is unsafe");
    }
    serialized = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const afterPath = lstatSync(markerPath);
    if (
      !afterPath.isFile() || afterPath.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      Buffer.byteLength(serialized) !== after.size ||
      after.dev !== afterPath.dev || after.ino !== afterPath.ino ||
      after.size !== afterPath.size || after.mtimeMs !== afterPath.mtimeMs ||
      after.ctimeMs !== afterPath.ctimeMs
    ) {
      throw new Error("Encryption migration marker changed while it was read");
    }
  } finally {
    closeSync(descriptor);
  }
  const parsed = JSON.parse(serialized) as Partial<MigrationMarker>;
  const marker = {
    ...parsed,
    coordinationDigest: parsed.coordinationDigest === undefined
      ? null
      : parsed.coordinationDigest,
    completion: parsed.completion === undefined ? null : parsed.completion,
  };
  if (
    marker.version !== 1 ||
    (marker.phase !== "candidate_verified" &&
      marker.phase !== "swapped" &&
      marker.phase !== "cleanup_complete") ||
    typeof marker.candidateName !== "string" ||
    typeof marker.rollbackName !== "string" ||
    typeof marker.legacyName !== "string" ||
    typeof marker.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.sourceDigest) ||
    (marker.coordinationDigest !== null &&
      (typeof marker.coordinationDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(marker.coordinationDigest))) ||
    !validMigrationCompletion(marker.phase, marker.completion)
  ) {
    throw new Error(`Invalid encryption migration marker for ${databasePath}`);
  }
  const validated = marker as MigrationMarker;
  const expectedCandidate = basename(`${databasePath}.encryption-candidate`);
  const expectedRollback = basename(`${databasePath}.encrypted-rollback`);
  const expectedLegacyPrefix = `${basename(databasePath)}.legacy-plaintext-`;
  if (
    validated.candidateName !== expectedCandidate ||
    validated.rollbackName !== expectedRollback ||
    !validated.legacyName.startsWith(expectedLegacyPrefix) ||
    !/^[a-f0-9]{16}$/.test(validated.legacyName.slice(expectedLegacyPrefix.length))
  ) {
    throw new Error(`Encryption migration marker names do not match ${databasePath}`);
  }
  markerPaths(databasePath, validated);
  return validated;
}

function validMigrationCompletion(
  phase: MigrationMarker["phase"] | undefined,
  value: unknown,
): boolean {
  if (phase !== "cleanup_complete") return value === null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const completion = value as Record<string, unknown>;
  return Object.keys(completion).sort().join(",") ===
      "legacyArtifactsFound,legacyArtifactsRetained,legacyPlaintextRetained" &&
    typeof completion.legacyPlaintextRetained === "boolean" &&
    Number.isSafeInteger(completion.legacyArtifactsFound) &&
    (completion.legacyArtifactsFound as number) >= 0 &&
    Number.isSafeInteger(completion.legacyArtifactsRetained) &&
    (completion.legacyArtifactsRetained as number) >= 0 &&
    (completion.legacyArtifactsRetained as number) <=
      (completion.legacyArtifactsFound as number);
}

function removeUnpublishedGeneratedFile(path: string): void {
  if (!existsSync(path)) return;
  removeGeneratedFile(path);
}

function removeGeneratedFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Refusing unsafe generated migration artifact: ${path}`);
  }
  rmSync(path);
}

function writeMarker(path: string, marker: MigrationMarker): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  syncFile(temporary);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function hashFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytes = 0;
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

function syncFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe migration file: ${path}`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
