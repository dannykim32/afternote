import { resolve } from "node:path";
import { SEMANTIC_MODELS, type SemanticModelProfile } from "./semantic-model-catalog";
import {
  validateEmbedding,
  type EmbeddingModelDescriptor,
  type TextEmbeddingModel,
} from "./retrieval";

export const LOCAL_EMBEDDING_MODEL = {
  id: "onnx-community/GIST-all-MiniLM-L6-v2-ONNX",
  revision: "c0339fdc3b6e11b7a7e7213695e36e55fcc732d8",
  dtype: "q8",
  dimensions: 384,
} as const;
export const LOCAL_EMBEDDING_PIPELINE_VERSION = 2;

const MAX_CHUNK_CHARACTERS = 800;


type FeatureExtractionOutput = {
  data: Float32Array;
  dims: number[];
};

type FeatureExtractor = (
  texts: readonly string[],
) => Promise<FeatureExtractionOutput>;

export class TransformersTextEmbeddingModel implements TextEmbeddingModel {
  readonly minimumSimilarity: number;
  readonly uiMinimumSimilarity: number;
  readonly descriptor: EmbeddingModelDescriptor;
  readonly #profile: SemanticModelProfile;

  readonly #cacheDirectory: string;
  readonly #localModelPath: string | null;
  readonly #allowRemoteModels: boolean;
  #extractor: Promise<FeatureExtractor> | null = null;

  constructor(options: {
    cacheDirectory: string;
    localModelPath?: string;
    allowRemoteModels?: boolean;
    profile?: SemanticModelProfile;
  }) {
    this.#profile = options.profile ?? SEMANTIC_MODELS.light;
    this.minimumSimilarity = this.#profile.minimumSimilarity;
    this.uiMinimumSimilarity = this.#profile.uiMinimumSimilarity;
    this.descriptor = {
      id: `${this.#profile.id}:${this.#profile.dtype}`,
      revision: `${this.#profile.revision}:afternote-${LOCAL_EMBEDDING_PIPELINE_VERSION}`,
      dimensions: this.#profile.dimensions,
    };
    this.#cacheDirectory = resolve(options.cacheDirectory);
    this.#localModelPath = options.localModelPath
      ? resolve(options.localModelPath)
      : null;
    this.#allowRemoteModels = options.allowRemoteModels ?? false;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.#embed([text], true))[0]!;
  }

  async embed(texts: readonly string[], stopped?: () => boolean): Promise<Float32Array[]> {
    return this.#embed(texts, false, stopped);
  }

  async #embed(texts: readonly string[], query: boolean, stopped?: () => boolean): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const chunksByText = texts.map(chunkText);
    const flattenedChunks = chunksByText.flat().map((text) => {
      if (this.#profile.key === "balanced") return (query ? "task: search result | query: " : "title: none | text: ") + text;
      if (this.#profile.key === "large" && query) return "Instruct: Given a search query, retrieve saved notes that answer the query\nQuery:" + text;
      return text;
    });
    const chunkVectors: Float32Array[] = [];
    const extractor = await this.#loadExtractor();
    for (let offset = 0; offset < flattenedChunks.length; offset += this.#profile.batchSize) {
      if (stopped?.()) return [];
      const batch = flattenedChunks.slice(offset, offset + this.#profile.batchSize);
      const output = await extractor(batch);
      chunkVectors.push(...vectorsFromOutput(output, batch.length, this.descriptor));
    }

    const vectors: Float32Array[] = [];
    let offset = 0;
    for (const chunks of chunksByText) {
      vectors.push(
        meanNormalized(
          chunkVectors.slice(offset, offset + chunks.length),
          this.descriptor,
        ),
      );
      offset += chunks.length;
    }
    return vectors;
  }

  async #loadExtractor(): Promise<FeatureExtractor> {
    if (!this.#extractor) {
      this.#extractor = (async () => {
        const transformers = await import("@huggingface/transformers");
        transformers.env.cacheDir = this.#cacheDirectory;
        transformers.env.allowRemoteModels = this.#allowRemoteModels;
        transformers.env.allowLocalModels = true;
        if (this.#localModelPath) {
          transformers.env.localModelPath = this.#localModelPath;
        }
        const modelPath = this.#localModelPath ?? this.#profile.id;
        const options = { revision: this.#profile.revision, dtype: this.#profile.dtype };
        if (this.#profile.key === "balanced") {
          const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelPath, options);
          const model = await transformers.AutoModel.from_pretrained(modelPath, options);
          return async (texts: readonly string[]) => {
            const inputs = tokenizer([...texts], { padding: true, truncation: true });
            const output = await model(inputs);
            return output.sentence_embedding as FeatureExtractionOutput;
          };
        }
        const extractor = await transformers.pipeline("feature-extraction", modelPath, options);
        // Qwen's last-token pooling requires left padding in mixed-length batches.
        if (this.#profile.key === "large") extractor.tokenizer.padding_side = "left";
        return async (texts: readonly string[]) => await extractor([...texts], {
          pooling: this.#profile.key === "large" ? "last_token" : "mean",
          normalize: true,
        }) as FeatureExtractionOutput;
      })();
    }
    return this.#extractor;
  }
}

function chunkText(text: string): string[] {
  const characters = Array.from(text.trim());
  if (characters.length === 0) throw new Error("Embedding text cannot be empty");
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += MAX_CHUNK_CHARACTERS) {
    chunks.push(characters.slice(offset, offset + MAX_CHUNK_CHARACTERS).join(""));
  }
  return chunks;
}

function vectorsFromOutput(
  output: FeatureExtractionOutput,
  expectedCount: number,
  descriptor: EmbeddingModelDescriptor,
): Float32Array[] {
  if (
    output.dims.length !== 2 ||
    output.dims[0] !== expectedCount ||
    output.dims[1] !== descriptor.dimensions ||
    output.data.length !== expectedCount * descriptor.dimensions
  ) {
    throw new Error("Local embedding model returned an unexpected tensor shape");
  }
  return Array.from({ length: expectedCount }, (_, index) => {
    const start = index * descriptor.dimensions;
    const vector = output.data.slice(start, start + descriptor.dimensions);
    validateEmbedding(vector, descriptor);
    return vector;
  });
}

function meanNormalized(
  vectors: readonly Float32Array[],
  descriptor: EmbeddingModelDescriptor,
): Float32Array {
  if (vectors.length === 0) throw new Error("Cannot average an empty embedding");
  const mean = new Float32Array(descriptor.dimensions);
  for (const vector of vectors) {
    validateEmbedding(vector, descriptor);
    for (let index = 0; index < mean.length; index += 1) {
      mean[index] = (mean[index] ?? 0) + (vector[index] ?? 0);
    }
  }
  let magnitude = 0;
  for (const value of mean) magnitude += value * value;
  magnitude = Math.sqrt(magnitude);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Local embedding average has zero magnitude");
  }
  for (let index = 0; index < mean.length; index += 1) {
    mean[index] = (mean[index] ?? 0) / magnitude;
  }
  return mean;
}
