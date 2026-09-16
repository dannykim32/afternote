# Semantic model validation — September 15, 2026

**Decision: keep publication blocked.** All three profiles fail at least one new holdout
gate. Balanced is the strongest candidate for further work, but a larger model alone does
not solve recall or rejection of unrelated results. No production thresholds were changed.
Public Alpha 25, the approved Settings layout, and personal vaults were not modified.

## Method and scope

- Apple M2, 16 GiB RAM, 8 logical CPUs; macOS arm64, Bun 1.3.14.
- Real model jobs ran serially. Synthetic notes only; remote model loading disabled.
- Production implementation: `5597041`; frozen validation harness/fixture: `f01b14c`.
  A subsequent harness edit renamed `indexingWallMs` to `setupAndIndexingWallMs` for clarity.
- Exact model revisions, quantization, hashes and inference batch sizes are in
  `apps/local/src/semantic-model-catalog.ts`. Each holdout report records its descriptor.
  Model artifacts were checked against the pinned manifests.
- The existing v8 scale suite has 41 cases, including 14 semantic cases. Light and
  Balanced used 10,000 notes. Large's 10,000-note run was conditional on passing the new
  holdout at its current cutoff; this rule was fixed before seeing holdout results.
  Large failed that entry gate, so it received only a fresh 35-note v8 run.
- The new fixture contains 36 notes, 12 calibration paraphrases plus 8 unsupported
  questions, and 16 held-out paraphrases plus 8 unsupported questions. Target notes are
  disjoint across calibration and evaluation; both use the same unlabeled note corpus.
  Fixture SHA-256: `45695ec1a15bbc80417bc69d373b1aaaa5d4b5c0a24458a1ebef1f15e7d70aad`.
- Calibration selected a cutoff before evaluating the holdout. It prioritized rejecting
  all unsupported calibration questions, then target recall and ranking. The choice was
  written to disk before held-out evaluation. These are authored synthetic tests, not an
  external benchmark or a representative estimate of users' libraries.
- Hit@5 means the intended note appears in the first five results. MRR averages reciprocal
  rank (1 for first, 0.5 for second, 0 for missing). Unsupported rejection means no results
  for a subject absent from the fixture. It does not measure precision of every returned note.
- This evaluates agent Recall. The UI's lower, more exploratory cutoffs were not calibrated
  by these runs. It does not validate UI relevance, signed packaging or connector acceptance.

## Frozen holdout results

Required: 16/16 supported targets, MRR at least 0.90, 8/8 unsupported questions rejected,
and valid citations. All runs had 100% citation integrity. Every row below fails a gate.

| Profile | Agent cutoff | Targets found | MRR | Unsupported rejected |
| --- | ---: | ---: | ---: | ---: |
| Light, current | 0.75 | 14/16 | 0.844 | 5/8 |
| Light, calibration-selected | 0.80 | 9/16 | 0.563 | 8/8 |
| Balanced, current | 0.30 | 16/16 | 0.938 | 6/8 |
| Balanced, calibration-selected | 0.40 | 15/16 | 0.906 | 8/8 |
| Large, current | 0.30 | 16/16 | 0.938 | 0/8 |
| Large, calibration-selected | 0.44 | 14/16 | 0.844 | 8/8 |

For example, Balanced's current cutoff returned a workshop closing checklist for a question
about a nonexistent rifle-safe combination. At 0.40 it rejected that question, but missed
the board-presentation note for “Which story should directors hear first in our slide deck?”
Large returned unrelated notes for every unsupported held-out question at its current cutoff.
Raising cutoffs improves abstention but loses some intended notes. None of these observations
was used to revise the frozen fixture or choose another threshold.

## Existing v8 suite and runtime cost

| Profile | Notes | Semantic targets | Semantic MRR | Query p95 | Setup + indexing | Sampled peak RSS | All v8 gates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Light | 10,000 | 14/14 | 0.911 | 55.7 ms | 37.6 s | 544 MiB | Pass |
| Balanced | 10,000 | 13/14 | 0.881 | 107.8 ms | 746.9 s | 919 MiB | Fail |
| Large | 35 | 14/14 | 0.875 | 158.8 ms | 4.8 s | 1,571 MiB | Fail |

