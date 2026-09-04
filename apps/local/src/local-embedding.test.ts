import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  acquireLocalEmbeddingModel,
  localEmbeddingStatus,
} from "./local-embedding";
import { LOCAL_EMBEDDING_MODEL } from "./transformers-embedding";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local embedding installation", () => {
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
