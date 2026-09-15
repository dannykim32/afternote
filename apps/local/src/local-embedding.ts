import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { totalmem } from "node:os";
import { SEMANTIC_MODELS, semanticProfile, modelDownloadBytes, type SemanticProfileId, type SemanticModelProfile } from "./semantic-model-catalog";
import {
  TransformersTextEmbeddingModel,
} from "./transformers-embedding";

type ModelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LocalEmbeddingStatus = {
  state: "not-installed" | "ready" | "invalid";
  profile: SemanticProfileId;
  modelId: string;
  revision: string;
  dtype: string;
  dimensions: number;
  bytes: number;
  reason: string | null;
};

export type LocalEmbeddingDiscovery = {
  status: LocalEmbeddingStatus;
  model: TransformersTextEmbeddingModel | null;
};

export function selectedSemanticProfile(vaultPath: string): SemanticProfileId {
  const path = join(modelCacheDirectory(vaultPath), "selection.json");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Semantic model selection could not be read");
    // Respect previous explicit Light installation; otherwise recommend Balanced.
    return existsSync(modelSnapshotPath(vaultPath, SEMANTIC_MODELS.light)) ? "light" : "balanced";
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 256) throw new Error("Semantic model selection is invalid");
    const bytes = readFileSync(fd);
    if (bytes.length > 256) throw new Error("Semantic model selection is invalid");
    const data = JSON.parse(bytes.toString("utf8"));
    if (Object.keys(data).length !== 2 || data.version !== 1) throw new Error("Semantic model selection is invalid");
    return semanticProfile(data.profile).key;
  } finally { closeSync(fd); }
}

function selectModel(vaultPath: string, profile: SemanticProfileId): void {
  const directory = modelCacheDirectory(vaultPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staging = join(directory, `.selection-${randomUUID()}`);
  try {
    writeFileSync(staging, JSON.stringify({ version: 1, profile }), { flag: "wx", mode: 0o600 });
    renameSync(staging, join(directory, "selection.json"));
  } finally { rmSync(staging, { force: true }); }
}

export function semanticModelCatalog(vaultPath: string) {
  return {
    selected: selectedSemanticProfile(vaultPath),
    recommended: totalmem() >= 8 * 1024 ** 3 ? "balanced" : "light",
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
    models: Object.values(SEMANTIC_MODELS).map((profile) => ({
      key: profile.key, name: profile.name, modelId: `${profile.id}:${profile.dtype}`, downloadBytes: modelDownloadBytes(profile),
      state: localEmbeddingStatus(vaultPath, profile.key).state,
    })),
  };
}

export function localEmbeddingStatus(vaultPath: string, selected?: SemanticProfileId): LocalEmbeddingStatus {
  const profile = semanticProfile(selected ?? selectedSemanticProfile(vaultPath));
  const snapshot = modelSnapshotPath(vaultPath, profile);
  let bytes = 0;
  let found = 0;
  for (const [relativePath, expected] of Object.entries(profile.files)) {
    const path = join(snapshot, relativePath);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return modelStatus(profile, "invalid", bytes, "model files could not be inspected");
    }
    found += 1;
    if (!info.isFile() || info.isSymbolicLink()) {
      return modelStatus(profile, "invalid", bytes, `model file is not regular: ${relativePath}`);
    }
    bytes += info.size;
    if (info.size !== expected.bytes || sha256(path) !== expected.sha256) {
      return modelStatus(profile, "invalid", bytes, `model checksum failed: ${relativePath}`);
    }
  }
  if (found === 0) return modelStatus(profile, "not-installed", 0, null);
  if (found !== Object.keys(profile.files).length) {
    return modelStatus(profile, "invalid", bytes, "model installation is incomplete");
  }
  return modelStatus(profile, "ready", bytes, null);
}

export function openLocalEmbeddingModel(
  vaultPath: string,
): TransformersTextEmbeddingModel | null {
  return discoverLocalEmbeddingModel(vaultPath).model;
}

