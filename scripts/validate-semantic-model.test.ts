import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import corpus from "./fixtures/semantic-recall-validation-v1.json";
import { chooseCalibrationThreshold } from "./validate-semantic-model";

it("keeps calibration targets separate from the frozen held-out targets", () => {
  expect(createHash("sha256").update(readFileSync(new URL("./fixtures/semantic-recall-validation-v1.json", import.meta.url))).digest("hex"))
    .toBe("45695ec1a15bbc80417bc69d373b1aaaa5d4b5c0a24458a1ebef1f15e7d70aad");
  const keys = new Set(corpus.notes.map((note) => note.key));
  expect(keys.size).toBe(corpus.notes.length);
  const calibration = new Set(corpus.calibration.map((c) => c.expected).filter(Boolean));
  for (const item of [...corpus.calibration, ...corpus.evaluation]) if (item.expected !== null) expect(keys.has(item.expected)).toBe(true);
  expect(corpus.evaluation.filter((c) => c.expected !== null).some((c) => calibration.has(c.expected))).toBe(false);
});

it("requires calibration abstention before maximizing recall and reports the tradeoff", () => {
  const rows = [
    { threshold: .3, hitAt5: 1, mrr: 1, zeroResultRate: .5 },
    { threshold: .5, hitAt5: .75, mrr: .7, zeroResultRate: 1 },
    { threshold: .7, hitAt5: .5, mrr: .5, zeroResultRate: 1 },
  ];
  expect(chooseCalibrationThreshold(rows)).toEqual(rows[1]);
  expect(rows[0]!.threshold).toBe(.3);
});


it("freezes the fresh retrieval holdout before tuning and keeps it separate from v1", () => {
  const bytes = readFileSync(new URL("./fixtures/semantic-recall-validation-v2.json", import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("97d136b2102ac5d6f7fe44e76268ef8c719f9d4a1ba5d5c7ce4373fd6856b206");
  const fresh = JSON.parse(bytes.toString());
  const keys = new Set(fresh.notes.map((note: {key: string}) => note.key));
  expect(keys.size).toBe(fresh.notes.length);
  expect(fresh.calibration).toBeUndefined();
  const oldQueries = new Set([...corpus.calibration, ...corpus.evaluation].map(item => item.query));
  for (const item of fresh.evaluation) {
    expect(oldQueries.has(item.query)).toBe(false);
    if (item.expected !== null) expect(keys.has(item.expected)).toBe(true);
  }
});
