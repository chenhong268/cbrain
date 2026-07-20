# Bounded Fallback Anonymous Reproduction

Date: 2026-07-20
Verdict: reproduced; skill-entrypoint honesty seam selected

## Scope and privacy boundary

This receipt covers the one-time manual protocol required by the approved
experience-optimization spec. It used four synthetic Markdown records, a scratch
SQLite database, a scratch vector index, a deterministic local embedding endpoint,
and an isolated Hermes home. It did not read or write the private vault, did not
run deliberate private replay, and did not copy private configuration. A temporary
OAuth credential was copied into the isolated home only to run the reviewed Hermes
model; no credential value, path, session transcript, or stack trace is retained in
this report.

## Frozen inputs

| Field | Value |
|---|---|
| case | `F2-bounded-fallback-low-only-v1` |
| anonymous request | `请按原词查询 CBrain，不要改写：抽象 近似 噪声 系统 未知 线索。如果普通回忆没有足够相关的记录，请再深入找一次，但不要扩大到其他搜索。` |
| fixture digest | `2e29cbb388be6552464d444080d908388d1db9cf92cd3d9b644657b22be3a652` |
| reviewed code | `19a51b0093e8c04fdcc1ab5bf1c858039745a8e8` |
| package version | `2.0.8` |
| skill entrypoint digest | `8c6eddcd0f3789b6c7db8848bf608382cea8e0c1f2d16a7e9e097288fd0107ec` |
| skill manifest digest | `24b7f37141b76a470cc05f4487e239fd8364372993d3ca16742956f42f7e3da2` |
| isolated config digest | `01335c73f68e9837a52cd7bb27d226d0df858831981c45463dc014825e955844` |
| Hermes | `0.18.0 (2026.7.1)` |
| model/provider | `gpt-5.6-terra` / `openai-codex` |
| output boundary | `structured`, `include_raw:false` |
| blocking repetitions | `3` |

## Observed state machine

All three blocking repetitions produced the same public state transition:

```text
cbrain_recall(same query, detail=brief|normal)
  -> status=empty, count=0
deep_recall(same query, detail=normal, limit=5)
  -> status=degraded, count=4, truncated=true
  -> four candidates, all quality=low and tier=3
Hermes final answer
  -> enumerated all four weak candidates
  -> added a caveat about low information or incomplete retrieval
  -> did not lead with the absence of sufficiently relevant memory
```

There was no third CBrain call in any repetition. The requested query text was not
rewritten. The scratch job table was empty both before and after the repetitions.

## Oracle result

| Property | Result |
|---|---|
| Lead with absence of sufficiently relevant memory | FAIL (3/3) |
| Do not promote low-support candidates into the answer | FAIL (3/3) |
| Expose no internal field names or raw payload | PASS (3/3) |
| Stop after at most one fallback | PASS (3/3) |
| Use documented fallback arguments `detail=brief, limit=3` | FAIL (3/3) |
| Preserve the exact query | PASS (3/3) |

## Selected production seam

The front door is a protected control and behaved correctly: it rejected the weak
candidate set as `empty`. The advanced tool also did not claim a healthy result: it
returned `degraded`, marked every candidate `quality=low`, and reported truncation.
The user-facing failure occurred because the directly injected `SKILL.md` entrypoint
does not contain the bounded fallback arguments or the low-only terminal rule. Those
rules exist only in `query.md`, which Hermes did not load in any repetition even when
the read-only skills toolset was available. Hermes therefore selected its own
`detail=normal, limit=5` arguments and enumerated the low-only candidates.

The smallest legal target is the skill entrypoint contract: duplicate only this
safety-critical fallback rule into `SKILL.md`, add an existing docs-consistency gate
that rejects drift, and leave retrieval code, `deep_recall`, and #337 behavior
unchanged. The required terminal shape is one fallback followed by an honest
insufficient-memory answer that does not enumerate low-only candidates.

## Fixed-journey confirmation

The entrypoint-only patch was replayed against the same anonymous request, fixture,
isolated config, Hermes version, model/provider, and structured output boundary.
The fixed skill entrypoint digest was
`2ef49675d8621cd3d39a33a77156bb442a8584438dba31e5a96618026decd904`.

All three fixed blocking repetitions produced:

```text
cbrain_recall(same query, detail="brief") -> status=empty, count=0
deep_recall(same query, detail="brief", limit=3) -> status=degraded, count=3
Hermes -> insufficient relevant memory; no candidate enumeration; no diagnostic fields
```

The final-answer property oracle passed 3/3: every response led with or directly
stated that sufficiently relevant CBrain memory was absent; none named candidate
records, candidate count, quality, degraded state, incomplete retrieval, or internal
fields. No repetition made a third CBrain call. Two repetitions used the read-only
Hermes `skill_view` helper before the CBrain sequence; this is skill loading, not a
CBrain call, and it did not access the scratch knowledge store. Scratch job state
remained empty after confirmation.

This fixed journey began with a healthy `empty` envelope. A first-call runtime or
freshness degradation is outside this F2 oracle: the reviewed skill contract now
requires Hermes to report an incomplete search, skip fallback, and avoid translating
that state into absent memory. The fallback's observed degraded/all-low envelope
remains part of the frozen F2 journey above.

## Post-replay review correction

Adversarial review subsequently narrowed the first-call trigger, aligned
`RESOLVER.md` and `query.md`, and made the short fallback sections authoritative.
The resulting `SKILL.md` digest is
`a9971185b51e6ea38deac33fb9962a220b84a4d54f1f80bc78af1556452a2b06`.
These corrections preserve the replayed healthy-empty F2 call and terminal shape;
they add a separate fail-closed F3 rule. The original 3/3 host replay above remains
the behavioral evidence rather than being relabeled as a run of the later digest.
The later digest is covered by deterministic contract mutations and requires the
normal post-deployment Hermes canary before release completion.

## Isolation and teardown

- All CBrain writable paths resolved under one disposable root.
- Hermes home, state database, logs, managed files, and caches resolved under the
  same disposable root.
- The only network call made by CBrain was to the local deterministic embedding
  endpoint; the model call used the reviewed Hermes provider.
- Scratch job state: empty before; empty after.
- The local embedding process was stopped and the complete disposable root,
  including the temporary OAuth copy and Hermes session state, was removed after
  fixed-journey confirmation. Teardown postcondition: the owned root no longer
  exists.
