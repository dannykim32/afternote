import { describe, expect, it } from "bun:test";
import { SqliteMemory } from "./sqlite-memory";
import type { TextEmbeddingModel, TextReranker } from "./retrieval";

const vault = { vaultId: "b".repeat(64), deployment: "local" as const };
function model(score: TextReranker["score"]): TextEmbeddingModel {
  return {
    descriptor: { id: "rerank-fixture", revision: "1", dimensions: 2 },
    minimumSimilarity: 0.4, uiMinimumSimilarity: 0.25,
    embed: async (texts) => texts.map(() => new Float32Array([0.25, Math.sqrt(1 - 0.25 ** 2)])),
    embedQuery: async () => new Float32Array([1, 0]),
    reranker: { id: "reranker-v1", minimumScore: 3, score },
  };
}

describe("reranked local recall", () => {
  it("rescues low-similarity paraphrases and rejects keyword decoys in agent and UI search", async () => {
    const good = "The freight elevator must be reserved before moving furniture.";
    const decoy = "The sofa upholstery is blue. Upstairs windows were cleaned yesterday.";
    const query = "How do I get the sofa upstairs?";
    const memory = new SqliteMemory(":memory:", vault, {
      retrievalMode: "hybrid", embeddingModel: model(async (_, passages) => passages.map(p => p.includes("freight") ? 7 : -2)),
    });
    try {
      const note = await memory.remember(vault, { content: good });
      await memory.remember(vault, { content: decoy });
      await memory.waitForDerivedIndex();
      expect(await memory.recall(vault, query, 5)).toMatchObject([{ note: { id: note.id } }]);
      expect((await memory.recall(vault, query, 5)).length).toBe(1);
      expect((await memory.searchNotes(vault, { query, limit: 5 })).results).toMatchObject([{ note: { id: note.id } }]);
      expect((await memory.searchNotes(vault, { query, limit: 5 })).results.length).toBe(1);
    } finally { memory.close(); }
  });

  it("preserves literal identifiers and pagination even when the reranker rejects them", async () => {
    const memory = new SqliteMemory(":memory:", vault, { retrievalMode: "hybrid", embeddingModel: model(async (_, p) => p.map(() => -5)) });
    try {
      for (let i = 0; i < 45; i++) await memory.remember(vault, { content: `Reference AZ-1842 has entry ${i}.` });
      await memory.waitForDerivedIndex();
      const ids = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await memory.searchNotes(vault, { query: "AZ-1842", limit: 20, cursor });
        page.results.forEach(r => ids.add(r.note.id)); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids.size).toBe(45);
      expect(await memory.recall(vault, "What is the jewelry safe combination?", 5)).toEqual([]);
    } finally { memory.close(); }
  });

  it.each(["delete", "edit", "switch", "close"])("discards stale results when a %s happens during scoring", async (action) => {
    let started!: () => void, release!: () => void;
    const begun = new Promise<void>(r => { started = r; });
    const blocked = new Promise<void>(r => { release = r; });
    const memory = new SqliteMemory(":memory:", vault, { retrievalMode: "hybrid", embeddingModel: model(async (_, p) => { started(); await blocked; return p.map(() => 8); }) });
    try {
      const note = await memory.remember(vault, { content: "The freight elevator must be reserved." });
      await memory.waitForDerivedIndex();
      const recall = memory.recall(vault, "How can furniture reach the upper floor?", 5);
      await begun;
      if (action === "delete") await memory.forget(vault, note.id);
      if (action === "edit") await memory.updateNote(vault, note.id, { content: "The reservation was cancelled.", expectedRevision: 1 });
      if (action === "switch") {
        const replacement = model(async (_, p) => p.map(() => 8));
        replacement.descriptor.revision = "2";
        memory.enableSemanticSearch(vault, replacement);
      }
      if (action === "close") memory.close();
      release();
      expect(await recall).toEqual([]);
    } finally { release?.(); memory.close(); }
  });

  it.each(["throw", "shape", "nan"])("falls back to literal evidence on %s scoring failures", async (failure) => {
    const memory = new SqliteMemory(":memory:", vault, { retrievalMode: "hybrid", embeddingModel: model(async (_, p) => {
      if (failure === "throw") throw new Error("unavailable");
      return failure === "shape" ? [] : p.map(() => Number.NaN);
    }) });
    try {
      const note = await memory.remember(vault, { content: "The parcel code is AZ-1842." });
      await memory.waitForDerivedIndex();
      expect(await memory.recall(vault, "building entry details", 5)).toEqual([]);
      expect(await memory.recall(vault, "AZ-1842", 5)).toMatchObject([{ note: { id: note.id } }]);
    } finally { memory.close(); }
  });
});
