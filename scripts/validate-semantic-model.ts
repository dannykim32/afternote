/** Explicit offline benchmark; only the committed synthetic fixtures enter the vault. */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { semanticProfile } from "../apps/local/src/semantic-model-catalog";
import { TransformersTextEmbeddingModel } from "../apps/local/src/transformers-embedding";
import { SqliteMemory } from "../apps/local/src/sqlite-memory";
import { runRecallEvaluation, validCitation } from "../apps/local/src/recall-eval";
import type { TextEmbeddingModel } from "../apps/local/src/retrieval";
import corpus from "./fixtures/semantic-recall-validation-v1.json";

type Case = { query: string; expected: string | null; kind: string };
// Calibration favors supported recall subject to returning nothing for all absent
// subjects. No threshold is selected from evaluation outcomes.
export function chooseCalibrationThreshold(rows: Array<{threshold: number; hitAt5: number; mrr: number; zeroResultRate: number}>) {
  const admissible = rows.filter((row) => row.zeroResultRate === 1);
  return [...(admissible.length ? admissible : rows)].sort((a, b) =>
    b.zeroResultRate - a.zeroResultRate || b.hitAt5 - a.hitAt5 || b.mrr - a.mrr || a.threshold - b.threshold)[0]!;
}

export async function validateSemanticModel(profileKey: string, modelDirectory: string, mode: "holdout" | "scale", output: string) {
  const profile = semanticProfile(profileKey);
  const path = resolve(modelDirectory);
  // Match the production allowlist before timing. Never fetch during measurement.
  for (const [name, expected] of Object.entries(profile.files)) {
    const file = join(path, name);
    if (!statSync(file).isFile() || statSync(file).size !== expected.bytes) throw new Error(`Unexpected model file: ${name}`);
    const digest = createHash("sha256");
    const fd = openSync(file, "r"), buffer = Buffer.alloc(64 * 1024);
    try { let n: number; while ((n = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, n)); }
    finally { closeSync(fd); }
    if (digest.digest("hex") !== expected.sha256) throw new Error(`Model digest failed: ${name}`);
  }
  const model = new TransformersTextEmbeddingModel({ profile, cacheDirectory: path, localModelPath: path, allowRemoteModels: false });
  let peakRss = process.memoryUsage().rss;
  const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  const timer = setInterval(sample, 20);
  const started = performance.now();
  let firstQueryAt: number | undefined, indexInferenceMs = 0, slices = 0, nextProgress = 320;
  let threshold = profile.minimumSimilarity;
  let calibrationCache: Map<string, Float32Array> | null = null;
  const measured: TextEmbeddingModel = {
    descriptor: model.descriptor,
    get minimumSimilarity() { return threshold; },
    uiMinimumSimilarity: model.uiMinimumSimilarity,
    embed: async (texts, stopped) => {
      const start = performance.now();
      const vectors = await model.embed(texts, stopped);
      indexInferenceMs += performance.now() - start; slices += texts.length; sample();
      if (slices >= nextProgress) {
        nextProgress = slices + 320;
        console.error(JSON.stringify({ event: "indexing", profile: profile.key, slices, seconds: (performance.now() - started) / 1000 }));
      }
      return vectors;
    },
    embedQuery: async (text) => {
      firstQueryAt ??= performance.now();
      const existing = calibrationCache?.get(text);
      if (existing) return existing;
      const vector = await model.embedQuery(text);
      calibrationCache?.set(text, vector);
      return vector;
    },
  };
  let memory: SqliteMemory | undefined;
  try {
    await model.embed(["Synthetic benchmark warmup note."]); sample();
    const loadMs = performance.now() - started;
    console.error(JSON.stringify({ event: "loaded", profile: profile.key, loadMs, mode }));
    let result: unknown;
    if (mode === "scale") {
      result = await runRecallEvaluation("2.0.0-model-validation", { embeddingModel: measured, targetNoteCount: 10_000 });
    } else {
      const vault = { vaultId: "f".repeat(64), deployment: "local" as const };
      // The in-memory fixture uses the same canonical storage/retrieval path without touching a user's vault.
      memory = new SqliteMemory(":memory:", vault, { embeddingModel: measured, retrievalMode: "hybrid", timeZone: "UTC", now: () => new Date("2026-09-15T12:00:00Z") });
      const keysById = new Map<string, string>(), idsByKey = new Map<string, string>();
      for (const note of corpus.notes) {
        const saved = await memory.remember(vault, { content: note.content });
        keysById.set(saved.id, note.key); idsByKey.set(note.key, saved.id);
      }
      await memory.waitForDerivedIndex();
      if (memory.derivedIndexStatus(vault).state !== "ready") throw new Error("Synthetic index did not become ready");
      async function evaluate(cases: Case[]) {
        const rows = [];
        let supported = 0, hits = 0, mrr = 0, unsupported = 0, zero = 0, citations = 0, valid = 0;
        const durations = [];
        for (const item of cases) {
          const start = performance.now(); const results = await memory!.recall(vault, item.query, 5); durations.push(performance.now() - start); sample();
          const rank = item.expected === null ? null : results.findIndex((r) => r.note.id === idsByKey.get(item.expected!)) + 1;
          if (item.expected === null) { unsupported++; if (results.length === 0) zero++; }
          else { supported++; if (rank! > 0) { hits++; mrr += 1 / rank!; } }
          for (const r of results) { citations++; if (validCitation(r)) valid++; }
          rows.push({ ...item, rank, actual: results.map((r) => ({ key: keysById.get(r.note.id), score: r.score })), durationMs: durations.at(-1) });
        }
        durations.sort((a,b) => a-b);
        return { threshold, supportedCases: supported, unsupportedCases: unsupported, hitAt5: hits / supported, mrr: mrr / supported, zeroResultRate: zero / unsupported,
          citationIntegrity: citations ? valid / citations : 1, p95Ms: durations[Math.ceil(durations.length * .95) - 1], rows };
      }
      const currentCalibration = await evaluate(corpus.calibration);
      calibrationCache = new Map();
      const sweep = [];
      for (let value = 20; value <= 90; value += 2) {
        threshold = value / 100;
        const measured = await evaluate(corpus.calibration);
        sweep.push({ threshold, hitAt5: measured.hitAt5, mrr: measured.mrr, zeroResultRate: measured.zeroResultRate });
      }
      const chosen = chooseCalibrationThreshold(sweep);
      calibrationCache = null;
      // Commit the calibration decision to disk before revealing held-out results.
      await Bun.write(`${output}.calibration.json`, JSON.stringify({ profile: profile.key, chosen, currentCalibration, sweep }, null, 2));
      threshold = profile.minimumSimilarity;
      const currentEvaluation = await evaluate(corpus.evaluation);
      threshold = chosen.threshold;
      const calibratedEvaluation = await evaluate(corpus.evaluation);
      const gates = corpus.gates;
      const passes = (r: typeof currentEvaluation) => r.hitAt5 >= gates.supportedHitAt5 && r.mrr >= gates.supportedMrr && r.zeroResultRate >= gates.unsupportedZeroResultRate && r.citationIntegrity >= gates.citationIntegrity;
      result = { corpusVersion: corpus.version, corpusSha256: createHash("sha256").update(readFileSync(new URL("./fixtures/semantic-recall-validation-v1.json", import.meta.url))).digest("hex"), gates,
        chosenCalibration: chosen, currentCalibration, currentEvaluation, calibratedEvaluation, currentPassed: passes(currentEvaluation), calibratedPassed: passes(calibratedEvaluation) };
    }
    sample();
    const report = { profile: profile.key, descriptor: model.descriptor, runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
      measurements: { loadMs, setupAndIndexingWallMs: firstQueryAt === undefined ? null : firstQueryAt - started - loadMs, indexInferenceMs, embeddedSlices: slices, sampledPeakRssMiB: peakRss / 1024 ** 2, elapsedSeconds: (performance.now() - started) / 1000 }, result };
    await Bun.write(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ profile: profile.key, mode, output, measurements: report.measurements }));
    return report;
  } finally { clearInterval(timer); memory?.close(); }
}

if (import.meta.main) {
  const [profile, directory, mode, output] = process.argv.slice(2);
  if (!profile || !directory || !output || !["holdout", "scale"].includes(mode ?? "")) throw new Error("Usage: bun scripts/validate-semantic-model.ts light|balanced|large MODEL_DIRECTORY holdout|scale REPORT_PATH");
  await validateSemanticModel(profile, directory, mode as "holdout" | "scale", output);
}
