import {randomBytes, randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {VaultBrokerWorker} from "./vault-broker-worker";
import {LIBRARY_SCOPES} from "./vault-broker-library";
import { discoverLocalEmbeddingModel } from "./local-embedding";

const directory = process.env.AFTERNOTE_TEST_MODEL_DIRECTORY;
const vaultPath = process.env.AFTERNOTE_TEST_VAULT_PATH;
if (!directory || !vaultPath) throw new Error("Isolated model and vault paths are required");
// Use the included public model directory directly: no cache and no download.
const {model, status} = discoverLocalEmbeddingModel(vaultPath, {bundledModelPath: directory});
if (!model?.reranker) throw new Error("Included search engine is unavailable");
const query = "How can furniture reach the upper floor?";
const broker = new VaultBrokerWorker({ applicationVersion: "compiled-semantic-fixture",
  vaultPath, vaultKey: randomBytes(32), vault: {vaultId: "9".repeat(64), deployment: "local"},
  embeddingModelProvider: () => model,
});
const connection = {connectionId: randomUUID(), peerPid: 51900};
async function request(method: string, params: Record<string, unknown>) {
  let result = JSON.parse(await broker.handleSerialized(JSON.stringify({kind: "client", peerRole: "owner-control", ...connection,
    payload: {protocolVersion: 1, requestId: randomUUID(), method, params}})));
  if (result.ownerPresenceChallenge) result = JSON.parse(await broker.handleSerialized(JSON.stringify({kind: "owner-presence",
    peerRole: "owner-control", ...connection, payload: {challengeId: result.ownerPresenceChallenge.challengeId, approved: true, outcome: "approved"}})));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
}
let brokerRecall = false;
let indexingCompleted = false;
const started = performance.now();
try {
  await request("library.session.begin", {requestedScopes: [...LIBRARY_SCOPES], ttlMs: 900000});
  const note = (await request("library.remember", {content: "Reserve the freight elevator before moving furniture to the upstairs apartment.", source: null})).note;
  const result = await request("library.search", {cursor: null, limit: 5, query});
  if (result.searchMode !== "hybrid" || result.results[0]?.citation.noteId !== note.id) throw new Error("Immediate paraphrase recall failed");
  if (readFileSync(vaultPath).includes(Buffer.from("freight elevator"))) throw new Error("Note stored in plaintext");
  brokerRecall = true;
  for (let i = 1; i < 15; i++) await request("library.remember", {
    content: `Synthetic acceptance note ${i}: the garden plan includes herbs and rain barrels.`, source: null,
  });
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const progress = await request("library.refresh_search", {reloadModel: false});
    if (progress.searchMode === "hybrid" && progress.indexedNotes === 15 && progress.totalNotes === 15) {
      indexingCompleted = true;
      break;
    }
    await Bun.sleep(25);
  }
  if (!indexingCompleted) throw new Error("Fifteen-note index never reported ready through status polling");
} finally {broker.close();}
const elapsedMs = performance.now() - started;
const vector = await model.embedQuery(query);
const scores = await model.reranker.score(query, [
  "Reserve the freight elevator before moving furniture.",
  "The upholstery is blue and the street trees are in bloom.",
]);
console.log(JSON.stringify({ brokerRecall, indexingCompleted, elapsedMs, state: status.state, dimensions: vector.length, scores, minimumScore: model.reranker.minimumScore }));
