import { join } from "node:path";
import { acquireLocalEmbeddingModel, discoverLocalEmbeddingModel } from "./local-embedding";
import { SEMANTIC_MODELS } from "./semantic-model-catalog";

const directory = process.env.AFTERNOTE_TEST_MODEL_DIRECTORY;
const vaultPath = process.env.AFTERNOTE_TEST_VAULT_PATH;
if (!directory || !vaultPath) throw new Error("Isolated model and vault paths are required");
const profile = SEMANTIC_MODELS.balanced;
const allowed = new Map(Object.entries(profile.files).map(([path, file]) => {
  const source = file.source ?? { id: profile.id, revision: profile.revision, path };
  return [`https://huggingface.co/${source.id}/resolve/${source.revision}/${source.path}`, path];
}));
// Replay the pinned acquisition protocol entirely from public local artifacts.
// Unexpected URLs fail, so this packaging check cannot fall back to a network download.
const status = await acquireLocalEmbeddingModel(vaultPath, { profile: "balanced", fetch: async url => {
  const path = allowed.get(String(url));
  if (!path) throw new Error("Unexpected model URL");
  return new Response(Bun.file(join(directory, path)));
} });
const { model } = discoverLocalEmbeddingModel(vaultPath);
if (!model?.reranker) throw new Error("Search engine was not installed");
const query = "How can furniture reach the upper floor?";
const vector = await model.embedQuery(query);
const scores = await model.reranker.score(query, [
  "Reserve the freight elevator before moving furniture.",
  "The upholstery is blue and the street trees are in bloom.",
]);
console.log(JSON.stringify({ state: status.state, dimensions: vector.length, scores, minimumScore: model.reranker.minimumScore }));
