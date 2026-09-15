// Similarity cutoffs are model-specific; see docs/SEMANTIC_MODEL_COMPARISON.md for calibration limits.
// Versioned, bundled model allowlist. Download commands never accept a URL or model ID.
export type SemanticProfileId = "light" | "balanced" | "large";
export type SemanticModelProfile = {
  key: SemanticProfileId;
  name: string;
  id: string;
  revision: string;
  dtype: "q8" | "q4";
  dimensions: number;
  minimumSimilarity: number;
  uiMinimumSimilarity: number;
  batchSize: number;
  files: Readonly<Record<string, { sha256: string; bytes: number }>>;
};

export const SEMANTIC_MODELS: Readonly<Record<SemanticProfileId, SemanticModelProfile>> = {
  light: {
    key: "light", name: "GIST MiniLM", id: "onnx-community/GIST-all-MiniLM-L6-v2-ONNX",
    revision: "c0339fdc3b6e11b7a7e7213695e36e55fcc732d8", dtype: "q8", dimensions: 384,
    minimumSimilarity: 0.75, uiMinimumSimilarity: 0.7, batchSize: 128,
    files: {
  "config.json": {
    sha256: "4599e8a5d74ed192b70919aa02124c2d68580070b22e89db956c0353618bccd9",
    bytes: 611,
  },
  "tokenizer.json": {
    sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    bytes: 711_661,
  },
  "tokenizer_config.json": {
    sha256: "7580f5760152bd83122877e4c21d62b3d342cc2ab7232a1dbd0180d3b022798f",
    bytes: 1_463,
  },
  "onnx/model_quantized.onnx": {
    sha256: "0225a6e9c7b82e999fbf108daa02b825ac4b35173eb1d1073d8b3a0d4aa80251",
    bytes: 22_843_695,
  },
},
  },
  balanced: {
  "key": "balanced",
  "name": "EmbeddingGemma",
  "id": "onnx-community/embeddinggemma-300m-ONNX",
  "revision": "5090578d9565bb06545b4552f76e6bc2c93e4a66",
  "dtype": "q4",
  "dimensions": 768,
  "minimumSimilarity": 0.3,
  "uiMinimumSimilarity": 0.25,
  "batchSize": 4,
  "files": {
    "config.json": {
      "sha256": "6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b",
      "bytes": 1765
    },
    "onnx/model_q4.onnx": {
      "sha256": "ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043",
      "bytes": 519322
    },
    "onnx/model_q4.onnx_data": {
      "sha256": "599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02",
      "bytes": 196725760
    },
    "tokenizer.json": {
      "sha256": "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47",
      "bytes": 20323312
    },
    "tokenizer_config.json": {
      "sha256": "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a",
      "bytes": 1156830
    }
  }
},
  large: {
  "key": "large",
  "name": "Qwen3 Embedding",
  "id": "onnx-community/Qwen3-Embedding-0.6B-ONNX",
  "revision": "c25a394dd583836952667c12f008335071b3f43d",
  "dtype": "q8",
  "dimensions": 1024,
  "minimumSimilarity": 0.3,
  "uiMinimumSimilarity": 0.25,
  "batchSize": 4,
  "files": {
    "config.json": {
      "sha256": "66a10929782f3c9a3cd5dec90e2a95c60e05736134a63cd54479eeae80bed175",
      "bytes": 1576
    },
    "onnx/model_quantized.onnx": {
      "sha256": "87cd124e0ef1fd1f223ebc283efccbaeac386d0b08344701c46975d0657b591f",
      "bytes": 613527631
    },
    "tokenizer.json": {
      "sha256": "def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a",
      "bytes": 11423705
    },
    "tokenizer_config.json": {
      "sha256": "977648852447cb6587327ff3205b0a84cf2fc9f05621d6c8e88a497caafab2e1",
      "bytes": 9731
    }
  }
},
};

export function semanticProfile(value: unknown): SemanticModelProfile {
  if (typeof value !== "string" || !Object.hasOwn(SEMANTIC_MODELS, value)) {
    throw new Error("Semantic model must be light, balanced, or large");
  }
  return SEMANTIC_MODELS[value as SemanticProfileId];
}

export function modelDownloadBytes(profile: SemanticModelProfile): number {
  return Object.values(profile.files).reduce((sum, file) => sum + file.bytes, 0);
}
