# #324 Anonymous Recall Quality Matrix

## Problem

Private anecdotes cannot distinguish retrieval misses, routing mistakes, evidence gaps, noisy results, or latency-only warnings. Tuning ranking against those anecdotes risks overfitting and exact-lookup regressions.

## Design

- Add a fully offline gate backed by an isolated temporary CBrain database and anonymous fixtures.
- Exercise production code paths for exact/alias/abstract retrieval, honest empty, temporal evidence, relationship routing, and the operational Agent workflow contract.
- Report each lane separately: `retrieval`, `router`, `evidence`, and `latency`.
- Track `recall_at_k`, `noise_at_k`, `honest_empty`, evidence coverage, degraded classification, and a bounded wall-clock ceiling.
- Use deterministic local embeddings with no LLM, network, real vault, or private query.
- Add the gate to CI and the release preflight aggregator.

## Non-goals

- No ranking, threshold, provider, schema, or user-data changes.
- No single aggregate score that can hide a failed lane.
- No product latency claim from local wall-clock timing.

## Acceptance

- Chinese, English, mixed alias, abstract topic, temporal, relationship, operational, and absent-topic cases are anonymous and deterministic.
- Irrelevant results and honest empty are separate metrics.
- Exact lookup and empty honesty are hard no-go checks.
- Reports contain fixed case IDs and scalar metrics only; no query, title, slug, path, body, or credentials.
- Fault injection proves retrieval, routing, evidence, privacy, and latency failures produce `no-go`.

