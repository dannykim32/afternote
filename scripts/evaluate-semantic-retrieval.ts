/** Offline synthetic evaluation of the complete Notes + agent retrieval path. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TransformersTextEmbeddingModel } from "../apps/local/src/transformers-embedding";
import { SEMANTIC_MODELS } from "../apps/local/src/semantic-model-catalog";
import { SqliteMemory } from "../apps/local/src/sqlite-memory";
import { validCitation } from "../apps/local/src/recall-eval";
import type { TextEmbeddingModel } from "../apps/local/src/retrieval";

export async function evaluateSemanticRetrieval(directory: string, version: "v1" | "v2" | "v3", output: string, baseline = false) {
  const fixturePath = new URL(`./fixtures/semantic-recall-validation-${version}.json`, import.meta.url);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    notes: Array<{key: string; content: string}>;
    calibration?: Array<{query: string; expected: string | null; kind: string}>;
    evaluation: Array<{query: string; expected: string | null; kind: string}>;
  };
  // The current allowlist covers both embedding and reranking artifacts.
  for (const [name, expected] of Object.entries(SEMANTIC_MODELS.balanced.files)) {
    const bytes = readFileSync(resolve(directory, name));
    if (bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new Error(`Model verification failed: ${name}`);
  }
  const raw = new TransformersTextEmbeddingModel({ profile: SEMANTIC_MODELS.balanced, localModelPath: directory, cacheDirectory: directory, allowRemoteModels: false });
  const model: TextEmbeddingModel = {
    descriptor: raw.descriptor, minimumSimilarity: raw.minimumSimilarity, uiMinimumSimilarity: raw.uiMinimumSimilarity,
    embed: raw.embed.bind(raw), embedQuery: raw.embedQuery.bind(raw), reranker: baseline ? undefined : raw.reranker,
  };
  let peak = process.memoryUsage().rss;
  const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
  const timer = setInterval(sample, 20);
  const vault = { vaultId: "f".repeat(64), deployment: "local" as const };
  const memory = new SqliteMemory(":memory:", vault, { embeddingModel: model, retrievalMode: "hybrid", timeZone: "UTC", now: () => new Date("2026-09-15T12:00:00Z") });
  try {
    const started = performance.now();
    await raw.embed(["Synthetic warmup."]);
    if (model.reranker) await model.reranker.score("search test", ["Synthetic search test."]);
    const loadMs = performance.now() - started;
    const keys = new Map<string, string>();
    for (const note of fixture.notes) keys.set((await memory.remember(vault, { content: note.content })).id, note.key);
    await memory.waitForDerivedIndex();
    if (memory.derivedIndexStatus(vault).state !== "ready") throw new Error("Index not ready");
    const indexMs = performance.now() - started - loadMs;
    const cases = version === "v1" ? [...fixture.calibration!, ...fixture.evaluation] : fixture.evaluation;
    const results = [];
    for (const surface of ["agent", "ui"] as const) {
      const rows = [];
      for (const item of cases) {
        const before = performance.now();
        const execution = surface === "agent" ? null : await memory.searchNotesWithDeadline(vault, { query: item.query, limit: 5 }, 2000);
        const hits = execution ? execution.results : await memory.recall(vault, item.query, 5);
        sample();
        rows.push({ ...item, rank: item.expected === null ? null : hits.findIndex(hit => keys.get(hit.note.id) === item.expected) + 1,
          searchMode: execution?.searchMode ?? null, actual: hits.map(hit => ({key: keys.get(hit.note.id), score: hit.score})), citationIntegrity: hits.every(validCitation), ms: performance.now() - before });
      }
      const supported = rows.filter(row => row.expected !== null), unsupported = rows.filter(row => row.expected === null);
      const times = rows.map(row => row.ms).sort((a, b) => a - b);
      const hitAt5 = supported.filter(row => row.rank! > 0).length / supported.length;
      const mrr = supported.reduce((sum, row) => sum + (row.rank! > 0 ? 1 / row.rank! : 0), 0) / supported.length;
      const zeroResultRate = unsupported.filter(row => row.actual.length === 0).length / unsupported.length;
      const citationIntegrity = rows.every(row => row.citationIntegrity);
      results.push({surface, supported: supported.length, unsupported: unsupported.length, hitAt5, mrr, zeroResultRate, citationIntegrity,
        p95Ms: times[Math.ceil(times.length * .95) - 1], qualityPassed: hitAt5 === 1 && mrr >= .9 && zeroResultRate === 1 && citationIntegrity, rows});
    }
    const report = {version, baseline, fixtureSha256: createHash("sha256").update(readFileSync(fixturePath)).digest("hex"), embedding: model.descriptor,
      reranker: model.reranker ? { id: model.reranker.id, minimumScore: model.reranker.minimumScore } : null,
      runtime: {bun: Bun.version, platform: process.platform, arch: process.arch}, loadMs, indexMs, sampledPeakRssMiB: peak / 1024 ** 2, results};
    await Bun.write(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({...report, results: results.map(({rows, ...summary}) => summary)}));
    return report;
  } finally { clearInterval(timer); memory.close(); }
}

if (import.meta.main) {
  const [directory, version, output, baseline] = process.argv.slice(2);
  if (!directory || !output || (version !== "v1" && version !== "v2" && version !== "v3") || (baseline !== undefined && baseline !== "baseline")) throw new Error("Usage: bun scripts/evaluate-semantic-retrieval.ts MODEL_DIRECTORY v1|v2|v3 REPORT_PATH [baseline]");
  await evaluateSemanticRetrieval(resolve(directory), version, output, baseline === "baseline");
}
