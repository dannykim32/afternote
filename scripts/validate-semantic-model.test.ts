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
