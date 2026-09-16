# Semantic model candidates — September 15, 2026

This is development evidence, not approval to publish a new release. Exact search remains
available without a download. Public Alpha 25 artifacts are unchanged.

## Latest validation: publication blocked

The [frozen holdout and isolated scale results](evals/2026-09-15-semantic-models/README.md)
supersede the preliminary timings and outstanding measurement requirements below.
Light passes the current v8 10,000-note suite, but fails the new holdout. Balanced has the
best measured holdout tradeoff after calibration (15/16 supported targets, 8/8 unsupported
questions rejected), but fails the strict recall gate and takes about 12.5 minutes to index
10,000 synthetic notes. Large fails the holdout and shows substantial batch-dependent
embedding variation; its 10,000-note run was skipped by a predeclared entry gate.

All three fail at least one frozen holdout gate. No production cutoffs changed based on these
results. Keep the model choices on the development branch pending retrieval improvements
and fresh evaluation; the current evidence does not justify publishing them as ready.

| Choice | Pinned model | Download | Vector dimensions | Runtime |
| --- | --- | --- | --- | --- |
| Light | GIST all-MiniLM-L6-v2 | 23,557,430 bytes | 384 | q8, mean pooling |
| Balanced | EmbeddingGemma 300M | 218,726,989 bytes | 768 | q4, projected sentence embeddings, query/document prefixes |
| Large | Qwen3 Embedding 0.6B | 624,962,643 bytes | 1,024 | q8, query instructions, left padding, last-token pooling |

Pins and per-file SHA-256 values live in `apps/local/src/semantic-model-catalog.ts`.
Downloads, runtime verification, and selection through a compiled Bun release executable
succeeded for Balanced and Large using local copies of the pinned public artifacts. The
probe verified that a launch-blocker paraphrase ranked the relevant note above an unrelated
refrigerator note. This verifies packaging and basic behavior, not general retrieval quality.

## Earlier small-corpus diagnostic (historical)

The unchanged v8 corpus has 35 notes and 41 cases, including 14 semantic cases. Exploratory
runs used a 0.30 agent cosine cutoff for both new models, after initial 0.55/0.65 cutoffs
rejected most semantic targets. Cutoffs from GIST do not transfer to these models. These
are calibration runs on a known corpus, not an independent holdout or proof of quality.

| Candidate | Overall hit@5 | Semantic hit@5 | Semantic MRR | Unsupported zero-result rate |
| --- | --- | --- | --- | --- |
| Balanced | 97.2% | 92.9% | 0.881 | 100% |
| Large | 100% | 100% | 0.871 | 100% |

Neither meets all existing gates (semantic hit@5 100%, semantic MRR at least 0.90).
Citation integrity was 100% in both runs. Large reached all semantic targets in the first
five results but did not consistently rank them first. Returning all targets does not prove
precision across arbitrary unsupported questions.

Approximate measured process RSS was 0.4–0.6 GiB for Balanced, and 0.7–1.5 GiB for Large
across startup and these probes. These are process measurements, not reserved RAM or an
upper bound. Concurrent benchmark activity affected latency: Balanced small-corpus p95 was
about 65 ms; Large was about 300–400 ms. An isolated fair latency comparison is still needed.
The resource recommendation uses installed physical RAM (Balanced at 8 GiB or more). It
does not predict workload, memory pressure, battery impact, or retrieval accuracy.

## Earlier release requirements (measurement status superseded above)

- Complete real-model evaluation at library scale and on a separate paraphrase/unsupported
  query holdout before claiming either candidate improves recall.
- Measure initial indexing time, peak RSS and steady query latency independently. A 10,000-note Balanced
  run was stopped without a quality result after more than 20 minutes in initial indexing.
  It used the earlier whole-library commit path; the final code now commits progress every
  32 notes. It needs a new measured run. This is a material usability concern even when the
  model fits in RAM; no scale quality or indexing-time pass is claimed.
- Revisit retrieval thresholds using separate calibration and evaluation data. UI search is
  more exploratory (0.25 for the new candidates); agent Recall uses 0.30. These are provisional.
- Verify signed runtime, authentication/lock behavior, model switching, restart/reuse and all
  connector smoke checks on the next version. Do not replace or retag Alpha 25.
- Historical Light evidence also failed the strict large-library quality gate; the deterministic
  10,000-note fixture gate does not test learned-model quality.

## Upstream model documentation and terms

Weights are downloaded on explicit request, not bundled in Afternote. Model terms are separate
from Afternote's Apache-2.0 code license. Review the applicable upstream terms:

- [GIST model](https://huggingface.co/onnx-community/GIST-all-MiniLM-L6-v2-ONNX)
- [EmbeddingGemma model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card)
  and [ONNX conversion](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX)
- [Qwen3 Embedding model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
  and [ONNX conversion](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX)

EmbeddingGemma's ONNX documentation excludes fp16 activations; this implementation uses q4
with float32 activations. Qwen's instruction/pooling and Gemma's task prefixes are part of
the embedding contract, not interchangeable implementation details.
