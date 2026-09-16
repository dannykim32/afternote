import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "bun:test";
import { bundleSemanticModels, BUNDLED_SEMANTIC_PROFILE } from "./prepare-semantic-release";

it("packages only verified model inputs, model identities and required notices", () => {
  const root = mkdtempSync(join(tmpdir(), "afternote-model-package-"));
  const original = BUNDLED_SEMANTIC_PROFILE.files;
  const content = "model data";
  BUNDLED_SEMANTIC_PROFILE.files = {"onnx/test.onnx": {bytes: content.length, sha256: createHash("sha256").update(content).digest("hex")}};
  try {
    const output = join(root, "output"); mkdirSync(output);
    expect(() => bundleSemanticModels(root, output)).toThrow("prepare:semantic-release");
    mkdirSync(join(root, "build/semantic-model/onnx"), {recursive: true});
    writeFileSync(join(root, "build/semantic-model/onnx/test.onnx"), content);
    writeFileSync(join(root, "build/semantic-model/unexpected"), "never ship arbitrary cache files");
    mkdirSync(join(root, "apps/local/packaging"), {recursive: true});
    for (const file of ["MODEL_TERMS.md", "GEMMA_NOTICE.txt"]) writeFileSync(join(root, "apps/local/packaging", file), file);
    bundleSemanticModels(root, output);
    expect(readFileSync(join(output, "semantic-model/onnx/test.onnx"), "utf8")).toBe(content);
    expect(JSON.parse(readFileSync(join(output, "semantic-model/manifest.json"), "utf8"))).toMatchObject({embedding: {id: BUNDLED_SEMANTIC_PROFILE.id}, files: BUNDLED_SEMANTIC_PROFILE.files});
    expect(() => readFileSync(join(output, "semantic-model/unexpected"))).toThrow();
    expect(readFileSync(join(output, "semantic-model/Notice"), "utf8")).toBe("GEMMA_NOTICE.txt");
    rmSync(join(output, "semantic-model"), {recursive: true});
    writeFileSync(join(root, "build/semantic-model/onnx/test.onnx"), "bad input");
    expect(() => bundleSemanticModels(root, output)).toThrow("prepare:semantic-release");
  } finally { BUNDLED_SEMANTIC_PROFILE.files = original; rmSync(root, {recursive: true, force: true}); }
});
