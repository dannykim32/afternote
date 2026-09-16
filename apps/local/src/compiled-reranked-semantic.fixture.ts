import {createHash, generateKeyPairSync, randomBytes, randomUUID, sign} from "node:crypto";
import {canonicalBrokerTranscript} from "./vault-broker";
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
async function wire(peerRole: "owner-control" | "memory-client", peer: {connectionId: string; peerPid: number}, method: string, params: Record<string, unknown>) {
  let result = JSON.parse(await broker.handleSerialized(JSON.stringify({kind: "client", peerRole, ...peer,
    payload: {protocolVersion: 1, requestId: randomUUID(), method, params}})));
  if (result.ownerPresenceChallenge) result = JSON.parse(await broker.handleSerialized(JSON.stringify({kind: "owner-presence",
    peerRole, ...peer, payload: {challengeId: result.ownerPresenceChallenge.challengeId, approved: true, outcome: "approved"}})));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.result;
}
const request = (method: string, params: Record<string, unknown>) => wire("owner-control", connection, method, params);
async function connector(kind: "codex" | "claude-desktop", peerPid: number) {
  const peer = { connectionId: randomUUID(), peerPid };
  const pair = () => generateKeyPairSync("ec", {namedCurve: "prime256v1", publicKeyEncoding: {type: "spki", format: "pem"}, privateKeyEncoding: {type: "pkcs8", format: "pem"}});
  const durable = pair(), session = pair();
  const signature = (text: string, key: string) => sign("sha256", Buffer.from(text), key).toString("base64url");
  const send = (method: string, params: Record<string, unknown>) => wire("memory-client", peer, method, params);
  const capabilities = ["memory.remember", "memory.recall", "memory.get_note"];
  const begin = await send("client.begin", {kind, displayName: kind === "codex" ? "Codex" : "Claude Desktop", installIdentity: randomUUID(), publicKey: durable.publicKey,
    signingMode: "development-exact-build", requestedCapabilities: capabilities, forgetPolicy: "never"});
  const paired = await send("client.complete_pairing", {requestId: begin.requestId,
    clientSignature: signature(begin.clientProofTranscript, durable.privateKey)});
  const activation = await send("session.begin", {clientId: paired.clientId, grantId: paired.grantId,
    sessionPublicKey: session.publicKey, requestedCapabilities: capabilities, ttlMs: 900000});
  const active = await send("session.complete", {activationId: activation.activationId, ownerDecisionTranscript: activation.ownerDecisionTranscript,
    clientSignature: signature(activation.clientProofTranscript, durable.privateKey), sessionSignature: signature(activation.sessionProofTranscript, session.privateKey)});
  return async (operation: string, body: Record<string, unknown>) => {
    const unsigned = {protocolVersion: 1, brokerBootId: broker.bootId, vaultId: "9".repeat(64), clientId: active.clientId,
      grantId: active.grantId, sessionId: active.sessionId, requestId: randomUUID(), issuedAt: new Date().toISOString(), operation,
      bodySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex")};
    return send("memory.execute", {envelope: {...unsigned, signature: signature(canonicalBrokerTranscript(unsigned), session.privateKey)}, body});
  };
}
let brokerRecall = false;
let indexingCompleted = false;
let canaryRecall = false;
const started = performance.now();
try {
  await request("library.session.begin", {requestedScopes: [...LIBRARY_SCOPES], ttlMs: 900000});
  const note = (await request("library.remember", {content: "Reserve the freight elevator before moving furniture to the upstairs apartment.", source: null})).note;
  const result = await request("library.search", {cursor: null, limit: 5, query});
  if (result.searchMode !== "hybrid" || result.results[0]?.citation.noteId !== note.id) throw new Error("Immediate paraphrase recall failed");
  if (readFileSync(vaultPath).includes(Buffer.from("freight elevator"))) throw new Error("Note stored in plaintext");
  brokerRecall = true;
  const codex = await connector("codex", 51901);
  const desktop = await connector("claude-desktop", 51902);
  const key = (await codex("memory.remember", {content: "Beta canary Birch 731. The spare apartment key is inside the blue ceramic bowl beside the front door.", source: {application: "Codex"}})).note;
  const washer = (await desktop("memory.remember", {content: "Beta canary Maple 953. When the washing machine shakes, check that all four feet touch the floor before replacing parts.", source: {application: "Claude Desktop"}})).note;
  for (let i = 3; i < 15; i++) await request("library.remember", {
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
  const checks = [];
  for (const [query, expected] of [
    ["where did I leave the backup way into my home?", key.id],
    ["spare key hidden house entry backup way into home", key.id],
    ["key door lock code garage", key.id],
    ["how can I stop my laundry appliance wobbling?", washer.id],
    ["laundry appliance wobbling", washer.id],
    ["washing machine wobbling", washer.id],
    ["backup home access", key.id],
    ["backup way into home", key.id],
  ]) {
    const result = await (expected === key.id ? desktop : codex)("memory.recall", { limit: 5, query });
    checks.push({ query, mode: result.searchMode, count: result.results.length,
      found: result.results.some((r: { citation: { noteId: string } }) => r.citation.noteId === expected) });
  }
  if (checks.some(c => !c.found)) throw new Error(JSON.stringify({canaryFailures: checks}));
  canaryRecall = true;
} finally {broker.close();}
const elapsedMs = performance.now() - started;
const vector = await model.embedQuery(query);
const scores = await model.reranker.score(query, [
  "Reserve the freight elevator before moving furniture.",
  "The upholstery is blue and the street trees are in bloom.",
]);
console.log(JSON.stringify({ brokerRecall, canaryRecall, indexingCompleted, elapsedMs, state: status.state, dimensions: vector.length, scores, minimumScore: model.reranker.minimumScore }));
