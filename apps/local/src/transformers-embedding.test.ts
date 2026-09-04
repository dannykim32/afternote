import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { runTextOnlyTransformersCompile } from "../../../scripts/build-local-alpha";

const directory = mkdtempSync(join(tmpdir(), "afternote-transformers-model-"));
const directories = [directory];

afterAll(() => {
  for (const path of directories) rmSync(path, { recursive: true, force: true });
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

    it("installs and opens the pinned model through the compiled release runtime", async () => {
      const runtimeDirectory = mkdtempSync(join(tmpdir(), "afternote-compiled-semantic-"));
      directories.push(runtimeDirectory);
      const executable = join(runtimeDirectory, "afternote-semantic-check");
      runTextOnlyTransformersCompile([
        process.execPath,
        "build",
        "--compile",
        "--target=bun-darwin-arm64",
        "--no-compile-autoload-dotenv",
        "--no-compile-autoload-bunfig",
        join(import.meta.dir, "compiled-semantic.fixture.ts"),
        `--outfile=${executable}`,
      ]);
      chmodSync(executable, 0o755);
      const transformers = Bun.resolveSync("@huggingface/transformers", import.meta.dir);
      const packageRoot = dirname(dirname(Bun.resolveSync(
        "onnxruntime-node",
        dirname(transformers),
      )));
      for (const name of ["onnxruntime_binding.node", "libonnxruntime.1.21.0.dylib"]) {
        copyFileSync(
          join(packageRoot, "bin/napi-v3/darwin/arm64", name),
          join(runtimeDirectory, name),
        );
      }
      const stateDirectory = join(runtimeDirectory, "state");
      mkdirSync(stateDirectory, { recursive: true });
      const subprocess = Bun.spawn([executable], {
        env: {
          ...process.env,
          AFTERNOTE_TEST_VAULT_PATH: join(stateDirectory, "vault.db"),
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
      expect(JSON.parse(stdout)).toMatchObject({ state: "ready", dimensions: 384 });
    }, 120_000);
  },
);
