import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_RERANKER } from "./semantic-model-catalog";
import type { TextReranker } from "./retrieval";

// The pinned official Ettin ONNX export contains the encoder. Its published
// CLS -> Dense(GELU) -> LayerNorm -> Dense scoring head is stored separately.
// No executable model code is downloaded. All files are verified by the installer.
const DIMENSIONS = 768;
const BATCH_SIZE = 4;

type ScoreBatch = (query: string, passages: string[]) => Promise<number[]>;

export class TransformersTextReranker implements TextReranker {
  readonly id = `${LOCAL_RERANKER.id}:${LOCAL_RERANKER.revision}:afternote-1`;
  readonly minimumScore = 3;
  readonly #directory: string;
  #runtime: Promise<ScoreBatch> | null = null;

  constructor(directory: string) { this.#directory = directory; }

  async score(query: string, passages: readonly string[], stopped?: () => boolean): Promise<number[]> {
    if (passages.length === 0) return [];
    const runtime = await this.#load();
    const result = new Array<number>(passages.length);
    // Short passages should not pay the padding cost of unrelated long notes.
    const ordered = passages.map((text, index) => ({ text, index }))
      .sort((a, b) => a.text.length - b.text.length || a.index - b.index);
    for (let start = 0; start < ordered.length; start += BATCH_SIZE) {
      if (stopped?.()) throw new Error("Local relevance scoring was interrupted");
      const batch = ordered.slice(start, start + BATCH_SIZE);
      const scores = await runtime(query, batch.map((item) => item.text));
      if (scores.length !== batch.length || scores.some((value) => !Number.isFinite(value))) {
        throw new Error("Local relevance model returned invalid scores");
      }
      batch.forEach((item, index) => { result[item.index] = scores[index]!; });
    }
    return result;
  }

  #load(): Promise<ScoreBatch> {
    return this.#runtime ??= (async () => {
      const transformers = await import("@huggingface/transformers");
      transformers.env.allowRemoteModels = false;
      transformers.env.allowLocalModels = true;
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(this.#directory);
      const encoder = await transformers.AutoModel.from_pretrained(this.#directory, {
        // The filename identifies the official ARM int8 graph; fp32 suppresses
        // Transformers.js's automatic filename suffix. It does not change weights.
        dtype: "fp32", model_file_name: "model_qint8_arm64",
      });
      const head = new EttinScoringHead(this.#directory);
      return async (query: string, passages: string[]) => {
        const input = tokenizer(passages.map(() => query), {
          text_pair: passages, padding: true, truncation: true, max_length: 512,
        });
        const { last_hidden_state: hidden } = await encoder(input);
        if (hidden?.dims.length !== 3 || hidden.dims[0] !== passages.length ||
            hidden.dims[2] !== DIMENSIONS || hidden.dims[1] < 1) {
          throw new Error("Local relevance model returned an unexpected tensor shape");
        }
        return passages.map((_, index) => {
          const offset = index * hidden.dims[1] * DIMENSIONS;
          return head.score(hidden.data.subarray(offset, offset + DIMENSIONS));
        });
      };
    })();
  }
}

export class EttinScoringHead {
  readonly #dense: Float32Array;
  readonly #scale: Float32Array;
  readonly #shift: Float32Array;
  readonly #output: Float32Array;
  readonly #bias: number;

  constructor(directory: string) {
    const dense = readFloat32Tensors(join(directory, "2_Dense/model.safetensors"));
    const norm = readFloat32Tensors(join(directory, "3_LayerNorm/model.safetensors"));
    const output = readFloat32Tensors(join(directory, "4_Dense/model.safetensors"));
    this.#dense = requireTensor(dense, "linear.weight", DIMENSIONS * DIMENSIONS);
    this.#scale = requireTensor(norm, "norm.weight", DIMENSIONS);
    this.#shift = requireTensor(norm, "norm.bias", DIMENSIONS);
    this.#output = requireTensor(output, "linear.weight", DIMENSIONS);
    this.#bias = requireTensor(output, "linear.bias", 1)[0]!;
  }

  score(cls: Float32Array): number {
    if (cls.length !== DIMENSIONS) throw new Error("Invalid relevance head input");
    const hidden = new Float32Array(DIMENSIONS);
    for (let row = 0; row < DIMENSIONS; row++) {
      let sum = 0;
      for (let column = 0; column < DIMENSIONS; column++) {
        sum += this.#dense[row * DIMENSIONS + column]! * cls[column]!;
      }
      hidden[row] = 0.5 * sum * (1 + erf(sum / Math.SQRT2));
    }
    const mean = hidden.reduce((sum, value) => sum + value, 0) / DIMENSIONS;
    const variance = hidden.reduce((sum, value) => sum + (value - mean) ** 2, 0) / DIMENSIONS;
    let score = this.#bias;
    for (let index = 0; index < DIMENSIONS; index++) {
      const normalized = (hidden[index]! - mean) / Math.sqrt(variance + 1e-5);
      score += (normalized * this.#scale[index]! + this.#shift[index]!) * this.#output[index]!;
    }
    return score;
  }
}

function requireTensor(tensors: Map<string, Float32Array>, name: string, length: number): Float32Array {
  const value = tensors.get(name);
  if (!value || value.length !== length || value.some((number) => !Number.isFinite(number))) {
    throw new Error("Invalid local relevance head tensor");
  }
  return value;
}

function readFloat32Tensors(path: string): Map<string, Float32Array> {
  const bytes = readFileSync(path);
  if (bytes.length < 8) throw new Error("Truncated local relevance head");
  const size = Number(bytes.readBigUInt64LE());
  if (!Number.isSafeInteger(size) || size < 2 || size > bytes.length - 8) throw new Error("Invalid tensor header");
  const header = JSON.parse(bytes.subarray(8, 8 + size).toString("utf8"));
  const tensors = new Map<string, Float32Array>();
  for (const [name, tensor] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    const value = tensor as { dtype: string; shape: number[]; data_offsets: number[] };
    const [start, end] = value.data_offsets ?? [];
    if (value.dtype !== "F32" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start! < 0 || end! <= start! || end! > bytes.length - 8 - size ||
        !Array.isArray(value.shape) || value.shape.some((n) => !Number.isSafeInteger(n) || n < 1) ||
        (end! - start!) !== value.shape.reduce((a, b) => a * b, 1) * 4) {
      throw new Error("Invalid local relevance head tensor layout");
    }
    const data = bytes.subarray(8 + size + start!, 8 + size + end!);
    tensors.set(name, new Float32Array(Uint8Array.from(data).buffer));
  }
  return tensors;
}

// Abramowitz-Stegun approximation; maximum absolute error about 1.5e-7.
function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const t = 1 / (1 + 0.3275911 * Math.abs(value));
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - polynomial * Math.exp(-value * value));
}
