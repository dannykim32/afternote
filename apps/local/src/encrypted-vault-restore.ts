import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { VaultContext } from "@afternote/memory";
import {
  readInterchangeSnapshot,
} from "./interchange";
import { ExclusiveFileLock, SqlcipherDatabase } from "./sqlcipher-database";
import { SqliteMemory } from "./sqlite-memory";
import { restoredVaultPayloadDigests } from "./restored-vault-payload";

export type CleanVaultRestoreFault =
  | "during_candidate"
  | "after_candidate_verified"
  | "after_publish"
  | "after_audit_sealed"
  | "during_finalization";

type RestoreSourceIdentity = {
  sourceDigest: string;
  sourceBytes: number;
  noteCount: number;
  revisionCount: number;
  payloadSha256: string;
  sourceApplicationVersion: string;
};

export type CleanVaultRestoreApprovalSnapshot = RestoreSourceIdentity & {
  readiness: "clean" | "resumable";
  sourcePath: string;
  markerDigest: string | null;
  destinationDigest: string | null;
};

type RestoreMarker = RestoreSourceIdentity & {
  version: 1;
  phase: "prepared" | "candidate_verified" | "published" | "audited" | "finalizing";
  coordinationDigest: string;
  temporaryDirectoryName: string;
  baselineName: string;
  sealName: string | null;
  candidateDigest: string | null;
  finalDigest: string | null;
  authenticationTag: string;
};

export function cleanVaultRestoreApprovalSnapshot(
  sourcePath: string,
  databasePath: string,
  currentApplicationVersion: string,
): CleanVaultRestoreApprovalSnapshot {
  const requestedSource = resolve(sourcePath);
  const requestedSourceInfo = lstatSync(requestedSource);
  if (!requestedSourceInfo.isFile() || requestedSourceInfo.isSymbolicLink()) {
    throw new Error("Restore source must be a regular file");
  }
  const resolvedSource = realpathSync.native(requestedSource);
  const sourceInfo = lstatSync(resolvedSource);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("Restore source must be a regular file");
  }
  const source = readInterchangeSnapshot(resolvedSource, currentApplicationVersion);
  const document = source.document;
  const sourceIdentity: RestoreSourceIdentity = {
    sourceDigest: source.sha256,
    sourceBytes: source.bytes,
    noteCount: document.manifest.noteCount,
    revisionCount: document.manifest.revisionCount,
    payloadSha256: document.manifest.payloadSha256,
    sourceApplicationVersion: document.applicationVersion,
  };
  const resolvedDatabase = resolve(databasePath);
  if (samePathIdentity(resolvedSource, resolvedDatabase)) {
    throw new Error("Restore source and destination must differ");
  }
  const markerPath = restoreMarkerPath(resolvedDatabase);
  const marker = readRestoreMarker(markerPath, resolvedDatabase);
  const destinationDigest = existingRegularFileDigest(resolvedDatabase);
  if (destinationDigest !== null && !marker) {
    throw new Error("Restore requires a clean vault path");
  }
  if (marker && !sameRestoreSourceIdentity(marker, sourceIdentity)) {
    throw new Error("Restore recovery source changed");
  }
  if (marker && marker.phase !== "prepared" && marker.phase !== "finalizing") {
    const baselinePath = join(dirname(resolvedDatabase), marker.baselineName);
    if (
      !marker.candidateDigest ||
      existingRegularFileDigest(baselinePath) !== marker.candidateDigest
    ) {
      throw new Error("Restore recovery baseline changed");
    }
  }
  if (destinationDigest !== null && marker) {
    if (marker.phase === "prepared") {
      throw new Error("Restore recovery destination changed");
    }
    if (
      marker.phase === "candidate_verified" &&
      marker.candidateDigest !== destinationDigest
    ) {
      throw new Error("Restore recovery destination changed");
    }
    if (
      (marker.phase === "audited" || marker.phase === "finalizing") &&
      marker.finalDigest !== destinationDigest
    ) {
      throw new Error("Audited restore destination changed");
    }
  }
  if (
    destinationDigest === null && marker &&
    (marker.phase === "audited" || marker.phase === "finalizing")
  ) {
    throw new Error("Audited restore destination is missing");
  }
  return {
    readiness: marker ? "resumable" : "clean",
    sourcePath: resolvedSource,
    ...sourceIdentity,
    markerDigest: marker ? hashFile(markerPath) : null,
    destinationDigest,
  };
}

