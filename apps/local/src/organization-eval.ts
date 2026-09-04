import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallResult, VaultContext } from "@afternote/memory";
import { writeInterchange, type StreamingInterchangeNote } from "./interchange";
import { privateDatabaseBytes } from "./diagnostics";
import type { TextEmbeddingModel } from "./retrieval";
import { SqliteMemory } from "./sqlite-memory";

const RELEASE_NOTE_COUNT = 10_000;
const EVALUATION_CONTENT_CHARACTERS = 534;
const EVALUATION_TIMESTAMP = "2026-01-01T12:00:00.000Z";
const EVALUATION_NOW = new Date(EVALUATION_TIMESTAMP);
const EVALUATION_ENCRYPTION_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);
const VERSIONED_NOTE_INTERVAL = 5;
const PREVIOUS_REVISIONS_PER_VERSIONED_NOTE = 2;
const INITIAL_REVISION = 1;
const VERSIONED_CURRENT_REVISION =
  INITIAL_REVISION + PREVIOUS_REVISIONS_PER_VERSIONED_NOTE;
const EDITED_CURRENT_REVISION = VERSIONED_CURRENT_REVISION + 1;
const CURSOR_CANARY_QUERY = "cursorcanary";
const CURSOR_CANARY_NOTE_COUNT = 50;
const FAILURE_FALLBACK_QUERY = "archive delta";
const FAILURE_FALLBACK_CONTENT =
  `The scale retrieval canary moved to ${FAILURE_FALLBACK_QUERY}.`;
const EVALUATION_VAULT: VaultContext = {
  vaultId: "o".repeat(64),
  deployment: "local",
};
const THRESHOLDS = {
  organizeMs: 10_000,
  overviewMs: 500,
  facetBrowseMs: 100,
  dateBrowseMs: 100,
  recallMs: 100,
  searchMs: 100,
  cursorPageMs: 100,
  editRefileMs: 250,
  degradedIndexMs: 10_000,
  degradedRecallMs: 100,
  degradedSearchMs: 250,
  lexicalDatabaseBytes: 40 * 1024 * 1024,
  indexedDatabaseBytes: 64 * 1024 * 1024,
} as const;

const PEOPLE = [
  "Maya Chen",
  "Elena Rivera",
  "Jordan Lee",
  "Noah Williams",
  "Priya Shah",
] as const;
const SOURCES = ["Team Chat", "Claude Code", "Codex", "Mail", "Afternote Local"] as const;
const TOPICS = ["rollout", "security", "billing", "design", "reliability"] as const;

