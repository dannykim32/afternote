import { describe, expect, it } from "bun:test";
import type { RecallResult } from "@afternote/memory";
import { LOCAL_RECALL_SEMANTIC_SCENARIOS } from "./recall-eval-corpus";
import { runRecallEvaluation, validCitation } from "./recall-eval";
import type { TextEmbeddingModel } from "./retrieval";

const result: RecallResult = {
  note: {
    id: "00000000-0000-4000-8000-000000000001",
    content: "Send John the revised proposal Friday afternoon.",
    revision: 1,
    source: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  citation: {
    noteId: "00000000-0000-4000-8000-000000000001",
    revision: 1,
    excerpt: "revised proposal Friday afternoon",
    source: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  score: 1,
};

describe("Recall evaluation citation integrity", () => {
  it("accepts an excerpt from the cited note revision", () => {
    expect(validCitation(result)).toBe(true);
  });

  it("rejects a mismatched excerpt even when the note ID and revision match", () => {
    expect(
      validCitation({
        ...result,
        citation: {
          ...result.citation,
          excerpt: "The Denver flight leaves from gate B32.",
        },
      }),
    ).toBe(false);
  });

  it("accepts ordered note fragments separated by SQLite snippet ellipses", () => {
    expect(
      validCitation({
        ...result,
        note: {
          ...result.note,
          content:
            "word0 one two three four five six seven eight nine ten eleven " +
            "twelve thirteen fourteen fifteen sixteen seventeen eighteen word23 " +
            "twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty",
        },
        citation: {
          ...result.citation,
          excerpt: "word0 … word23 … ",
        },
      }),
    ).toBe(true);
  });
});

describe("Recall evaluation noise scaling", () => {
  it("preserves ranked evidence and citations with 100x synthetic distractors", async () => {
    const report = await runRecallEvaluation("2.0.0-test", {
      noiseMultiplier: 100,
    });
    expect(report.corpus).toMatchObject({
      baseNoteCount: 31,
      noiseMultiplier: 100,
      noiseNoteCount: 3_100,
      noteCount: 3_131,
    });
    expect(report.quality).toMatchObject({
      hitRateAt5: 1,
      unsupportedZeroResultRate: 1,
      citationIntegrityRate: 1,
    });
    expect(report.quality.meanReciprocalRank).toBeGreaterThanOrEqual(
      report.thresholds.meanReciprocalRank,
    );
    expect(report.passed).toBe(true);
  }, 30_000);

  it("can run the semantic contract against exactly 10,000 notes", async () => {
    const report = await runRecallEvaluation("2.0.0-test", {
      targetNoteCount: 10_000,
      embeddingModel: new FrozenSemanticEmbeddingModel(),
    });
    expect(report.corpus).toMatchObject({
      noteCount: 10_000,
      targetNoteCount: 10_000,
      semanticNoteCount: 4,
    });
    const semanticCaseIds = new Set<string>(
      LOCAL_RECALL_SEMANTIC_SCENARIOS.map((scenario) => scenario.key),
    );
    expect(report.cases.filter((evaluationCase) =>
      semanticCaseIds.has(evaluationCase.id) && !evaluationCase.passed))
      .toEqual([]);
    expect(report.semanticQuality).toMatchObject({
      caseCount: 14,
      hitRateAt5: 1,
    });
    expect(report.semanticQuality?.meanReciprocalRank).toBeGreaterThanOrEqual(
      report.thresholds.semanticMeanReciprocalRank,
    );
    expect(report.cases.every((evaluationCase) =>
      evaluationCase.expectedRanks.every((rank) => rank === null || rank >= 1)))
      .toBe(true);
    expect(report.passed).toBe(true);
  }, 30_000);

});

describe("Recall evaluation temporal retrieval", () => {
  it("holds relative-time recall against a fixed evaluation clock", async () => {
    const report = await runRecallEvaluation("2.0.0-test");
    const temporalCases = new Map(report.cases.map((evaluationCase) => [
      evaluationCase.id,
      evaluationCase,
    ]));
    expect(report.corpus.baseNoteCount).toBe(31);
    expect(temporalCases.get("temporal-last-friday")).toMatchObject({
      passed: true,
      expectedNoteIds: ["00000000-0000-4000-8000-000000000021"],
    });
    expect(temporalCases.get("temporal-last-friday")?.actualNoteIds[0]).toBe(
      "00000000-0000-4000-8000-000000000021",
    );
    expect(temporalCases.get("temporal-last-month-year-boundary")).toMatchObject({
      passed: true,
      expectedNoteIds: ["00000000-0000-4000-8000-000000000022"],
    });
    expect(temporalCases.get("temporal-last-month-year-boundary")?.actualNoteIds[0])
      .toBe("00000000-0000-4000-8000-000000000022");
    expect(temporalCases.get("temporal-next-weekday")).toMatchObject({
      passed: true,
      expectedNoteIds: ["00000000-0000-4000-8000-000000000015"],
      actualNoteIds: ["00000000-0000-4000-8000-000000000015"],
    });
    expect(temporalCases.get("temporal-ambiguous-weekday-lexical")).toMatchObject({
      passed: true,
      expectedNoteIds: ["00000000-0000-4000-8000-000000000001"],
      actualNoteIds: [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000021",
      ],
    });
    for (const id of [
      "source-time-last-friday",
      "source-time-last-month",
      "source-time-next-weekend",
    ]) {
      expect(temporalCases.get(id)?.passed).toBe(true);
      expect(temporalCases.get(id)?.expectedRanks[0]).toBe(1);
    }
  });
});

describe("Recall evaluation revision and document-shape holdout", () => {
  it("recalls only current evidence across stale revisions, near-duplicates, and long notes", async () => {
    const report = await runRecallEvaluation("2.0.0-test");
    const cases = new Map(report.cases.map((evaluationCase) => [
      evaluationCase.id,
      evaluationCase,
    ]));

    expect(report.corpus).toMatchObject({
      version: 8,
      baseNoteCount: 31,
      unsupportedCaseCount: 4,
    });
    expect(cases.get("revision-current-location")).toMatchObject({
      passed: true,
      expectedNoteIds: ["00000000-0000-4000-8000-000000000025"],
      citationFragmentMatched: true,
    });
    expect(cases.get("revision-current-location")?.actualNoteIds[0]).toBe(
      "00000000-0000-4000-8000-000000000025",
    );
    expect(cases.get("revision-stale-location")).toMatchObject({
      passed: true,
      expectedNoteIds: [],
      excludedNoteIds: ["00000000-0000-4000-8000-000000000025"],
    });
    expect(cases.get("revision-stale-location")?.actualNoteIds).not.toContain(
      "00000000-0000-4000-8000-000000000025",
    );
    expect(cases.get("duplicate-identical-notes")).toMatchObject({
      passed: true,
      expectedNoteIds: [
        "00000000-0000-4000-8000-000000000026",
        "00000000-0000-4000-8000-000000000027",
      ],
    });
    expect(new Set(cases.get("duplicate-identical-notes")?.actualNoteIds)).toEqual(
      new Set([
        "00000000-0000-4000-8000-000000000026",
        "00000000-0000-4000-8000-000000000027",
      ]),
    );
    expect(cases.get("long-note-tail-citation")).toMatchObject({
      passed: true,
      expectedNoteIds: ["00000000-0000-4000-8000-000000000028"],
      actualNoteIds: ["00000000-0000-4000-8000-000000000028"],
      citationFragmentMatched: true,
    });
  });
});

describe("Recall evaluation semantic holdout", () => {
  it("gates several no-keyword paraphrases through the hybrid Recall seam", async () => {
    const lexicalReport = await runRecallEvaluation("2.0.0-test", {
      includeSemanticHoldout: true,
    });
    const report = await runRecallEvaluation("2.0.0-test", {
      embeddingModel: new FrozenSemanticEmbeddingModel(),
    });
    const cases = new Map(report.cases.map((evaluationCase) => [
      evaluationCase.id,
      evaluationCase,
    ]));

    expect(report.corpus).toMatchObject({
      version: 8,
      semanticNoteCount: 4,
      caseCount: 41,
    });
    expect(report.engine).toBe("hybrid:frozen-semantic-fixture");
    const semanticCaseIds = LOCAL_RECALL_SEMANTIC_SCENARIOS.map(
      (scenario) => scenario.key,
    );
    const lexicalCases = new Map(lexicalReport.cases.map((evaluationCase) => [
      evaluationCase.id,
      evaluationCase,
    ]));
    for (const scenario of LOCAL_RECALL_SEMANTIC_SCENARIOS) {
      expect(lexicalCases.get(scenario.key)?.actualNoteIds).not.toContain(
        scenario.noteId,
      );
      expect(cases.get(scenario.key)?.actualNoteIds).toContain(scenario.noteId);
    }
    expect(semanticCaseIds.map((id) => cases.get(id)?.passed))
      .toEqual(semanticCaseIds.map(() => true));
    const lexicalHitRate = holdoutHitRate(lexicalCases);
    const hybridHitRate = holdoutHitRate(cases);
    expect(lexicalHitRate).toBe(0);
    expect(hybridHitRate).toBe(1);
    expect(hybridHitRate - lexicalHitRate).toBeGreaterThanOrEqual(0.1);
    expect(report.passed).toBe(true);
  });
});

class FrozenSemanticEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity = 0.8;
  readonly descriptor = {
    id: "frozen-semantic-fixture",
    revision: "1",
    dimensions: LOCAL_RECALL_SEMANTIC_SCENARIOS.length,
  };

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => semanticFixtureVector(text));
  }
}

function semanticFixtureVector(text: string): Float32Array {
  const conceptIndex = LOCAL_RECALL_SEMANTIC_SCENARIOS.findIndex((scenario) =>
    [scenario.documentPhrase, scenario.queryPhrase].some((phrase) =>
      text.toLowerCase().includes(phrase),
    ),
  );
  const values = Array<number>(LOCAL_RECALL_SEMANTIC_SCENARIOS.length).fill(0);
  if (conceptIndex >= 0) values[conceptIndex] = 1;
  return Float32Array.from(values);
}

function holdoutHitRate(
  cases: ReadonlyMap<
    string,
    { expectedNoteIds: string[]; actualNoteIds: string[] } | undefined
  >,
): number {
  const hits = LOCAL_RECALL_SEMANTIC_SCENARIOS.filter((scenario) =>
    cases.get(scenario.key)?.actualNoteIds.includes(scenario.noteId),
  ).length;
  return hits / LOCAL_RECALL_SEMANTIC_SCENARIOS.length;
}
