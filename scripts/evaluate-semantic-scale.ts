/** Offline 10,000-note quality/latency evaluation, optionally replaying synthetic document vectors. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { TransformersTextEmbeddingModel } from "../apps/local/src/transformers-embedding";
import { SEMANTIC_MODELS } from "../apps/local/src/semantic-model-catalog";
import { runRecallEvaluation } from "../apps/local/src/recall-eval";
import type { TextEmbeddingModel } from "../apps/local/src/retrieval";
import { verifySearchArtifacts } from "./evaluate-semantic-retrieval";

const [directory, output, cachePath] = process.argv.slice(2);
if (!directory || !output) throw new Error("Usage: bun scripts/evaluate-semantic-scale.ts MODEL_DIRECTORY REPORT_PATH [SYNTHETIC_VECTOR_CACHE]");
verifySearchArtifacts(resolve(directory));
const raw = new TransformersTextEmbeddingModel({
  profile: SEMANTIC_MODELS.balanced, cacheDirectory: resolve(directory),
  localModelPath: resolve(directory), allowRemoteModels: false,
});
const cache = cachePath ? await Bun.file(cachePath).json() as {descriptor: TextEmbeddingModel["descriptor"]; entries: Record<string, string>} : null;
if (cache && JSON.stringify(cache.descriptor) !== JSON.stringify(raw.descriptor)) throw new Error("Cached embedding contract mismatch");
await raw.embedQuery("Synthetic warmup.");
await raw.reranker!.score("search test", ["Synthetic search test."]);
let cachedSlices = 0;
const model: TextEmbeddingModel = {
  descriptor: raw.descriptor, minimumSimilarity: raw.minimumSimilarity, uiMinimumSimilarity: raw.uiMinimumSimilarity,
  reranker: raw.reranker, embedQuery: raw.embedQuery.bind(raw),
  embed: cache ? async texts => texts.map(text => {
    const encoded = cache.entries[createHash("sha256").update(text).digest("hex")];
    if (!encoded) throw new Error("Missing cached synthetic vector");
    cachedSlices++;
    return new Float32Array(Uint8Array.from(Buffer.from(encoded, "base64")).buffer);
  }) : raw.embed.bind(raw),
};
const report = await runRecallEvaluation("2.0.0-model-validation", {embeddingModel: model, targetNoteCount: 10_000});
await Bun.write(output, JSON.stringify({ ...report,
  embedding: raw.descriptor, reranker: {id: raw.reranker!.id, minimumScore: raw.reranker!.minimumScore}, cachedSlices,
  measurementScope: cache
    ? "Document embeddings replayed from the same pinned pipeline, text-SHA256 keyed. Real query embeddings, relevance inference and production SQLite retrieval. Not an indexing or memory benchmark."
    : "Fresh synthetic document indexing, real query embeddings, relevance inference and production SQLite retrieval.",
}, null, 2));
console.log(JSON.stringify({quality: report.quality, semanticQuality: report.semanticQuality, latency: report.latency, passed: report.passed}));
