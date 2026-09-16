import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "bun:test";
import { runTextOnlyTransformersCompile } from "../../../scripts/build-local-alpha";

it.skipIf(!process.env.AFTERNOTE_TEST_MODEL_DIRECTORY)("installs and queries the complete local search engine in the compiled release runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-compiled-relevance-"));
  try {
    const executable = join(directory, "afternote-semantic-check");
    runTextOnlyTransformersCompile([
      process.execPath, "build", "--compile", "--target=bun-darwin-arm64",
      "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
      join(import.meta.dir, "compiled-reranked-semantic.fixture.ts"), `--outfile=${executable}`,
    ]);
    chmodSync(executable, 0o755);
    const transformers = Bun.resolveSync("@huggingface/transformers", import.meta.dir);
    const runtime = dirname(dirname(Bun.resolveSync("onnxruntime-node", dirname(transformers))));
    for (const name of ["onnxruntime_binding.node", "libonnxruntime.1.21.0.dylib"]) {
      copyFileSync(join(runtime, "bin/napi-v3/darwin/arm64", name), join(directory, name));
    }
    mkdirSync(join(directory, "state"));
    const child = Bun.spawn([executable], {
      env: { ...process.env, AFTERNOTE_TEST_VAULT_PATH: join(directory, "state", "vault.db") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ state: "ready", dimensions: 768 });
    expect(result.scores[0]).toBeGreaterThan(result.minimumScore);
    expect(result.scores[1]).toBeLessThan(result.minimumScore);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