export function cleanVaultRestoreApprovalSnapshotDigest(
  snapshot: CleanVaultRestoreApprovalSnapshot,
): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function cleanVaultRestoreCoordinationDigest(
  snapshot: CleanVaultRestoreApprovalSnapshot,
  databasePath: string,
  vault: VaultContext,
): string {
  return createHash("sha256").update(JSON.stringify({
    operation: "recovery.restore",
    sourcePath: snapshot.sourcePath,
    ...restoreSourceIdentity(snapshot),
    databasePath: resolve(databasePath),
    vaultId: vault.vaultId,
  })).digest("hex");
}

export function cleanVaultRestoreRecoveryPending(databasePath: string): boolean {
  const resolvedDatabase = resolve(databasePath);
  try {
    return readRestoreMarker(restoreMarkerPath(resolvedDatabase), resolvedDatabase) !== null;
  } catch {
    throw new Error("Vault restore recovery state is invalid");
  }
}

export function restoreCleanEncryptedVault(options: {
  approvalSnapshot: CleanVaultRestoreApprovalSnapshot;
  applicationVersion: string;
  coordinationDigest: string;
  databasePath: string;
  injectFault?: (phase: CleanVaultRestoreFault) => void;
  key: Uint8Array;
  lifecycleLock?: ExclusiveFileLock;
  vault: VaultContext;
}): { auditComplete: boolean; noteCount: number; revisionCount: number } {
  if (!/^[a-f0-9]{64}$/.test(options.coordinationDigest)) {
    throw new Error("Restore coordination digest is invalid");
  }
  const databasePath = resolve(options.databasePath);
  const parent = dirname(databasePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lock = options.lifecycleLock ? undefined : new ExclusiveFileLock(
    join(parent, `.${basename(databasePath)}.afternote.lock`),
    "Vault restore requires exclusive ownership",
  );
  try {
    const current = cleanVaultRestoreApprovalSnapshot(
      options.approvalSnapshot.sourcePath,
      databasePath,
      options.applicationVersion,
    );
    if (
      !sameRestoreSourceIdentity(current, options.approvalSnapshot) ||
      cleanVaultRestoreCoordinationDigest(current, databasePath, options.vault) !==
        options.coordinationDigest
    ) {
      throw new Error("Restore source or target changed after approval");
    }
    const markerPath = restoreMarkerPath(databasePath);
    let marker = readRestoreMarker(markerPath, databasePath, options.key);
    if (marker && marker.coordinationDigest !== options.coordinationDigest) {
      throw new Error("Restore recovery approval changed");
    }
    if (marker?.phase === "audited" || marker?.phase === "finalizing") {
      if (!marker.finalDigest || hashFile(databasePath) !== marker.finalDigest) {
        throw new Error("Audited restore destination changed");
      }
      verifyEncryptedRestore(
        databasePath,
        options.key,
        marker.noteCount,
        marker.revisionCount,
        marker.payloadSha256,
        marker.sourceApplicationVersion,
      );
      return {
        auditComplete: true,
        noteCount: marker.noteCount,
        revisionCount: marker.revisionCount,
      };
    }
    if (marker && marker.phase !== "prepared") {
      assertPublishedDestinationSafe(databasePath, options.key, marker);
      cleanupTrackedSeal(parent, marker);
      restorePublishedBaseline(parent, databasePath, marker);
      verifyEncryptedRestore(
        databasePath,
        options.key,
        marker.noteCount,
        marker.revisionCount,
        marker.payloadSha256,
        marker.sourceApplicationVersion,
      );
      cleanupTrackedTemporaryDirectory(parent, marker);
      marker = { ...marker, phase: "published", finalDigest: null, sealName: null };
      writeRestoreMarker(markerPath, marker, options.key);
      return {
        auditComplete: false,
        noteCount: marker.noteCount,
        revisionCount: marker.revisionCount,
      };
    }

    if (marker) {
      cleanupTrackedTemporaryDirectory(parent, marker);
      cleanupPreparedBaseline(parent, marker);
    }
    const temporaryDirectoryName = `.afternote-restore-${randomUUID()}`;
    const baselineName = `.afternote-restore-baseline-${randomUUID()}.db`;
    marker = {
      version: 1,
      phase: "prepared",
      coordinationDigest: options.coordinationDigest,
      ...restoreSourceIdentity(current),
      temporaryDirectoryName,
      baselineName,
      sealName: null,
      candidateDigest: null,
      finalDigest: null,
      authenticationTag: "0".repeat(64),
    };
    writeRestoreMarker(markerPath, marker, options.key);
    const temporaryDirectoryPath = join(parent, temporaryDirectoryName);
    mkdirSync(temporaryDirectoryPath, { mode: 0o700 });
    options.injectFault?.("during_candidate");
    rmSync(temporaryDirectoryPath, { recursive: true });
    SqliteMemory.restoreInterchange(
      current.sourcePath,
      databasePath,
      options.vault,
      options.applicationVersion,
      {
        encryptionKey: options.key,
        temporaryDirectoryPath,
        beforePublish: (temporaryDatabasePath) => {
          const finalSource = cleanVaultRestoreApprovalSnapshot(
            current.sourcePath,
            databasePath,
            options.applicationVersion,
          );
          if (!sameRestoreSourceIdentity(finalSource, current)) {
            throw new Error("Restore source changed during import");
          }
          verifyEncryptedRestore(
            temporaryDatabasePath,
            options.key,
            current.noteCount,
            current.revisionCount,
            current.payloadSha256,
            current.sourceApplicationVersion,
          );
          marker = {
            ...marker!,
            phase: "candidate_verified",
            candidateDigest: hashFile(temporaryDatabasePath),
          };
          const baselinePath = join(parent, marker.baselineName);
          copyFileSync(
            temporaryDatabasePath,
            baselinePath,
            constants.COPYFILE_EXCL,
          );
          chmodSync(baselinePath, 0o600);
          syncFile(baselinePath);
          if (hashFile(baselinePath) !== marker.candidateDigest) {
            throw new Error("Restore baseline did not match its verified candidate");
          }
          writeRestoreMarker(markerPath, marker, options.key);
          options.injectFault?.("after_candidate_verified");
        },
      },
    );
    if (!marker.candidateDigest || hashFile(databasePath) !== marker.candidateDigest) {
      throw new Error("Published restore did not match its verified candidate");
    }
    marker = { ...marker, phase: "published" };
    writeRestoreMarker(markerPath, marker, options.key);
    options.injectFault?.("after_publish");
    return {
      auditComplete: false,
      noteCount: marker.noteCount,
      revisionCount: marker.revisionCount,
    };
  } finally {
    lock?.release();
  }
}

export function sealAuditedCleanVaultRestore(
  databasePath: string,
  coordinationDigest: string,
  key: Uint8Array,
  lifecycleLock?: ExclusiveFileLock,
): void {
  const resolvedDatabase = resolve(databasePath);
  const parent = dirname(resolvedDatabase);
  const lock = lifecycleLock ? undefined : new ExclusiveFileLock(
    join(parent, `.${basename(resolvedDatabase)}.afternote.lock`),
    "Audited vault restore sealing requires exclusive ownership",
  );
  try {
    const markerPath = restoreMarkerPath(resolvedDatabase);
    let marker = readRestoreMarker(markerPath, resolvedDatabase, key);
    if (
      !marker ||
      marker.phase !== "published" ||
      marker.coordinationDigest !== coordinationDigest ||
      !marker.candidateDigest
    ) {
      throw new Error("Published restore marker is unavailable for audit sealing");
    }
    cleanupTrackedSeal(parent, marker);
    const sealName = `.afternote-restore-seal-${randomUUID()}.db`;
    marker = {
      ...marker,
      sealName,
    };
    writeRestoreMarker(markerPath, marker, key);
    const sealPath = join(parent, sealName);
    linkSync(resolvedDatabase, sealPath);
    syncDirectory(parent);
    verifyEncryptedRestore(
      sealPath,
      key,
      marker.noteCount,
      marker.revisionCount,
      marker.payloadSha256,
      marker.sourceApplicationVersion,
      true,
    );
    if (!sameFileIdentity(resolvedDatabase, sealPath)) {
      throw new Error("Audited restore destination changed during sealing");
    }
    cleanupTrackedTemporaryDirectory(parent, marker);
    writeRestoreMarker(markerPath, {
      ...marker,
      phase: "audited",
      finalDigest: hashFile(sealPath),
    }, key);
  } finally {
    lock?.release();
  }
}

export function finalizeCleanVaultRestore(
  databasePath: string,
  coordinationDigest: string,
  key: Uint8Array,
  injectFault?: (phase: CleanVaultRestoreFault) => void,
  lifecycleLock?: ExclusiveFileLock,
): void {
  const resolvedDatabase = resolve(databasePath);
  const parent = dirname(resolvedDatabase);
  const lock = lifecycleLock ? undefined : new ExclusiveFileLock(
    join(parent, `.${basename(resolvedDatabase)}.afternote.lock`),
    "Vault restore finalization requires exclusive ownership",
  );
  try {
    const markerPath = restoreMarkerPath(resolvedDatabase);
    let marker = readRestoreMarker(markerPath, resolvedDatabase, key);
    const baselinePath = marker ? join(parent, marker.baselineName) : "";
    const sealPath = marker?.sealName ? join(parent, marker.sealName) : "";
    if (
      !marker ||
      (marker.phase !== "audited" && marker.phase !== "finalizing") ||
      marker.coordinationDigest !== coordinationDigest ||
      !marker.candidateDigest ||
      !marker.finalDigest ||
      hashFile(resolvedDatabase) !== marker.finalDigest ||
      (marker.phase === "audited" &&
        (marker.sealName === null ||
          existingRegularFileDigest(sealPath) !== marker.finalDigest ||
          !sameFileIdentity(resolvedDatabase, sealPath))) ||
      (marker.phase === "finalizing" && existsSync(sealPath) &&
        (existingRegularFileDigest(sealPath) !== marker.finalDigest ||
          !sameFileIdentity(resolvedDatabase, sealPath)))
    ) {
      throw new Error("Restore completion marker is unavailable");
    }
    if (marker.phase === "audited") {
      if (existingRegularFileDigest(baselinePath) !== marker.candidateDigest) {
        throw new Error("Restore completion baseline is unavailable");
      }
      marker = { ...marker, phase: "finalizing" };
      writeRestoreMarker(markerPath, marker, key);
    }
    injectFault?.("during_finalization");
    if (existsSync(baselinePath)) {
      if (existingRegularFileDigest(baselinePath) !== marker.candidateDigest) {
        throw new Error("Restore completion baseline changed");
      }
      rmSync(baselinePath);
      syncDirectory(parent);
    }
    if (sealPath && existsSync(sealPath)) {
      if (
        existingRegularFileDigest(sealPath) !== marker.finalDigest ||
        !sameFileIdentity(resolvedDatabase, sealPath)
      ) {
        throw new Error("Restore completion seal changed");
      }
      rmSync(sealPath);
      syncDirectory(parent);
    }
    if (hashFile(resolvedDatabase) !== marker.finalDigest) {
      throw new Error("Restore completion destination changed");
    }
    rmSync(markerPath);
    syncDirectory(parent);
  } finally {
    lock?.release();
  }
}

function restoreMarkerPath(databasePath: string): string {
  return `${databasePath}.restore-recovery.json`;
}

function readRestoreMarker(
  markerPath: string,
  databasePath: string,
  key?: Uint8Array,
): RestoreMarker | null {
  if (!existsSync(markerPath)) return null;
  const descriptor = openSync(
    markerPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let serialized: string;
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size < 1 || before.size > 8_192) {
      throw new Error("Restore recovery marker is unsafe");
    }
    serialized = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const afterPath = lstatSync(markerPath);
    if (
      !afterPath.isFile() || afterPath.isSymbolicLink() ||
      before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || Buffer.byteLength(serialized) !== after.size ||
      after.dev !== afterPath.dev || after.ino !== afterPath.ino
    ) {
      throw new Error("Restore recovery marker changed while it was read");
    }
  } finally {
    closeSync(descriptor);
  }
  const parsed = JSON.parse(serialized) as Partial<RestoreMarker>;
  if (
    Object.keys(parsed).sort().join(",") !== [
      "authenticationTag",
      "baselineName",
      "candidateDigest",
      "coordinationDigest",
      "finalDigest",
      "noteCount",
      "payloadSha256",
      "phase",
      "revisionCount",
      "sealName",
      "sourceApplicationVersion",
      "sourceBytes",
      "sourceDigest",
      "temporaryDirectoryName",
      "version",
    ].sort().join(",") ||
    parsed.version !== 1 ||
    (parsed.phase !== "prepared" &&
      parsed.phase !== "candidate_verified" &&
      parsed.phase !== "published" &&
      parsed.phase !== "audited" &&
      parsed.phase !== "finalizing") ||
    typeof parsed.coordinationDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.coordinationDigest) ||
    typeof parsed.authenticationTag !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.authenticationTag) ||
    typeof parsed.sourceDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.sourceDigest) ||
    !Number.isSafeInteger(parsed.sourceBytes) || parsed.sourceBytes! < 1 ||
    !Number.isSafeInteger(parsed.noteCount) || parsed.noteCount! < 0 ||
    !Number.isSafeInteger(parsed.revisionCount) || parsed.revisionCount! < 0 ||
    typeof parsed.payloadSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.payloadSha256) ||
    typeof parsed.sourceApplicationVersion !== "string" ||
    parsed.sourceApplicationVersion.length < 1 ||
    parsed.sourceApplicationVersion.length > 120 ||
    typeof parsed.temporaryDirectoryName !== "string" ||
    !/^\.afternote-restore-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      parsed.temporaryDirectoryName,
    ) ||
    typeof parsed.baselineName !== "string" ||
    !/^\.afternote-restore-baseline-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/.test(
      parsed.baselineName,
    ) ||
    (parsed.sealName !== null &&
      (typeof parsed.sealName !== "string" ||
        !/^\.afternote-restore-seal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.db$/.test(
          parsed.sealName,
        ))) ||
    (parsed.candidateDigest !== null &&
      (typeof parsed.candidateDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(parsed.candidateDigest))) ||
    (parsed.finalDigest !== null &&
      (typeof parsed.finalDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(parsed.finalDigest))) ||
    (parsed.phase === "prepared" ? parsed.candidateDigest !== null : parsed.candidateDigest === null) ||
    (parsed.phase === "audited" || parsed.phase === "finalizing"
      ? parsed.finalDigest === null
      : parsed.finalDigest !== null) ||
    (parsed.phase === "audited" || parsed.phase === "finalizing"
      ? parsed.sealName === null
      : parsed.phase !== "published" && parsed.sealName !== null)
  ) {
    throw new Error("Restore recovery marker is invalid");
  }
  const marker = parsed as RestoreMarker;
  if (key) {
    const supplied = Buffer.from(marker.authenticationTag, "hex");
    const expected = Buffer.from(restoreMarkerAuthenticationTag(marker, key), "hex");
    if (!timingSafeEqual(supplied, expected)) {
      throw new Error("Restore recovery marker authentication failed");
    }
  }
  return marker;
}

