import { cosineSimilarity } from "./retrieval";
import { TransformersTextEmbeddingModel } from "./transformers-embedding";

const cacheDirectory = process.env.AFTERNOTE_EMBEDDING_CACHE;
if (!cacheDirectory) throw new Error("AFTERNOTE_EMBEDDING_CACHE is required");

const model = new TransformersTextEmbeddingModel({
  cacheDirectory,
  allowRemoteModels: process.env.AFTERNOTE_ALLOW_REMOTE_MODELS === "1",
});
const vectors = await model.embed([
  "Where is my package?",
  "How can I check my order status?",
  "Bananas are yellow.",
]);
console.log(JSON.stringify({
  dimensions: vectors.map((vector) => vector.length),
  related: cosineSimilarity(vectors[0]!, vectors[1]!),
  unrelated: cosineSimilarity(vectors[0]!, vectors[2]!),
}));
