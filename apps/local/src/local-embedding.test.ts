import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  acquireLocalEmbeddingModel,
  localEmbeddingStatus,
  selectedSemanticProfile, semanticModelCatalog,
} from "./local-embedding";
import { LOCAL_EMBEDDING_MODEL } from "./transformers-embedding";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local embedding installation", () => {
  it("recommends a local profile without downloading and preserves an earlier explicit choice", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-catalog-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    const catalog = semanticModelCatalog(vaultPath);
    expect(catalog.selected).toBe("balanced");
    expect(catalog.models.map((model) => model.key)).toEqual(["light", "balanced", "large"]);
    expect(catalog.models.every((model) => model.state === "not-installed")).toBe(true);
    expect(existsSync(join(directory, "models"))).toBe(false);
    mkdirSync(join(directory, "models"));
    writeFileSync(join(directory, "models/selection.json"), JSON.stringify({version: 1, profile: "large"}));
    expect(selectedSemanticProfile(vaultPath)).toBe("large");
  });

  it("rejects unknown, oversized and symlinked selections before loading or fetching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-selection-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    mkdirSync(join(directory, "models"));
    const selection = join(directory, "models/selection.json");
    for (const contents of ['{"version":1,"profile":"remote"}', ' '.repeat(257), 'null']) {
      writeFileSync(selection, contents);
      expect(() => selectedSemanticProfile(vaultPath)).toThrow();
    }
    rmSync(selection);
    writeFileSync(join(directory, "outside"), '{"version":1,"profile":"light"}');
    symlinkSync(join(directory, "outside"), selection);
    expect(() => selectedSemanticProfile(vaultPath)).toThrow("could not be read");
    let requests = 0;
    await expect(acquireLocalEmbeddingModel(vaultPath, {
      profile: "remote" as "light", fetch: async () => { requests++; return new Response(""); },
    })).rejects.toThrow("must be light, balanced, or large");
    expect(requests).toBe(0);
  });

  it("keeps the selected model after a failed switch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-failure-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    mkdirSync(join(directory, "models"));
    writeFileSync(join(directory, "models/selection.json"), '{"version":1,"profile":"light"}');
    await expect(acquireLocalEmbeddingModel(vaultPath, { profile: "large", fetch: async () => new Response("bad") })).rejects.toThrow();
    expect(selectedSemanticProfile(vaultPath)).toBe("light");
  });

  it("distinguishes an absent model from a partial or tampered installation", () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-status-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    expect(localEmbeddingStatus(vaultPath)).toMatchObject({
      state: "not-installed",
      bytes: 0,
      reason: null,
    });

    const snapshot = join(
      directory,
      "models",
      LOCAL_EMBEDDING_MODEL.id,
      LOCAL_EMBEDDING_MODEL.revision,
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "config.json"), "tampered");
    expect(localEmbeddingStatus(vaultPath)).toMatchObject({
      state: "invalid",
      reason: "model checksum failed: config.json",
    });
  });

  it("rejects unverified downloads before publishing or loading a model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "afternote-model-download-"));
    directories.push(directory);
    const vaultPath = join(directory, "vault.db");
    let requests = 0;

    await expect(
      acquireLocalEmbeddingModel(vaultPath, {
        fetch: (async () => {
          requests += 1;
          return new Response("tampered", { status: 200 });
        }),
      }),
    ).rejects.toThrow("failed verification: config.json");

    expect(requests).toBe(1);
    expect(localEmbeddingStatus(vaultPath).state).toBe("not-installed");
  });
});