function writeRestoreMarker(path: string, marker: RestoreMarker, key: Uint8Array): void {
  const authenticatedMarker = {
    ...marker,
    authenticationTag: restoreMarkerAuthenticationTag(marker, key),
  };
  const temporary = `${path}.tmp`;
  if (existsSync(temporary)) {
    const info = lstatSync(temporary);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Restore marker staging path is unsafe");
    }
    rmSync(temporary);
  }
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(authenticatedMarker)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function restoreMarkerAuthenticationTag(
  marker: RestoreMarker,
  key: Uint8Array,
): string {
  const markerKey = createHmac("sha256", key)
    .update("afternote:restore-marker:v1")
    .digest();
  try {
    return createHmac("sha256", markerKey).update(JSON.stringify({
      version: marker.version,
      phase: marker.phase,
      coordinationDigest: marker.coordinationDigest,
      sourceDigest: marker.sourceDigest,
      sourceBytes: marker.sourceBytes,
      noteCount: marker.noteCount,
      revisionCount: marker.revisionCount,
      payloadSha256: marker.payloadSha256,
      sourceApplicationVersion: marker.sourceApplicationVersion,
      temporaryDirectoryName: marker.temporaryDirectoryName,
      baselineName: marker.baselineName,
      sealName: marker.sealName,
      candidateDigest: marker.candidateDigest,
      finalDigest: marker.finalDigest,
    })).digest("hex");
  } finally {
    markerKey.fill(0);
  }
}

