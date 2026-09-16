# Local semantic retrieval improvement

## Product requirements

Semantic recall is a core Afternote capability: users should find explicitly saved notes by
meaning in both Notes and authorized connected tools, without remembering the original words.
Keep setup simple: one explicit local search download, with its action aligned to the right
like other Settings controls. No Light/Balanced/Large selector in the product UI. Preserve
existing vault, authentication, connector and citation boundaries. Do not publish on the basis
of a small favorable example or silently loosen quality gates.

## Candidate implementation

EmbeddingGemma q4 still builds the 768-dimensional local index. A pinned Ettin 150M ARM-int8
reranker evaluates a bounded shortlist of up to 20 semantic and 20 lexical candidates. The
embedding candidate cutoff is 0.20; the reranker's relevance cutoff is 3. These are different
scores, not probabilities. Full literal phrases and identifiers stay searchable and pageable
beyond the reranking shortlist. Incidental keyword overlap cannot outrank or hide semantic
results. UI and agent retrieval share the same relevance rule. After admission, equal-weight reciprocal
rank fusion combines the semantic order and relevance order, using `1 / (2 + zeroBasedRank)`
for each list. This intentionally gives the top results from either signal a strong vote, so
the cross-encoder cannot bury a leading semantic match under repetitive distractors. Literal
matches retain priority. Scores are ranking values, not confidence probabilities.

The official ONNX reranker graph contains its encoder. Afternote applies the separately
published CLS/dense-GELU/LayerNorm/dense head locally. All graph, tokenizer, config and head
files have pinned revisions, sizes and hashes. The installer verifies and runtime-probes both
components before committing selection; the combined download is about 375 MB. No model code
is downloaded or evaluated. Processing is offline after installation. Internal legacy profile
support remains for previous explicit installations and comparison tooling, but the native UI
only offers the improved search bundle.

The reranker sees the matching passage with surrounding text and verified source context.
Work is bounded, checked for cancellation between batches, and shares the existing query time
budget. Failure returns literal evidence with degraded status. Results are rechecked against
current note revisions after inference: deletions, edits, model replacement and vault closure
must not allow stale evidence to escape. Search cursors include the reranker identity.

## Evaluation contract

V1 is now development/regression data. Early probes compared MiniLM L6 and Ettin 32M, 68M,
and 150M on its known cases; none of those are unseen generalization evidence. The 150M model
had the clearest separation on the original 16 evaluation targets, with one difficult older
calibration paraphrase still missed in the integrated path. Keep that failure visible.

V2 was committed at `bef4dbe` before retrieval changes. It has 24 supported and 12 unsupported
queries, with semantically related distractors and keyword decoys. SHA-256:
`97d136b2102ac5d6f7fe44e76268ef8c719f9d4a1ba5d5c7ce4373fd6856b206`.
V2 has now been evaluated; its original reports must remain intact. It is no longer unseen data. Evaluate both UI and agent paths, preserve
baseline and candidate reports, and report failures. Require 100% supported hit@5, MRR >= 0.90,
100% unsupported rejection and valid citations. These small authored fixtures do not establish
universal recall or answer correctness.

Re-run the existing v8 scale quality tests. The historical 100 ms latency gate remains visible;
a slower relevance stage must not be described as passing it. When replaying cached synthetic
document embeddings for ranking experiments, label that explicitly: it is not a fresh indexing
benchmark. Initial indexing behavior and embeddings have not changed in this iteration.

Signed packaging, clean-user acceptance and connector checks remain separate publication gates.

## Upstream contracts

- [EmbeddingGemma ONNX](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX)
- [Ettin reranker architecture and usage](https://huggingface.co/blog/ettin-reranker)
- [Official Ettin 150M artifacts](https://huggingface.co/cross-encoder/ettin-reranker-150m-v1)
- [Retrieve and rerank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)

EmbeddingGemma retains its upstream Gemma terms; Ettin is Apache-2.0. Weights are downloaded
only on explicit request and are not bundled into the application.

## Further experiments and next holdout

Ettin 400M was also probed against known V1 and v8 cases. It separated the V1 candidates well
but still rejected valid v8 paraphrases and ranked the deployment blocker behind shipping-label
printer distractors. It is not selected for the product. More parameters alone do not fix the
relevance decision. Removing source metadata from passages also had mixed effects and was
not adopted.

V3 was frozen at `2b1f09a` before rank fusion, with 20 synthetic notes, 16 supported queries
and 8 unsupported questions. SHA-256:
`625bf5b7e4168219ae023cbd5d6da93b1bdb150586cc01f2772c6599e86e49a9`.
Keep its first evaluation separate from development and retain the same quality gates. The
question of returning explicitly marked related context is a separate product policy; these
experiments continue to use the conservative admission rule until that policy is decided.
