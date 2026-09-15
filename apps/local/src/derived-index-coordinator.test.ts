import { describe, expect, it } from "bun:test";
import { DerivedIndexCoordinator } from "./derived-index-coordinator";

type IndexedNote = { id: string };

describe("derived-index coordinator interface", () => {
  it("updates synchronous projections before scheduling semantic work", async () => {
    const events: string[] = [];
    const coordinator = new DerivedIndexCoordinator<IndexedNote>({
      model: { id: "fixture", revision: "1", dimensions: 2 },
      rebuildSynchronous: () => events.push("rebuild"),
      replaceSynchronous: (note) => events.push(`replace:${note.id}`),
      missingSemanticNotes: () => [],
      indexSemanticNotes: async (notes) => {
        events.push(`semantic:${notes.map((note) => note.id).join(",")}`);
      },
      totalNotes: () => 1,
      indexedNotes: () => 1,
    });

    coordinator.replace({ id: "note-1" });
    expect(events).toEqual(["replace:note-1"]);
    await coordinator.wait();
    expect(events).toEqual(["replace:note-1", "semantic:note-1"]);
  });

  it("does not schedule semantic work when a synchronous projection fails", async () => {
    let semanticRuns = 0;
    const coordinator = new DerivedIndexCoordinator<IndexedNote>({
      model: { id: "fixture", revision: "1", dimensions: 2 },
      rebuildSynchronous: () => undefined,
      replaceSynchronous: () => {
        throw new Error("projection failed");
      },
      missingSemanticNotes: () => [],
      indexSemanticNotes: async () => {
        semanticRuns += 1;
      },
      totalNotes: () => 1,
      indexedNotes: () => 0,
    });

    expect(() => coordinator.replace({ id: "note-1" })).toThrow("projection failed");
    await coordinator.wait();
    expect(semanticRuns).toBe(0);
  });

  it("commits a large rebuild in bounded batches and stops retired work between batches", async () => {
    const notes = Array.from({length: 100}, (_, index) => ({id: `note-${index}`}));
    const sizes: number[] = [];
    let indexed = 0;
    const coordinator = new DerivedIndexCoordinator<IndexedNote>({
      model: {id: "fixture", revision: "1", dimensions: 2},
      rebuildSynchronous: () => undefined, replaceSynchronous: () => undefined,
      missingSemanticNotes: () => notes,
      indexSemanticNotes: async (batch) => {
        sizes.push(batch.length); indexed += batch.length;
        expect(coordinator.status().indexedNotes).toBe(indexed);
        if (sizes.length === 2) coordinator.close();
      },
      totalNotes: () => notes.length, indexedNotes: () => indexed,
    });
    coordinator.initialize(); await coordinator.wait();
    expect(sizes).toEqual([32, 32]);
    expect(indexed).toBe(64);
  });

  it("reports disabled, indexing, ready, and degraded states from one owner", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let indexedNotes = 0;
    const coordinator = new DerivedIndexCoordinator<IndexedNote>({
      model: { id: "fixture", revision: "1", dimensions: 2 },
      rebuildSynchronous: () => undefined,
      replaceSynchronous: () => undefined,
      missingSemanticNotes: () => [],
      indexSemanticNotes: async () => pending,
      totalNotes: () => 1,
      indexedNotes: () => indexedNotes,
    });

    coordinator.replace({ id: "note-1" });
    expect(coordinator.status().state).toBe("indexing");
    indexedNotes = 1;
    release?.();
    await coordinator.wait();
    expect(coordinator.status()).toMatchObject({ state: "ready", staleNotes: 0 });

    const degraded = new DerivedIndexCoordinator<IndexedNote>({
      model: { id: "fixture", revision: "1", dimensions: 2 },
      rebuildSynchronous: () => undefined,
      replaceSynchronous: () => undefined,
      missingSemanticNotes: () => [],
      indexSemanticNotes: async () => {
        throw new Error("model unavailable");
      },
      totalNotes: () => 1,
      indexedNotes: () => 0,
    });
    degraded.replace({ id: "note-2" });
    await degraded.wait();
    expect(degraded.status()).toMatchObject({
      state: "degraded",
      lastError: "model unavailable",
    });

    const disabled = new DerivedIndexCoordinator<IndexedNote>({
      model: null,
      rebuildSynchronous: () => undefined,
      replaceSynchronous: () => undefined,
      missingSemanticNotes: () => [],
      indexSemanticNotes: async () => undefined,
      totalNotes: () => 1,
      indexedNotes: () => 0,
    });
    expect(disabled.status().state).toBe("disabled");
  });
});