function cleanupTrackedTemporaryDirectory(parent: string, marker: RestoreMarker): void {
  const path = join(parent, marker.temporaryDirectoryName);
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Tracked restore workspace is unsafe");
  }
  rmSync(path, { recursive: true });
  syncDirectory(parent);
}

function cleanupPreparedBaseline(parent: string, marker: RestoreMarker): void {
  if (marker.phase !== "prepared") return;
  const path = join(parent, marker.baselineName);
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Prepared restore baseline is unsafe");
  }
  rmSync(path);
  syncDirectory(parent);
}

function cleanupTrackedSeal(parent: string, marker: RestoreMarker): void {
  if (!marker.sealName) return;
  const path = join(parent, marker.sealName);
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Tracked restore seal is unsafe");
  }
  rmSync(path);
  syncDirectory(parent);
}

function assertPublishedDestinationSafe(
  databasePath: string,
  key: Uint8Array,
  marker: RestoreMarker,
): void {
  const destinationDigest = existingRegularFileDigest(databasePath);
  if (destinationDigest === null || destinationDigest === marker.candidateDigest) return;
  verifyEncryptedRestore(
    databasePath,
    key,
    marker.noteCount,
    marker.revisionCount,
    marker.payloadSha256,
    marker.sourceApplicationVersion,
  );
}

