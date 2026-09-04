import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

const directory = mkdtempSync(join(tmpdir(), "afternote-transformers-model-"));

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.env.AFTERNOTE_TEST_REMOTE_MODELS !== "1")(
  "TransformersTextEmbeddingModel",
  () => {
    it("runs a pinned sentence embedding locally after model acquisition", async () => {
      const subprocess = Bun.spawn([
        process.execPath,
        "run",
        join(import.meta.dir, "transformers-embedding.fixture.ts"),
      ], {
        env: {
          ...process.env,
          AFTERNOTE_EMBEDDING_CACHE: directory,
          AFTERNOTE_ALLOW_REMOTE_MODELS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const result = JSON.parse(stdout) as {
        dimensions: number[];
        related: number;
        unrelated: number;
      };

      expect(result.dimensions).toEqual([384, 384, 384]);
      expect(result.related).toBeGreaterThan(result.unrelated);
    }, 120_000);
  },
);
