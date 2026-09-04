import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  LOCAL_EMBEDDING_MODEL,
  TransformersTextEmbeddingModel,
} from "./transformers-embedding";

const MODEL_FILES = {
  "config.json": {
    sha256: "4599e8a5d74ed192b70919aa02124c2d68580070b22e89db956c0353618bccd9",
    bytes: 611,
  },
  "tokenizer.json": {
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    bytes: 711_661,
  },
  "tokenizer_config.json": {
    sha256: "7580f5760152bd83122877e4c21d62b3d342cc2ab7232a1dbd0180d3b022798f",
    bytes: 1_463,
  },
  "onnx/model_quantized.onnx": {
    sha256: "0225a6e9c7b82e999fbf108daa02b825ac4b35173eb1d1073d8b3a0d4aa80251",
    bytes: 22_843_695,
  },
} as const;

type ModelFilePath = keyof typeof MODEL_FILES;
type ModelFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type LocalEmbeddingStatus = {
  state: "not-installed" | "ready" | "invalid";
  modelId: typeof LOCAL_EMBEDDING_MODEL.id;
  revision: typeof LOCAL_EMBEDDING_MODEL.revision;
  dtype: typeof LOCAL_EMBEDDING_MODEL.dtype;
  dimensions: typeof LOCAL_EMBEDDING_MODEL.dimensions;
  bytes: number;
  reason: string | null;
};

export type LocalEmbeddingDiscovery = {
  status: LocalEmbeddingStatus;
  model: TransformersTextEmbeddingModel | null;
};

export function localEmbeddingStatus(vaultPath: string): LocalEmbeddingStatus {
  const snapshot = modelSnapshotPath(vaultPath);
  let bytes = 0;
  let found = 0;
  for (const [relativePath, expected] of Object.entries(MODEL_FILES)) {
    const path = join(snapshot, relativePath);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return modelStatus("invalid", bytes, "model files could not be inspected");
    }
    found += 1;
    if (!info.isFile() || info.isSymbolicLink()) {
      return modelStatus("invalid", bytes, `model file is not regular: ${relativePath}`);
    }
    bytes += info.size;
    if (info.size !== expected.bytes || sha256(path) !== expected.sha256) {
      return modelStatus("invalid", bytes, `model checksum failed: ${relativePath}`);
    }
  }
  if (found === 0) return modelStatus("not-installed", 0, null);
  if (found !== Object.keys(MODEL_FILES).length) {
    return modelStatus("invalid", bytes, "model installation is incomplete");
  }
  return modelStatus("ready", bytes, null);
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
          localModelPath: modelSnapshotPath(vaultPath),
          allowRemoteModels: false,
        })
      : null,
  };
}

export async function acquireLocalEmbeddingModel(
  vaultPath: string,
  options?: { fetch?: ModelFetch },
): Promise<LocalEmbeddingStatus> {
  const existing = localEmbeddingStatus(vaultPath);
  if (existing.state === "ready") return existing;
  const cacheDirectory = modelCacheDirectory(vaultPath);
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const snapshot = modelSnapshotPath(vaultPath);
  const snapshotParent = dirname(snapshot);
  mkdirSync(snapshotParent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(snapshotParent, ".install-"));
  try {
    for (const relativePath of Object.keys(MODEL_FILES) as ModelFilePath[]) {
      await downloadVerifiedModelFile(
        staging,
        relativePath,
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
  const status = localEmbeddingStatus(vaultPath);
  if (status.state !== "ready") {
    throw new Error(status.reason ?? "Local embedding model installation failed verification");
  }
  return status;
}

async function downloadVerifiedModelFile(
  stagingDirectory: string,
  relativePath: ModelFilePath,
  fetchImpl: ModelFetch,
): Promise<void> {
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://huggingface.co/${LOCAL_EMBEDDING_MODEL.id}/resolve/${LOCAL_EMBEDDING_MODEL.revision}/${encodedPath}`;
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Local model download failed for ${relativePath}: HTTP ${response.status}`);
  }
  const expected = MODEL_FILES[relativePath];
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

function modelSnapshotPath(vaultPath: string): string {
  return join(
    modelCacheDirectory(vaultPath),
    LOCAL_EMBEDDING_MODEL.id,
    LOCAL_EMBEDDING_MODEL.revision,
  );
}

function modelStatus(
  state: LocalEmbeddingStatus["state"],
  bytes: number,
  reason: string | null,
): LocalEmbeddingStatus {
  return {
    state,
    modelId: LOCAL_EMBEDDING_MODEL.id,
    revision: LOCAL_EMBEDDING_MODEL.revision,
    dtype: LOCAL_EMBEDDING_MODEL.dtype,
    dimensions: LOCAL_EMBEDDING_MODEL.dimensions,
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
