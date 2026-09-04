import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallResult, VaultContext } from "@afternote/memory";
import { writeInterchange, type StreamingInterchangeNote } from "./interchange";
import {
  LOCAL_RECALL_EVALUATION_CORPUS,
  type RecallEvaluationNote,
} from "./recall-eval-corpus";
import { SqliteMemory } from "./sqlite-memory";
import type { TextEmbeddingModel } from "./retrieval";

const RECALL_LIMIT = 5;
const LATENCY_P95_LIMIT_MS = 100;
const EVALUATION_TIMESTAMP = "2026-01-15T12:00:00.000Z";
const EVALUATION_VAULT: VaultContext = {
  vaultId: "e".repeat(64),
  deployment: "local",
};
const THRESHOLDS = {
  hitRateAt5: 1,
  meanReciprocalRank: 0.9,
  semanticHitRateAt5: 1,
  semanticMeanReciprocalRank: 0.9,
  unsupportedZeroResultRate: 1,
  citationIntegrityRate: 1,
} as const;

export async function runRecallEvaluation(
  applicationVersion: string,
  options: {
    noiseMultiplier?: 0 | 10 | 100;
    targetNoteCount?: 10_000;
    embeddingModel?: TextEmbeddingModel;
    includeSemanticHoldout?: boolean;
  } = {},
) {
  const noiseMultiplier = options.noiseMultiplier ?? 0;
  const includeSemanticHoldout =
    options.includeSemanticHoldout ?? Boolean(options.embeddingModel);
  const semanticNotes = includeSemanticHoldout
    ? LOCAL_RECALL_EVALUATION_CORPUS.semanticNotes
    : [];
  if (options.targetNoteCount && noiseMultiplier !== 0) {
    throw new Error("Recall evaluation accepts either a target note count or a noise multiplier");
  }
  const fixedNoteCount = LOCAL_RECALL_EVALUATION_CORPUS.notes.length + semanticNotes.length;
  const noiseNoteCount = options.targetNoteCount
    ? options.targetNoteCount - fixedNoteCount
    : LOCAL_RECALL_EVALUATION_CORPUS.notes.length * noiseMultiplier;
  if (noiseNoteCount < 0) throw new Error("Recall evaluation target is smaller than its fixed corpus");
  const noiseNotes = syntheticNoiseNotes(noiseNoteCount);
  const evaluationCases = includeSemanticHoldout
    ? [
        ...LOCAL_RECALL_EVALUATION_CORPUS.cases,
        ...LOCAL_RECALL_EVALUATION_CORPUS.semanticCases,
      ]
    : LOCAL_RECALL_EVALUATION_CORPUS.cases;
  const notes = [
    ...LOCAL_RECALL_EVALUATION_CORPUS.notes,
    ...semanticNotes,
    ...noiseNotes,
  ].sort((left, right) => left.id.localeCompare(right.id));
  const directory = mkdtempSync(join(tmpdir(), "afternote-recall-eval-"));
  const interchangePath = join(directory, "corpus.afternote.json");
  const databasePath = join(directory, "vault.db");
  let memory: SqliteMemory | undefined;
  try {
    writeEvaluationInterchange(interchangePath, applicationVersion, notes);
    SqliteMemory.restoreInterchange(
      interchangePath,
      databasePath,
      EVALUATION_VAULT,
      applicationVersion,
    );
    memory = new SqliteMemory(databasePath, EVALUATION_VAULT, {
      embeddingModel: options.embeddingModel,
      retrievalMode: options.embeddingModel ? "hybrid" : "lexical",
      now: () => new Date(EVALUATION_TIMESTAMP),
      timeZone: "UTC",
    });
    await memory.waitForDerivedIndex();
    const derivedIndex = memory.derivedIndexStatus(EVALUATION_VAULT);
    const noteIds = new Map(
      notes.map((note) => [note.key, note.id]),
    );
    const cases: Array<{
      id: string;
      expectedNoteIds: string[];
      excludedNoteIds: string[];
      actualNoteIds: string[];
      citationFragmentMatched: boolean | null;
      expectedRanks: Array<number | null>;
      actualScores: number[];
      passed: boolean;
    }> = [];
    const latencies: number[] = [];
    let supportedHits = 0;
    let reciprocalRankTotal = 0;
    let unsupportedZeroResults = 0;
    let citationChecks = 0;
    let validCitations = 0;

    for (const evaluationCase of evaluationCases) {
      const startedAt = performance.now();
      const results = await memory.recall(
        EVALUATION_VAULT,
        evaluationCase.query,
        RECALL_LIMIT,
      );
      latencies.push(performance.now() - startedAt);
      const expectedNoteIds = evaluationCase.expectedNoteKeys.map((key) => {
        const id = noteIds.get(key);
        if (!id) throw new Error(`Recall evaluation references unknown note key: ${key}`);
        return id;
      });
      const excludedNoteIds = (evaluationCase.excludedNoteKeys ?? []).map((key) => {
        const id = noteIds.get(key);
        if (!id) throw new Error(`Recall evaluation references unknown excluded note key: ${key}`);
        return id;
      });
      const actualNoteIds = results.map((result) => result.note.id);
      const expectedRanks = expectedNoteIds.map((id) => {
        const index = actualNoteIds.indexOf(id);
        return index < 0 ? null : index + 1;
      });
      const citationsAreValid = results.every(validCitation);
      const expectedCitationFragment = evaluationCase.expectedCitationFragment;
      const citationFragmentMatched = expectedCitationFragment
        ? results.some(
            (result) =>
              expectedNoteIds.includes(result.note.id) &&
              result.citation.excerpt.includes(expectedCitationFragment),
          )
        : null;
      citationChecks += results.length;
      validCitations += results.filter(validCitation).length;

      let passed: boolean;
      if (excludedNoteIds.length > 0) {
        passed = excludedNoteIds.every((id) => !actualNoteIds.includes(id));
      } else if (expectedNoteIds.length === 0) {
        passed = actualNoteIds.length === 0;
        if (passed && evaluationCase.unsupported) unsupportedZeroResults += 1;
      } else {
        const firstRelevantIndex = actualNoteIds.findIndex((id) =>
          expectedNoteIds.includes(id),
        );
        const hit = expectedNoteIds.every((id) => actualNoteIds.includes(id));
        if (hit) supportedHits += 1;
        if (firstRelevantIndex >= 0) reciprocalRankTotal += 1 / (firstRelevantIndex + 1);
        passed =
          hit &&
          citationsAreValid &&
          citationFragmentMatched !== false;
      }
      cases.push({
        id: evaluationCase.id,
        expectedNoteIds,
        excludedNoteIds,
        actualNoteIds,
        citationFragmentMatched,
        expectedRanks,
        actualScores: results.map((result) => Number(result.score.toFixed(6))),
        passed,
      });
    }

    const supportedCaseCount = evaluationCases.filter(
      (evaluationCase) => evaluationCase.expectedNoteKeys.length > 0,
    ).length;
    const unsupportedCaseCount = evaluationCases.filter(
      (evaluationCase) => evaluationCase.unsupported,
    ).length;
    const quality = {
      hitRateAt5: ratio(supportedHits, supportedCaseCount),
      meanReciprocalRank: ratio(reciprocalRankTotal, supportedCaseCount),
      unsupportedZeroResultRate: ratio(
        unsupportedZeroResults,
        unsupportedCaseCount,
      ),
      citationIntegrityRate: ratio(validCitations, citationChecks),
    };
    const p95Ms = percentile95(latencies);
    const semanticCaseIds = new Set(
      LOCAL_RECALL_EVALUATION_CORPUS.semanticCases.map((evaluationCase) => evaluationCase.id),
    );
    const semanticResults = cases.filter((evaluationCase) =>
      semanticCaseIds.has(evaluationCase.id));
    const semanticQuality = semanticResults.length > 0
      ? {
          caseCount: semanticResults.length,
          hitRateAt5: ratio(
            semanticResults.filter((evaluationCase) => evaluationCase.passed).length,
            semanticResults.length,
          ),
          meanReciprocalRank: ratio(
            semanticResults.reduce(
              (total, evaluationCase) =>
                total + (evaluationCase.expectedRanks[0]
                  ? 1 / evaluationCase.expectedRanks[0]
                  : 0),
              0,
            ),
            semanticResults.length,
          ),
        }
      : null;
    const latency = {
      p95Ms,
      limitMs: LATENCY_P95_LIMIT_MS,
      passed: p95Ms < LATENCY_P95_LIMIT_MS,
    };
    const passed =
      quality.hitRateAt5 >= THRESHOLDS.hitRateAt5 &&
      quality.meanReciprocalRank >= THRESHOLDS.meanReciprocalRank &&
      quality.unsupportedZeroResultRate >=
        THRESHOLDS.unsupportedZeroResultRate &&
      quality.citationIntegrityRate >= THRESHOLDS.citationIntegrityRate &&
      (!semanticQuality || (
        semanticQuality.hitRateAt5 >= THRESHOLDS.semanticHitRateAt5 &&
        semanticQuality.meanReciprocalRank >=
          THRESHOLDS.semanticMeanReciprocalRank
      )) &&
      latency.passed &&
      (!options.embeddingModel || derivedIndex.state === "ready") &&
      cases.every((evaluationCase) => evaluationCase.passed);

    return {
      format: "afternote-recall-eval",
      schemaVersion: 1,
      corpus: {
        id: LOCAL_RECALL_EVALUATION_CORPUS.id,
        version: LOCAL_RECALL_EVALUATION_CORPUS.version,
        sha256: corpusSha256(notes, evaluationCases),
        baseNoteCount: LOCAL_RECALL_EVALUATION_CORPUS.notes.length,
        semanticNoteCount: semanticNotes.length,
        noiseMultiplier,
        noiseNoteCount: noiseNotes.length,
        targetNoteCount: options.targetNoteCount ?? null,
        noteCount: notes.length,
        caseCount: evaluationCases.length,
        unsupportedCaseCount,
      },
      engine: options.embeddingModel
        ? `hybrid:${options.embeddingModel.descriptor.id}`
        : "sqlite-fts5",
      derivedIndex,
      quality,
      semanticQuality,
      thresholds: THRESHOLDS,
      latency,
      cases,
      passed,
    } as const;
  } finally {
    memory?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function corpusSha256(
  notes: readonly EvaluationNote[],
  cases: readonly { id: string; query: string; expectedNoteKeys: readonly string[] }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        notes,
        cases,
      }),
    )
    .digest("hex");
}

