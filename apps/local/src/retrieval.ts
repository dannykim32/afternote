export type EmbeddingModelDescriptor = {
  id: string;
  revision: string;
  dimensions: number;
};

/**
 * Local-only text embedding adapter. Implementations must not make a network
 * request: installation and model acquisition are separate, explicit flows.
 */
export interface TextEmbeddingModel {
  readonly descriptor: EmbeddingModelDescriptor;
  readonly minimumSimilarity: number;
  readonly uiMinimumSimilarity?: number;
  embedQuery?(text: string): Promise<Float32Array>;
  embed(texts: readonly string[], stopped?: () => boolean): Promise<Float32Array[]>;
}

export type RetrievalMode = "lexical" | "hybrid";

export type DerivedIndexStatus = {
  state: "disabled" | "indexing" | "ready" | "degraded";
  model: EmbeddingModelDescriptor | null;
  totalNotes: number;
  indexedNotes: number;
  staleNotes: number;
  lastError: string | null;
};

export function cosineSimilarity(
  left: Float32Array,
  right: Float32Array,
): number {
  if (left.length === 0 || left.length !== right.length) return Number.NaN;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return Number.NaN;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function embeddingBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(
      vector.byteOffset,
      vector.byteOffset + vector.byteLength,
    ),
  );
}

export function embeddingFromBytes(
  bytes: Uint8Array,
  dimensions: number,
): Float32Array | null {
  if (dimensions < 1 || bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    return null;
  }
  const copy = Uint8Array.from(bytes);
  return new Float32Array(copy.buffer);
}

export function validateEmbedding(
  vector: Float32Array,
  descriptor: EmbeddingModelDescriptor,
): void {
  if (vector.length !== descriptor.dimensions) {
    throw new Error(
      `Embedding model ${descriptor.id} returned ${vector.length} dimensions; expected ${descriptor.dimensions}`,
    );
  }
  if (!vector.every(Number.isFinite)) {
    throw new Error(`Embedding model ${descriptor.id} returned a non-finite value`);
  }
}