Unsupported rejection and citation integrity were 100% in all three v8 runs. The v8
latency gate is 100 ms; semantic hit@5 must be 100% and semantic MRR at least 0.90.
Large's 35-note time is **not** a library-scale result. Light's fresh v8 pass supersedes
the historical Light failure on a different evaluation version; it does not override the
new holdout failure. No causal explanation for the historical difference is established.

Initial model load/warmup was about 288 ms (Light), 854 ms (Balanced), and 763 ms (Large).
The setup/indexing interval excludes that load, but includes fixture setup and work before
the first semantic query. Embedding inference alone took 34.0 s, 742.8 s and 4.8 s respectively.
The raw v8 reports retain the older `indexingWallMs` field name for this interval.

RSS is sampled process resident memory every 20 ms and after batches/queries, not model
download size or a guaranteed memory upper bound. Disk downloads are about 24/219/625 MB.
These are single-run local measurements, not broad hardware estimates. The 36-note holdout's
current-cutoff query p95 was 2.4/26.5/65.8 ms; do not confuse that with 10,000-note latency.

## Batch stability diagnostic

The same 12 calibration documents were embedded alone and in normal inference batches.
Cosine agreement was:

| Profile | Minimum | Mean |
| --- | ---: | ---: |
| Light | 0.9965 | 0.9973 |
| Balanced | 0.9997 | 0.9998 |
| Large | 0.9132 | 0.9303 |

A follow-up on the first four calibration texts reproduced identical Large vectors when
repeating one document alone or four times together (cosine 1.0). Mixing document lengths
changed that document's vector (cosine 0.9396). The attention mask confirmed left padding;
the runtime accepts position IDs and generates them from the attention mask. This narrows
the symptom but does not establish whether padding, quantization, or another runtime detail
causes it. No production embedding change was made from this diagnostic.

## Reproduction and evidence

With dependencies and the checksum-pinned SQLCipher addon built, use an existing directory
containing the selected profile's pinned model files. The harness verifies them and never
downloads weights:

```sh
bun scripts/validate-semantic-model.ts balanced MODEL_DIRECTORY holdout /tmp/balanced-holdout.json
bun scripts/validate-semantic-model.ts balanced MODEL_DIRECTORY scale /tmp/balanced-scale.json
```

Repeat with `light` or `large` and the corresponding directory. `scale` requests 10,000 notes;
the predeclared Large skip was an orchestration decision, not a harness restriction. The
archived v8 runs used a thin timing wrapper around the same `runRecallEvaluation` function;
their report layout differs from the consolidated harness. A default call to that function
without `targetNoteCount` reproduces the 35-note corpus. Timing varies by machine and run.

Raw JSON in this directory preserves the current and calibration-selected holdout outcomes,
the calibration sweeps, v8 runs, and batch diagnostics. `sha256.json` identifies those files.
No private notes, weights, or vaults are included.

Engineering validation: `bun run typecheck` passed; `bun run test` completed with 612
passing tests, 9 skipped, 0 failures and 2,875 assertions across 74 files. The new fixture
and calibration-selection tests passed. Independent specification and standards reviews
found no blockers in the harness; their timing-label clarification is incorporated. Passing
software tests does not override the learned-model quality failures reported above.

## Next release gates

1. Improve relevant-note ranking and rejection of unrelated results; investigate Large's
   batch dependence before exposing it as a ready option. Balanced is a candidate, not a
   validated default. Do not present greater model size as proven greater accuracy.
2. Treat this now-inspected holdout as regression data. Freeze a fresh unseen evaluation
   after further tuning; retain failed results and predeclare its gates.
3. Validate both agent and UI cutoffs, rerun scale tests for changed embeddings/retrieval,
   and verify indexing interruption/resume on the release candidate.
4. Complete signed runtime, lock/auth, model switching, restart/reuse, connector and
   clean-user acceptance checks before publishing the next version.