export async function runOrganizationEvaluation(
  applicationVersion: string,
  options: { noteCount?: number } = {},
) {
  const noteCount = options.noteCount ?? RELEASE_NOTE_COUNT;
  if (!Number.isInteger(noteCount) || noteCount < 1 || noteCount > RELEASE_NOTE_COUNT) {
    throw new Error(`Organization evaluation noteCount must be 1-${RELEASE_NOTE_COUNT}`);
  }
  const directory = mkdtempSync(join(tmpdir(), "afternote-organization-eval-"));
  const interchangePath = join(directory, "corpus.afternote.json");
  const databasePath = join(directory, "vault.db");
  let memory: SqliteMemory | undefined;
  try {
    writeOrganizationInterchange(interchangePath, applicationVersion, noteCount);
    SqliteMemory.restoreInterchange(
      interchangePath,
      databasePath,
      EVALUATION_VAULT,
      applicationVersion,
      { encryptionKey: EVALUATION_ENCRYPTION_KEY },
    );

    const organizeStartedAt = performance.now();
    memory = new SqliteMemory(databasePath, EVALUATION_VAULT, {
      encryptionKey: EVALUATION_ENCRYPTION_KEY,
    });
    const organizeMs = performance.now() - organizeStartedAt;

    const overviewStartedAt = performance.now();
    const overview = memory.organizationOverview(EVALUATION_VAULT, EVALUATION_NOW);
    const overviewMs = performance.now() - overviewStartedAt;

    const facetStartedAt = performance.now();
    const facetPage = await memory.browseOrganizationFacet(
      EVALUATION_VAULT,
      { kind: "people", key: "maya chen" },
      { limit: 50 },
      EVALUATION_NOW,
    );
    const facetBrowseMs = performance.now() - facetStartedAt;

    const dateStartedAt = performance.now();
    const datePage = await memory.browseOrganizationFacet(
      EVALUATION_VAULT,
      { kind: "dates", key: "today" },
      { limit: 50 },
      EVALUATION_NOW,
    );
    const dateBrowseMs = performance.now() - dateStartedAt;

    const currentContentShape = await verifyCurrentContentShape(memory, noteCount);
    const pristineDiagnostics = memory.diagnosticSnapshot(EVALUATION_VAULT);
    const lexicalDatabaseBytes = privateDatabaseBytes(databasePath);

    const retrievalProbe = await runLexicalRetrievalProbe(memory);
    const {
      targetId,
      recallResults,
      searchResults,
      firstSearchPage,
      secondSearchPage,
      edited,
      editedResults,
      editedOverview,
      staleRecallAfterEdit,
      currentRecallAfterEdit,
      currentSearchAfterEdit,
      staleSearchAfterEdit,
      recallMs,
      searchMs,
      cursorPageMs,
      editRefileMs,
    } = retrievalProbe;
    const postProbeDiagnostics = memory.diagnosticSnapshot(EVALUATION_VAULT);
    memory.close();
    memory = undefined;
    const failureProbe = await runSemanticFailureProbe(
      databasePath,
      EVALUATION_ENCRYPTION_KEY,
    );
    const expectedFacetCount = Math.ceil(noteCount / PEOPLE.length);
    const expectedRevisionCount = evaluationRevisionCount(noteCount);
    const recallTarget = recallResults.find((result) => result.note.id === targetId);
    const searchTarget = searchResults.results.find(
      (result) => result.note.id === targetId,
    );
    const editedTarget = editedResults.results.find(
      (result) => result.note.id === targetId,
    );
    const firstPageIds = new Set(
      firstSearchPage.results.map((result) => result.note.id),
    );
    const staleRecallTargetRemoved = !staleRecallAfterEdit.some(
      (result) => result.note.id === targetId,
    );
    const checks = {
      noteCount:
        pristineDiagnostics.noteCount === noteCount &&
        postProbeDiagnostics.noteCount === noteCount,
      revisionCount:
        pristineDiagnostics.revisionCount === expectedRevisionCount &&
        postProbeDiagnostics.revisionCount === expectedRevisionCount + 1,
      currentContentShape,
      overviewContainsExpectedFacets:
        overview.people.some(
          (facet) =>
            facet.key === "maya chen" && facet.noteCount === expectedFacetCount,
        ) &&
        overview.sources.some(
          (facet) => facet.key === "team chat" && facet.noteCount === expectedFacetCount,
        ) &&
        overview.topics.some(
          (facet) => facet.key === "rollout" && facet.noteCount === expectedFacetCount,
        ) &&
        overview.dates.some(
          (facet) => facet.key === "today" && facet.noteCount === noteCount,
        ),
      facetBrowseReturnsExpectedNotes:
        facetPage.notes.length === 50 &&
        facetPage.notes.every(
          (note) => note.source?.author === "Maya Chen",
        ),
      dateBrowseReturnsExpectedNotes: datePage.notes.length === 50,
      recallReturnsCurrentRevision:
        recallTarget?.note.revision === VERSIONED_CURRENT_REVISION &&
        recallTarget.citation.revision === VERSIONED_CURRENT_REVISION,
      staleRevisionExcluded: staleRecallTargetRemoved,
      searchReturnsCurrentRevision:
        searchTarget?.note.revision === VERSIONED_CURRENT_REVISION &&
        searchTarget.citation.revision === VERSIONED_CURRENT_REVISION,
      searchCursorStable:
        firstSearchPage.results.length === 20 &&
        firstSearchPage.nextCursor !== null &&
        secondSearchPage.results.length === 20 &&
        secondSearchPage.results.every(
          (result) => !firstPageIds.has(result.note.id),
        ),
      editRefilesCurrentRevision:
        edited.revision === EDITED_CURRENT_REVISION &&
        editedTarget?.note.revision === EDITED_CURRENT_REVISION &&
        editedTarget.citation.revision === EDITED_CURRENT_REVISION &&
        editedOverview.people.some(
          (facet) => facet.key === "morgan vale" && facet.noteCount === 1,
        ),
      previousRevisionPhrasesRemoved:
        !currentSearchAfterEdit.results.some(
          (result) => result.note.id === targetId,
        ) &&
        !staleSearchAfterEdit.results.some(
          (result) => result.note.id === targetId,
        ) &&
        !currentRecallAfterEdit.some((result) => result.note.id === targetId) &&
        staleRecallTargetRemoved,
      previousFacetsRemoved:
        editedOverview.people.some(
          (facet) =>
            facet.key === "maya chen" &&
            facet.noteCount === expectedFacetCount - 1,
        ) &&
        editedOverview.sources.some(
          (facet) =>
            facet.key === "team chat" &&
            facet.noteCount === expectedFacetCount - 1,
        ) &&
        editedOverview.sources.some(
          (facet) =>
            facet.key === "afternote local" &&
            facet.noteCount === expectedFacetCount + 1,
        ),
      agentRecallSurvivesSemanticFailure:
        failureProbe.indexState === "ready" &&
        isExactFallbackResult(failureProbe.recallTarget, targetId),
      librarySearchSurvivesSemanticFailure:
        failureProbe.searchMode === "degraded" &&
        isExactFallbackResult(failureProbe.searchTarget, targetId),
    };
    const latency = {
      organizeMs,
      overviewMs,
      facetBrowseMs,
      dateBrowseMs,
      recallMs,
      searchMs,
      cursorPageMs,
      editRefileMs,
      degradedIndexMs: failureProbe.indexMs,
      degradedRecallMs: failureProbe.recallMs,
      degradedSearchMs: failureProbe.searchMs,
    };
    const gates = {
      organize: organizeMs < THRESHOLDS.organizeMs,
      overview: overviewMs < THRESHOLDS.overviewMs,
      facetBrowse: facetBrowseMs < THRESHOLDS.facetBrowseMs,
      dateBrowse: dateBrowseMs < THRESHOLDS.dateBrowseMs,
      recall: recallMs < THRESHOLDS.recallMs,
      search: searchMs < THRESHOLDS.searchMs,
      cursorPage: cursorPageMs < THRESHOLDS.cursorPageMs,
      editRefile: editRefileMs < THRESHOLDS.editRefileMs,
      degradedIndex: failureProbe.indexMs < THRESHOLDS.degradedIndexMs,
      degradedRecall: failureProbe.recallMs < THRESHOLDS.degradedRecallMs,
      degradedSearch: failureProbe.searchMs < THRESHOLDS.degradedSearchMs,
      lexicalDatabaseSize:
        lexicalDatabaseBytes <= THRESHOLDS.lexicalDatabaseBytes,
      indexedDatabaseSize:
        failureProbe.databaseBytes < THRESHOLDS.indexedDatabaseBytes,
    };
    return {
      format: "afternote-organization-eval",
      schemaVersion: 1,
      corpus: {
        id: "automatic-organization-scale",
        version: 3,
        noteCount,
        revisionCount: expectedRevisionCount,
        contentCharacters: EVALUATION_CONTENT_CHARACTERS,
      },
      thresholds: THRESHOLDS,
      latency,
      databaseBytes: failureProbe.databaseBytes,
      storage: {
        lexicalDatabaseBytes,
        lexicalRevisionCount: pristineDiagnostics.revisionCount,
        encrypted: true,
        indexedDatabaseBytes: failureProbe.databaseBytes,
      },
      retrieval: {
        mode: "sqlite-fts5",
        recallResultRevision: recallTarget?.note.revision ?? null,
        searchResultRevision: searchTarget?.note.revision ?? null,
        editedResultRevision: editedTarget?.note.revision ?? null,
        degradedSearchMode: failureProbe.searchMode,
        degradedRecallResultRevision:
          failureProbe.recallTarget?.note.revision ?? null,
        degradedSearchResultRevision:
          failureProbe.searchTarget?.note.revision ?? null,
      },
      overview,
      checks,
      gates,
      passed: Object.values(checks).every(Boolean) && Object.values(gates).every(Boolean),
    } as const;
  } finally {
    memory?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function verifyCurrentContentShape(
  memory: SqliteMemory,
  expectedNoteCount: number,
): Promise<boolean> {
  let cursor: string | undefined;
  let observedNoteCount = 0;
  do {
    const page = await memory.browseNotes(EVALUATION_VAULT, {
      limit: 100,
      cursor,
    });
    if (
      page.notes.some(
        (note) => note.content.length !== EVALUATION_CONTENT_CHARACTERS,
      )
    ) {
      return false;
    }
    observedNoteCount += page.notes.length;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return observedNoteCount === expectedNoteCount;
}

async function runSemanticFailureProbe(
  databasePath: string,
  encryptionKey: Uint8Array,
) {
  const targetId = evaluationNoteId(0);
  const memory = new SqliteMemory(databasePath, EVALUATION_VAULT, {
    embeddingModel: new QueryFailingEmbeddingModel(FAILURE_FALLBACK_QUERY),
    retrievalMode: "hybrid",
    encryptionKey,
    now: () => EVALUATION_NOW,
    timeZone: "UTC",
  });
  try {
    const indexStartedAt = performance.now();
    await memory.waitForDerivedIndex();
    const indexMs = performance.now() - indexStartedAt;
    const indexState = memory.derivedIndexStatus(EVALUATION_VAULT).state;

    const recallStartedAt = performance.now();
    const recallResults = await memory.recall(
      EVALUATION_VAULT,
      FAILURE_FALLBACK_QUERY,
      5,
    );
    const recallMs = performance.now() - recallStartedAt;

    const searchStartedAt = performance.now();
    const search = await memory.searchNotesWithDeadline(
      EVALUATION_VAULT,
      { query: FAILURE_FALLBACK_QUERY, limit: 5 },
      500,
    );
    const searchMs = performance.now() - searchStartedAt;
    return {
      indexState,
      indexMs,
      recallMs,
      searchMs,
      searchMode: search.searchMode,
      databaseBytes: memory.diagnosticSnapshot(EVALUATION_VAULT).databaseBytes,
      recallTarget: recallResults.find((result) => result.note.id === targetId),
      searchTarget: search.results.find((result) => result.note.id === targetId),
    };
  } finally {
    memory.close();
  }
}

function isExactFallbackResult(
  result: RecallResult | undefined,
  targetId: string,
): boolean {
  return result?.note.id === targetId &&
    result.note.revision === EDITED_CURRENT_REVISION &&
    result.citation.noteId === targetId &&
    result.citation.revision === EDITED_CURRENT_REVISION &&
    result.citation.excerpt.includes(FAILURE_FALLBACK_QUERY);
}

class QueryFailingEmbeddingModel implements TextEmbeddingModel {
  readonly descriptor = {
    id: "scale-gate-query-failure",
    revision: "1",
    dimensions: 1,
  };
  readonly minimumSimilarity = 0.1;

  constructor(private readonly failingQuery: string) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (
      texts.length === 1 &&
      texts[0]?.trim().toLowerCase() === this.failingQuery
    ) {
      throw new Error("Synthetic local embedding query failure");
    }
    return texts.map(() => Float32Array.of(1));
  }
}

async function runLexicalRetrievalProbe(memory: SqliteMemory) {
  const targetId = evaluationNoteId(0);
  const recallStartedAt = performance.now();
  const recallResults = await memory.recall(
    EVALUATION_VAULT,
    "currentrevisionsentinel",
    5,
  );
  const recallMs = performance.now() - recallStartedAt;

  const searchStartedAt = performance.now();
  const searchResults = await memory.searchNotes(EVALUATION_VAULT, {
    query: "currentrevisionsentinel",
    limit: 5,
  });
  const searchMs = performance.now() - searchStartedAt;

  const firstCursorStartedAt = performance.now();
  const firstSearchPage = await memory.searchNotes(EVALUATION_VAULT, {
    query: CURSOR_CANARY_QUERY,
    limit: 20,
  });
  const firstCursorPageMs = performance.now() - firstCursorStartedAt;
  const secondCursorStartedAt = performance.now();
  const secondSearchPage = await memory.searchNotes(EVALUATION_VAULT, {
    query: CURSOR_CANARY_QUERY,
    limit: 20,
    cursor: firstSearchPage.nextCursor ?? undefined,
  });
  const secondCursorPageMs = performance.now() - secondCursorStartedAt;
  const cursorPageMs = Math.max(firstCursorPageMs, secondCursorPageMs);

  const editStartedAt = performance.now();
  const edited = await memory.updateNote(EVALUATION_VAULT, targetId, {
    content: evaluationContent(FAILURE_FALLBACK_CONTENT, 0),
    expectedRevision: VERSIONED_CURRENT_REVISION,
    source: {
      application: "Afternote Local",
      author: "Morgan Vale",
      label: "Archive delta",
    },
  });
  const editedResults = await memory.searchNotes(EVALUATION_VAULT, {
    query: FAILURE_FALLBACK_QUERY,
    limit: 5,
  });
  const editedOverview = memory.organizationOverview(
    EVALUATION_VAULT,
    EVALUATION_NOW,
  );
  const editRefileMs = performance.now() - editStartedAt;

  const staleRecallAfterEdit = await memory.recall(
    EVALUATION_VAULT,
    "retiredrevisionsentinel",
    5,
  );
  const currentRecallAfterEdit = await memory.recall(
    EVALUATION_VAULT,
    "currentrevisionsentinel",
    5,
  );
  const currentSearchAfterEdit = await memory.searchNotes(EVALUATION_VAULT, {
    query: "currentrevisionsentinel",
    limit: 5,
  });
  const staleSearchAfterEdit = await memory.searchNotes(EVALUATION_VAULT, {
    query: "retiredrevisionsentinel",
    limit: 5,
  });
  return {
    targetId,
    recallResults,
    searchResults,
    firstSearchPage,
    secondSearchPage,
    edited,
    editedResults,
    editedOverview,
    staleRecallAfterEdit,
    currentRecallAfterEdit,
    currentSearchAfterEdit,
    staleSearchAfterEdit,
    recallMs,
    searchMs,
    cursorPageMs,
    editRefileMs,
  };
}

function writeOrganizationInterchange(
  path: string,
  applicationVersion: string,
  noteCount: number,
): void {
  const notes = function* (): Iterable<StreamingInterchangeNote> {
    for (let index = 0; index < noteCount; index += 1) {
      const id = evaluationNoteId(index);
      const person = PEOPLE[index % PEOPLE.length]!;
      const source = SOURCES[index % SOURCES.length]!;
      const topic = TOPICS[index % TOPICS.length]!;
      const contentPrefix = index === 0
          ? "The currentrevisionsentinel scale retrieval canary belongs to the Atlas rollout."
          : `${person} saved the Atlas ${topic} checkpoint ${index + 1}. Follow-up evidence remains explicit.`;
      const content = evaluationContent(
        `${index < CURSOR_CANARY_NOTE_COUNT ? `${CURSOR_CANARY_QUERY} ` : ""}${contentPrefix}`,
        index,
      );
      const hasPreviousRevisions = index % VERSIONED_NOTE_INTERVAL === 0;
      yield {
        id,
        currentRevision: hasPreviousRevisions
          ? VERSIONED_CURRENT_REVISION
          : INITIAL_REVISION,
        createdAt: EVALUATION_TIMESTAMP,
        updatedAt: EVALUATION_TIMESTAMP,
        revisions: function* () {
          if (hasPreviousRevisions) {
            for (
              let revisionOffset = 0;
              revisionOffset < PREVIOUS_REVISIONS_PER_VERSIONED_NOTE;
              revisionOffset += 1
            ) {
              const revision = INITIAL_REVISION + revisionOffset;
              yield {
                noteId: id,
                revision,
                content: evaluationContent(
                  index === 0
                    ? `The retiredrevisionsentinel revision ${revision} belonged to the retired plan.`
                    : `${person} saved obsolete revision ${revision} of ${topic} checkpoint ${index + 1}.`,
                  index,
                ),
                source: {
                  application: source,
                  author: person,
                  label: `Obsolete ${topic}`,
                },
                createdAt: EVALUATION_TIMESTAMP,
              };
            }
          }
          yield {
            noteId: id,
            revision: hasPreviousRevisions
              ? VERSIONED_CURRENT_REVISION
              : INITIAL_REVISION,
            content,
            source: {
              application: source,
              author: person,
              label: `Atlas ${topic}`,
            },
            createdAt: EVALUATION_TIMESTAMP,
          };
        },
      };
    }
  };
  writeInterchange(
    path,
    notes,
    noteCount,
    evaluationRevisionCount(noteCount),
    applicationVersion,
  );
}

function evaluationNoteId(index: number): string {
  return `00000000-0000-4000-a000-${index.toString().padStart(12, "0")}`;
}

function evaluationRevisionCount(noteCount: number): number {
  return noteCount +
    Math.ceil(noteCount / VERSIONED_NOTE_INTERVAL) *
      PREVIOUS_REVISIONS_PER_VERSIONED_NOTE;
}

function evaluationContent(prefix: string, index: number): string {
  const filler = ` and the of to in for on with at by from as is was are be this that it ${index}.`;
  const repeated = prefix + filler.repeat(
    Math.ceil((EVALUATION_CONTENT_CHARACTERS - prefix.length) / filler.length),
  );
  return repeated.slice(0, EVALUATION_CONTENT_CHARACTERS);
}
