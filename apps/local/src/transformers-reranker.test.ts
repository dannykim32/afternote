import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { EttinScoringHead } from "./transformers-reranker";

function tensorFile(directory: string, folder: string, tensors: Record<string, {shape: number[]; data: Float32Array}>) {
  const header: Record<string, unknown> = {}; const data: Buffer[] = []; let offset = 0;
  for (const [key, value] of Object.entries(tensors)) {
    const bytes = Buffer.from(value.data.buffer);
    header[key] = {dtype: "F32", shape: value.shape, data_offsets: [offset, offset + bytes.length]};
    offset += bytes.length; data.push(bytes);
  }
  const json = Buffer.from(JSON.stringify(header)); const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(json.length));
  mkdirSync(join(directory, folder), {recursive: true});
  writeFileSync(join(directory, folder, "model.safetensors"), Buffer.concat([size, json, ...data]));
}

it("applies the published dense/GELU/LayerNorm/dense head and rejects damaged tensors", () => {
  const directory = mkdtempSync(join(tmpdir(), "afternote-reranker-head-"));
  try {
    const identity = new Float32Array(768 * 768); for (let i = 0; i < 768; i++) identity[i * 768 + i] = 1;
    const output = new Float32Array(768); output[0] = 1;
    tensorFile(directory, "2_Dense", {"linear.weight": {shape: [768, 768], data: identity}});
    tensorFile(directory, "3_LayerNorm", {"norm.weight": {shape: [768], data: new Float32Array(768).fill(1)}, "norm.bias": {shape: [768], data: new Float32Array(768)}});
    tensorFile(directory, "4_Dense", {"linear.weight": {shape: [1, 768], data: output}, "linear.bias": {shape: [1], data: new Float32Array([0.5])}});
    const head = new EttinScoringHead(directory);
    expect(head.score(new Float32Array(768).fill(1))).toBeCloseTo(0.5, 5);
    const input = new Float32Array(768); input[0] = 1;
    // GELU(1) from the standard normal CDF, then a one-nonzero-value population variance.
    const gelu = 0.8413447460685429, mean = gelu / 768;
    const variance = ((gelu - mean) ** 2 + 767 * mean ** 2) / 768;
    expect(head.score(input)).toBeCloseTo((gelu - mean) / Math.sqrt(variance + 1e-5) + 0.5, 5);
    expect(() => head.score(new Float32Array(3))).toThrow("Invalid relevance head input");
    writeFileSync(join(directory, "2_Dense/model.safetensors"), Buffer.alloc(7));
    expect(() => new EttinScoringHead(directory)).toThrow("Truncated");
    const bad = Buffer.alloc(10); bad.writeBigUInt64LE(99999n); writeFileSync(join(directory, "2_Dense/model.safetensors"), bad);
    expect(() => new EttinScoringHead(directory)).toThrow("Invalid tensor header");
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
