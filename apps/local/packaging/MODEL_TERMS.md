# Local search model terms

Afternote's application source code is licensed under Apache-2.0. The included
model weights have their own terms; the application license does not replace them.

## EmbeddingGemma

Using or distributing the included EmbeddingGemma model is subject to the
[Gemma Terms of Use](https://ai.google.dev/gemma/terms). A copy is included in
`LICENSES/GEMMA_TERMS.txt`. You must not use the model for the restricted uses in
Section 3.2, including the [Gemma Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy),
or in violation of applicable laws and regulations. These restrictions are
incorporated into this license governing the use and distribution of the included
model. A copy of that policy is in `LICENSES/GEMMA_PROHIBITED_USE_POLICY.txt`.

Gemma is provided under and subject to the Gemma Terms of Use found at ai.google.dev/gemma/terms.

The model is Google's EmbeddingGemma 300M, converted to ONNX and quantized to Q4
by ONNX Community. Afternote redistributes those files without modifying their
contents. Source: `onnx-community/embeddinggemma-300m-ONNX`, revision
`5090578d9565bb06545b4552f76e6bc2c93e4a66`.

## Ettin relevance model

The included Ettin 150M relevance model is licensed under Apache-2.0, reproduced
in `LICENSES/ETTIN_LICENSE.txt`. Source: `cross-encoder/ettin-reranker-150m-v1`,
revision `025501c4e0f9bbeb4c5b198318e0089ff061cc14`. Afternote uses its official
ARM INT8 ONNX encoder and published scoring-head weights without modifying them.

Both models run on your Mac. No note content is sent to the model publishers.