export function discoverLocalEmbeddingModel(
  vaultPath: string,
): LocalEmbeddingDiscovery {
  const status = localEmbeddingStatus(vaultPath);
  return {
    status,
    model: status.state === "ready"
      ? new TransformersTextEmbeddingModel({
          cacheDirectory: modelCacheDirectory(vaultPath),
          localModelPath: modelSnapshotPath(vaultPath, semanticProfile(status.profile)),
          profile: semanticProfile(status.profile),
          allowRemoteModels: false,
        })
      : null,
  };
}

export async function acquireLocalEmbeddingModel(
  vaultPath: string,
  options?: { fetch?: ModelFetch; profile?: SemanticProfileId },
): Promise<LocalEmbeddingStatus> {
  const profile = semanticProfile(options?.profile ?? selectedSemanticProfile(vaultPath));
  const existing = localEmbeddingStatus(vaultPath, profile.key);
  if (existing.state === "ready") {
    selectModel(vaultPath, profile.key);
    return existing;
  }
  const cacheDirectory = modelCacheDirectory(vaultPath);
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const snapshot = modelSnapshotPath(vaultPath, profile);
  const snapshotParent = dirname(snapshot);
  mkdirSync(snapshotParent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(snapshotParent, ".install-"));
  try {
    for (const relativePath of Object.keys(profile.files)) {
      await downloadVerifiedModelFile(
        staging,
        relativePath,
        profile,
        options?.fetch ?? globalThis.fetch,
      );
    }
    if (existsSync(snapshot)) {
      rmSync(snapshot, { recursive: true, force: true });
    }
    renameSync(staging, snapshot);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  const model = new TransformersTextEmbeddingModel({
    cacheDirectory,
    localModelPath: snapshot,
    profile,
    allowRemoteModels: false,
  });
  try {
    await model.embed(["Afternote local semantic search installation check."]);
  } catch (error) {
    rmSync(snapshot, { recursive: true, force: true });
    throw new Error("Local embedding model failed its runtime check", {
      cause: error,
    });
  }
  const status = localEmbeddingStatus(vaultPath, profile.key);
  if (status.state !== "ready") {
    throw new Error(status.reason ?? "Local embedding model installation failed verification");
  }
  selectModel(vaultPath, profile.key);
  return status;
}

async function downloadVerifiedModelFile(
  stagingDirectory: string,
  relativePath: string,
  profile: SemanticModelProfile,
  fetchImpl: ModelFetch,
): Promise<void> {
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://huggingface.co/${profile.id}/resolve/${profile.revision}/${encodedPath}`;
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Local model download failed for ${relativePath}: HTTP ${response.status}`);
  }
  const expected = profile.files[relativePath]!;
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null &&
    (!/^\d+$/.test(advertisedLength) || Number(advertisedLength) !== expected.bytes)) {
    throw new Error(`Local model download has an unexpected size: ${relativePath}`);
  }
  if (!response.body) throw new Error(`Local model download has no body: ${relativePath}`);
  const destination = join(stagingDirectory, relativePath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const descriptor = openSync(destination, "wx", 0o600);
  const digest = createHash("sha256");
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > expected.bytes) {
        await reader.cancel("download exceeds pinned size");
        throw new Error(`Local model download exceeds its pinned size: ${relativePath}`);
      }
      digest.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        offset += writeSync(descriptor, value, offset, value.byteLength - offset);
      }
    }
  } catch (error) {
    closeSync(descriptor);
    rmSync(destination, { force: true });
    throw error;
  }
  closeSync(descriptor);
  if (received !== expected.bytes || digest.digest("hex") !== expected.sha256) {
    rmSync(destination, { force: true });
    throw new Error(`Local model download failed verification: ${relativePath}`);
  }
}

function modelCacheDirectory(vaultPath: string): string {
  return join(dirname(vaultPath), "models");
}

function modelSnapshotPath(vaultPath: string, profile: SemanticModelProfile): string {
  return join(
    modelCacheDirectory(vaultPath),
    profile.id,
    profile.revision,
  );
}

function modelStatus(
  profile: SemanticModelProfile,
  state: LocalEmbeddingStatus["state"],
  bytes: number,
  reason: string | null,
): LocalEmbeddingStatus {
  return {
    state,
    profile: profile.key,
    modelId: profile.id,
    revision: profile.revision,
    dtype: profile.dtype,
    dimensions: profile.dimensions,
    bytes,
    reason,
  };
}

function sha256(path: string): string {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}
