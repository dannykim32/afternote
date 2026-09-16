import { chmodSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { downloadVerifiedModelFile, verifyModelSnapshot } from "../apps/local/src/local-embedding";
import { SEMANTIC_MODELS, LOCAL_RERANKER } from "../apps/local/src/semantic-model-catalog";

export const BUNDLED_SEMANTIC_PROFILE = SEMANTIC_MODELS.balanced;

/** Public, immutable model data. Every byte is checked against the source allowlist. */
export async function prepareSemanticRelease(repositoryRoot: string): Promise<void> {
  const destination = join(repositoryRoot, "build/semantic-model");
  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), ".semantic-"));
  try {
    for (const path of Object.keys(BUNDLED_SEMANTIC_PROFILE.files)) {
      await downloadVerifiedModelFile(staging, path, BUNDLED_SEMANTIC_PROFILE, globalThis.fetch);
    }
    if (verifyModelSnapshot(staging, BUNDLED_SEMANTIC_PROFILE).state !== "ready")
      throw new Error("Bundled search models failed verification");
    rmSync(destination, { recursive: true, force: true });
    renameSync(staging, destination);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function bundleSemanticModels(repositoryRoot: string, portableDirectory: string): void {
  const source = join(repositoryRoot, "build/semantic-model");
  if (verifyModelSnapshot(source, BUNDLED_SEMANTIC_PROFILE).state !== "ready")
    throw new Error("Run prepare:semantic-release before packaging the included search models");
  const destination = join(portableDirectory, "semantic-model");
  mkdirSync(destination, { recursive: false });
  // Copy only the pinned allowlist, never an arbitrary cache directory.
  for (const path of Object.keys(BUNDLED_SEMANTIC_PROFILE.files)) {
    mkdirSync(dirname(join(destination, path)), { recursive: true });
    cpSync(join(source, path), join(destination, path), { dereference: false });
    // Download staging is private; the distributed app must work for every Mac user.
    chmodSync(join(destination, path), 0o644);
  }
  if (verifyModelSnapshot(destination, BUNDLED_SEMANTIC_PROFILE).state !== "ready")
    throw new Error("Packaged search models failed verification");
  cpSync(join(repositoryRoot, "apps/local/packaging/MODEL_TERMS.md"), join(destination, "MODEL_TERMS.md"));
  cpSync(join(repositoryRoot, "apps/local/packaging/GEMMA_NOTICE.txt"), join(destination, "Notice"));
  writeFileSync(join(destination, "manifest.json"), JSON.stringify({
    format: "afternote-bundled-search-models", version: 1,
    embedding: { id: BUNDLED_SEMANTIC_PROFILE.id, revision: BUNDLED_SEMANTIC_PROFILE.revision, dtype: BUNDLED_SEMANTIC_PROFILE.dtype },
    reranker: { id: LOCAL_RERANKER.id, revision: LOCAL_RERANKER.revision },
    files: BUNDLED_SEMANTIC_PROFILE.files,
  }, null, 2) + "\n");
}

if (import.meta.main) await prepareSemanticRelease(resolve(import.meta.dir, ".."));