function restorePublishedBaseline(
  parent: string,
  databasePath: string,
  marker: RestoreMarker,
): void {
  if (!marker.candidateDigest) {
    throw new Error("Restore recovery baseline is not verified");
  }
  const baselinePath = join(parent, marker.baselineName);
  if (existingRegularFileDigest(baselinePath) !== marker.candidateDigest) {
    throw new Error("Restore recovery baseline changed");
  }
  if (existsSync(databasePath)) {
    const destinationInfo = lstatSync(databasePath);
    if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) {
      throw new Error("Restore recovery destination is unsafe");
    }
  }
  const stagingPath = `${databasePath}.restore-recovery-stage`;
  if (existsSync(stagingPath)) {
    const stagingInfo = lstatSync(stagingPath);
    if (!stagingInfo.isFile() || stagingInfo.isSymbolicLink()) {
      throw new Error("Restore recovery staging path is unsafe");
    }
    rmSync(stagingPath);
  }
  copyFileSync(baselinePath, stagingPath, constants.COPYFILE_EXCL);
  chmodSync(stagingPath, 0o600);
  syncFile(stagingPath);
  if (hashFile(stagingPath) !== marker.candidateDigest) {
    rmSync(stagingPath, { force: true });
    throw new Error("Restore recovery staging copy changed");
  }
  removeRestoreDatabaseSidecars(databasePath);
  renameSync(stagingPath, databasePath);
  syncDirectory(parent);
}