function writeEvaluationInterchange(
  path: string,
  applicationVersion: string,
  notes: readonly EvaluationNote[],
): void {
  const streamNotes = function* (): Iterable<StreamingInterchangeNote> {
    for (const note of notes) {
      const previousRevisions = note.previousRevisions ?? [];
      const currentRevision = previousRevisions.length + 1;
      yield {
        id: note.id,
        currentRevision,
        createdAt: EVALUATION_TIMESTAMP,
        updatedAt: EVALUATION_TIMESTAMP,
        revisions: function* () {
          for (const [index, revision] of previousRevisions.entries()) {
            yield {
              noteId: note.id,
              revision: index + 1,
              content: revision.content,
              source: revision.source ?? note.source ?? null,
              createdAt: EVALUATION_TIMESTAMP,
            };
          }
          yield {
            noteId: note.id,
            revision: currentRevision,
            content: note.content,
            source: note.source ?? null,
            createdAt: EVALUATION_TIMESTAMP,
          };
        },
      };
    }
  };
  writeInterchange(
    path,
    streamNotes,
    notes.length,
    notes.reduce(
      (count, note) => count + (note.previousRevisions?.length ?? 0) + 1,
      0,
    ),
    applicationVersion,
  );
}

type EvaluationNote = RecallEvaluationNote;

