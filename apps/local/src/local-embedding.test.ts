import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  acquireLocalEmbeddingModel,
  localEmbeddingStatus,
  selectedSemanticProfile, semanticModelCatalog,
} from "./local-embedding";
import { TransformersTextReranker } from "./transformers-reranker";
import { SEMANTIC_MODELS, LOCAL_RERANKER } from "./semantic-model-catalog";
import { createHash } from "node:crypto";
import { LOCAL_EMBEDDING_MODEL, TransformersTextEmbeddingModel } from "./transformers-embedding";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local embedding installation", () => {
  it("recommends a local profile without downloading and preserves an earlier explicit choice", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-catalog-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    const catalog = semanticModelCatalog(vaultPath);
    expect(catalog.selected).toBe("balanced");
    expect(catalog.models.map((model) => model.key)).toEqual(["light", "balanced", "large"]);
    expect(catalog.models.every((model) => model.state === "not-installed")).toBe(true);
    expect(existsSync(join(directory, "models"))).toBe(false);
    mkdirSync(join(directory, "models"));
    writeFileSync(join(directory, "models/selection.json"), JSON.stringify({version: 1, profile: "large"}));
    expect(selectedSemanticProfile(vaultPath)).toBe("large");
  });

  it("rejects unknown, oversized and symlinked selections before loading or fetching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-selection-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    mkdirSync(join(directory, "models"));
    const selection = join(directory, "models/selection.json");
    for (const contents of ['{"version":1,"profile":"remote"}', ' '.repeat(257), 'null']) {
      writeFileSync(selection, contents);
      expect(() => selectedSemanticProfile(vaultPath)).toThrow();
    }
    rmSync(selection);
    writeFileSync(join(directory, "outside"), '{"version":1,"profile":"light"}');
    symlinkSync(join(directory, "outside"), selection);
    expect(() => selectedSemanticProfile(vaultPath)).toThrow("could not be read");
    let requests = 0;
    await expect(acquireLocalEmbeddingModel(vaultPath, {
      profile: "remote" as "light", fetch: async () => { requests++; return new Response(""); },
    })).rejects.toThrow("must be light, balanced, or large");
    expect(requests).toBe(0);
  });

  it("keeps the selected model after a failed switch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-failure-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    mkdirSync(join(directory, "models"));
    writeFileSync(join(directory, "models/selection.json"), '{"version":1,"profile":"light"}');
    await expect(acquireLocalEmbeddingModel(vaultPath, { profile: "large", fetch: async () => new Response("bad") })).rejects.toThrow();
    expect(selectedSemanticProfile(vaultPath)).toBe("light");
  });

  it("runtime-checks a cached model before committing selection, without redownloading", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-cached-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    const profile = SEMANTIC_MODELS.large;
    const originalFiles = profile.files;
    const content = "pinned local test model";
    // A tiny, genuinely digest-checked fixture exercises the installer workflow;
    // runtime inference is the failure seam, and no remote files are needed.
    profile.files = { "config.json": { bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") } };
    const runtime = spyOn(TransformersTextEmbeddingModel.prototype, "embed").mockRejectedValue(new Error("runtime unavailable"));
    try {
      const snapshot = join(directory, "models", profile.id, profile.revision);
      mkdirSync(snapshot, {recursive: true});
      writeFileSync(join(snapshot, "config.json"), content);
      writeFileSync(join(directory, "models/selection.json"), '{"version":1,"profile":"light"}');
      expect(localEmbeddingStatus(vaultPath, "large").state).toBe("ready");
      let requests = 0;
      const options = { profile: "large" as const, fetch: async () => { requests++; return new Response(""); } };
      await expect(acquireLocalEmbeddingModel(vaultPath, options)).rejects.toThrow("failed its runtime check");
      expect(selectedSemanticProfile(vaultPath)).toBe("light");
      expect(requests).toBe(0);
      runtime.mockResolvedValue([new Float32Array(profile.dimensions)]);
      await acquireLocalEmbeddingModel(vaultPath, options);
      expect(selectedSemanticProfile(vaultPath)).toBe("large");
      expect(requests).toBe(0);
      expect(runtime).toHaveBeenCalledTimes(2);
    } finally { profile.files = originalFiles; runtime.mockRestore(); }
  });

  it("distinguishes an absent model from a partial or tampered installation", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-status-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    expect(localEmbeddingStatus(vaultPath)).toMatchObject({
      state: "not-installed",
      bytes: 0,
      reason: null,
    });

    const snapshot = join(
      directory,
      "models",
      LOCAL_EMBEDDING_MODEL.id,
      LOCAL_EMBEDDING_MODEL.revision,
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "config.json"), "tampered");
    expect(localEmbeddingStatus(vaultPath)).toMatchObject({
      state: "invalid",
      reason: "model checksum failed: config.json",
    });
  });

  it("rejects unverified downloads before publishing or loading a model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-download-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    let requests = 0;

    await expect(
      acquireLocalEmbeddingModel(vaultPath, {
        fetch: (async () => {
          requests += 1;
          return new Response("tampered", { status: 200 });
        }),
      }),
    ).rejects.toThrow("failed verification: reranker/config.json");

    expect(requests).toBe(1);
    expect(localEmbeddingStatus(vaultPath).state).toBe("not-installed");
  });
});


it("pins bundled relevance downloads and commits selection only after the relevance runtime works", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-relevance-install-"));
  directories.push(directory);
  const vaultPath = join(directory, "vault.db");
  mkdirSync(join(directory, "models"));
  writeFileSync(join(directory, "models/selection.json"), '{"version":1,"profile":"light"}');
  const profile = SEMANTIC_MODELS.balanced, originalFiles = profile.files;
  const content = "pinned relevance fixture";
  profile.files = {"reranker/config.json": {bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"),
    source: {id: LOCAL_RERANKER.id, revision: LOCAL_RERANKER.revision, path: "config.json"}}};
  const embed = spyOn(TransformersTextEmbeddingModel.prototype, "embed").mockResolvedValue([new Float32Array(768)]);
  const score = spyOn(TransformersTextReranker.prototype, "score").mockRejectedValue(new Error("broken scorer"));
  const urls: string[] = [];
  const options = {profile: "balanced" as const, fetch: async (url: string | URL | Request) => {urls.push(String(url)); return new Response(content);} };
  try {
    await expect(acquireLocalEmbeddingModel(vaultPath, options)).rejects.toThrow("failed its runtime check");
    expect(selectedSemanticProfile(vaultPath)).toBe("light");
    expect(urls).toEqual([`https://huggingface.co/${LOCAL_RERANKER.id}/resolve/${LOCAL_RERANKER.revision}/config.json`]);
    score.mockResolvedValue([4]);
    await acquireLocalEmbeddingModel(vaultPath, options);
    expect(selectedSemanticProfile(vaultPath)).toBe("balanced");
    expect(urls).toHaveLength(1);
  } finally { profile.files = originalFiles; embed.mockRestore(); score.mockRestore(); }
});