function removeRestoreDatabaseSidecars(databasePath: string): void {
  const paths = [`${databasePath}-wal`, `${databasePath}-shm`].filter(existsSync);
  for (const path of paths) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Restore recovery database sidecar is unsafe");
    }
  }
  for (const path of paths) {
    rmSync(path);
  }
}

function verifyEncryptedRestore(
  path: string,
  key: Uint8Array,
  expectedNotes: number,
  expectedRevisions: number,
  expectedPayloadSha256: string,
  sourceApplicationVersion: string,
  requireRestoreAudit = false,
): void {
  const database = new SqlcipherDatabase(path, { key, readonly: true });
  try {
    const integrity = database.query<{ quick_check: string }, []>("pragma quick_check").get()
      ?.quick_check;
    const notes = database.query<{ count: number }, []>(
      "select count(*) as count from notes",
    ).get()?.count;
    const revisions = database.query<{ count: number }, []>(
      "select count(*) as count from note_revisions",
    ).get()?.count;
    const restoreAudit = requireRestoreAudit
      ? database.query<{ count: number }, []>(`
          select count(*) as count from broker_audit_events
          where client_id = 'owner'
            and operation = 'recovery.restore'
            and outcome = 'success'
            and error_code is null
            and note_refs = '[]'
        `).get()?.count
      : 1;
    if (
      integrity !== "ok" ||
      notes !== expectedNotes ||
      revisions !== expectedRevisions ||
      restoreAudit !== 1 ||
      !restoredVaultPayloadDigests(database, sourceApplicationVersion).includes(expectedPayloadSha256)
    ) {
      throw new Error("Restored vault failed recovery verification");
    }
  } finally {
    database.close();
  }
}

function existingRegularFileDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Restore destination must be a regular file");
  }
  return hashFile(path);
}

function restoreSourceIdentity(
  value: RestoreSourceIdentity,
): RestoreSourceIdentity {
  return {
    sourceDigest: value.sourceDigest,
    sourceBytes: value.sourceBytes,
    noteCount: value.noteCount,
    revisionCount: value.revisionCount,
    payloadSha256: value.payloadSha256,
    sourceApplicationVersion: value.sourceApplicationVersion,
  };
}

function sameRestoreSourceIdentity(
  left: RestoreSourceIdentity,
  right: RestoreSourceIdentity,
): boolean {
  return left.sourceDigest === right.sourceDigest &&
    left.sourceBytes === right.sourceBytes &&
    left.noteCount === right.noteCount &&
    left.revisionCount === right.revisionCount &&
    left.payloadSha256 === right.payloadSha256 &&
    left.sourceApplicationVersion === right.sourceApplicationVersion;
}

function samePathIdentity(left: string, right: string): boolean {
  if (existsSync(right)) return realpathSync.native(right) === left;
  return resolve(right) === left;
}

function sameFileIdentity(left: string, right: string): boolean {
  const leftInfo = lstatSync(left);
  const rightInfo = lstatSync(right);
  return leftInfo.isFile() && !leftInfo.isSymbolicLink() &&
    rightInfo.isFile() && !rightInfo.isSymbolicLink() &&
    leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
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