function syntheticNoiseNotes(count: number): EvaluationNote[] {
  const actors = [
    "Avery", "Blake", "Casey", "Devon", "Elliot", "Finley", "Gray", "Harper",
    "Indigo", "Jules", "Kai", "Logan", "Morgan", "Nico", "Oakley", "Parker",
    "Quinn", "Reese", "Skyler", "Taylor", "Uma", "Val", "Winter", "Zion",
  ] as const;
  const activities = [
    "reviewed the draft for", "scheduled a check of", "left an open question about",
    "recorded a preliminary estimate for", "moved the planning card for",
    "requested a second opinion on", "closed an outdated task about",
    "added a nonbinding reminder for", "prepared a rough inventory of",
    "flagged a missing owner for", "compared two options for", "postponed a decision about",
    "summarized a routine update on", "started a checklist for", "archived a duplicate note on",
    "asked for more context about", "logged an ordinary status change for",
    "noted an unresolved dependency for", "created a placeholder around",
    "removed an obsolete label from", "captured a tentative idea for",
    "reopened the discussion about", "verified the formatting of", "sorted reference material for",
  ] as const;
  const subjects = [
    "the community newsletter", "a conference-room calendar", "the supply cabinet",
    "a sample invoice", "the volunteer roster", "an equipment inspection",
    "the quarterly planning board", "a generic travel draft", "the office plants",
    "a training exercise", "the shared reading queue", "a facilities request",
    "the demo environment", "a meal-planning worksheet", "the shipping label printer",
    "a neighborhood event", "the prototype backlog", "an unsigned vendor form",
  ] as const;
  const contexts = [
    "No final owner or deadline was selected",
    "The item remains informational and has no approved outcome",
    "A follow-up may be needed after the next routine review",
    "The record contains no credentials or private access details",
    "The placeholder was retained only for testing search volume",
    "No purchase, reservation, or commitment was made",
  ] as const;
  const applications = ["Mail", "Calendar", "Notion", "Linear", "Team Chat", "Basecamp"] as const;
  return Array.from({ length: count }, (_, index) => ({
    key: `noise-${index + 1}`,
    id: `00000000-0000-4000-9000-${(100_000 + index).toString().padStart(12, "0")}`,
    content: `${actors[index % actors.length]} ${
      activities[Math.floor(index / actors.length) % activities.length]
    } ${subjects[Math.floor(index / (actors.length * activities.length)) % subjects.length]}. ${
      contexts[(index * 5 + Math.floor(index / 7)) % contexts.length]
    }. Evaluation record ${index + 1}.`,
    source: {
      application: applications[index % applications.length],
      author: actors[(index * 7) % actors.length],
      label: `Evaluation distractor ${index + 1}`,
      timestamp: new Date(Date.UTC(
        2024 + (index % 3),
        index % 12,
        1 + (index % 28),
        index % 24,
      )).toISOString(),
    },
  }));
}

export function validCitation(result: RecallResult): boolean {
  const excerpt = result.citation.excerpt.trim();
  return (
    result.citation.noteId === result.note.id &&
    result.citation.revision === result.note.revision &&
    excerpt.length > 0 &&
    excerptFragmentsMatch(result.note.content, excerpt)
  );
}

function excerptFragmentsMatch(content: string, excerpt: string): boolean {
  const fragments = excerpt
    .split("…")
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return false;

  let offset = 0;
  for (const fragment of fragments) {
    const index = content.indexOf(fragment, offset);
    if (index < 0) return false;
    offset = index + fragment.length;
  }
  return true;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return Number((numerator / denominator).toFixed(6));
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
}
