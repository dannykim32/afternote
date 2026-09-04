import { describe, expect, it } from "bun:test";
import { runOrganizationEvaluation } from "./organization-eval";

describe("organization and retrieval scale gate", () => {
  it("exercises public reads without duplicating the release-scale run", async () => {
    const report = await runOrganizationEvaluation("2.0.0-test", {
      noteCount: 500,
    });
    expect(report.corpus.noteCount).toBe(500);
    expect(report.corpus).toMatchObject({
      revisionCount: 700,
      contentCharacters: 534,
    });
    expect(report.checks).toMatchObject({
      noteCount: true,
      revisionCount: true,
      currentContentShape: true,
      overviewContainsExpectedFacets: true,
      facetBrowseReturnsExpectedNotes: true,
      dateBrowseReturnsExpectedNotes: true,
      recallReturnsCurrentRevision: true,
      staleRevisionExcluded: true,
      searchReturnsCurrentRevision: true,
      searchCursorStable: true,
      editRefilesCurrentRevision: true,
      previousRevisionPhrasesRemoved: true,
      previousFacetsRemoved: true,
      agentRecallSurvivesSemanticFailure: true,
      librarySearchSurvivesSemanticFailure: true,
    });
    expect(report.retrieval).toMatchObject({
      mode: "sqlite-fts5",
      recallResultRevision: 3,
      searchResultRevision: 3,
      editedResultRevision: 4,
      degradedSearchMode: "degraded",
      degradedRecallResultRevision: 4,
      degradedSearchResultRevision: 4,
    });
    expect(report.storage.lexicalDatabaseBytes).toBeLessThanOrEqual(
      40 * 1024 * 1024,
    );
    expect(report.storage.lexicalRevisionCount).toBe(700);
    expect(report.storage.encrypted).toBe(true);
    expect(report.passed).toBe(true);
  }, 30_000);
});
