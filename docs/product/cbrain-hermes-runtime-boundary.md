# CBrain / Hermes Runtime Boundary

> Status: Product architecture planning
> Date: 2026-06-04
> Scope: v2.0 productization and post-2.0 agentic workflow planning

## Core Decision

CBrain should not become a self-contained all-purpose Agent. CBrain is the deterministic memory and research kernel. Hermes is the runtime, user-experience layer, and agentic orchestrator.

The product goal is:

> CBrain provides reliable, inspectable memory primitives; Hermes turns those primitives into natural conversation, task routing, periodic workflows, and multi-agent execution.

This keeps CBrain stable and auditable while letting Hermes iterate quickly on interaction patterns, skills, cron workflows, and agentic behaviors.

## Boundary Principle

Add a capability to CBrain only when it must be deterministic, durable, queryable, auditable, or shared across Agent runtimes.

Prefer Hermes when the capability is primarily about routing, expression, workflow orchestration, scheduling, delegation, or user-facing behavior.

## CBrain Owns

| Area | CBrain Responsibility | Reason |
| --- | --- | --- |
| Memory storage | pages, records, links, timeline, chunks, indexes | Durable knowledge needs a stable source of truth. |
| Trust and provenance | trust_state, source_type, correction history, active evidence filtering | Fact authority must not depend on prompt behavior. |
| Ontology and constraints | entity types, relation types, structured fields, validation | Schema and graph rules must be deterministic. |
| Retrieval primitives | deep_recall, get_org_tree, recall_episode, EvidenceBoard, query, summarize | Hermes needs reliable tools, not ad hoc file parsing. |
| Data safety | put/patch/append, version snapshots, merge preview, rollback, consistency checks | Writes must be predictable and reversible. |
| Observability | degraded reason codes, search trace, health summaries, relation audit | Product quality needs measurable signals. |
| Maintenance primitives | sync, dream, health, dedup, watcher, quarantine, backup/restore | Long-running state management belongs to the kernel. |

## Hermes Owns

| Area | Hermes Responsibility | Reason |
| --- | --- | --- |
| Natural language routing | choose the right CBrain tool or skill from user intent | Users should not remember tool names. |
| First-turn UX | short answers, no raw fields, no tool narration, no unnecessary expansion | User experience is conversational, not diagnostic. |
| Progressive disclosure | decide when to call get_page, get_pages, timeline, graph, or artifacts | Expansion depends on dialogue context. |
| Skills | review, connect, write, cleanup, episodic recall, discovery review | Reusable workflows evolve faster than core APIs. |
| Cron workflows | daily digest, weekly review, low-frequency compounding review | Scheduling and notification budget are runtime concerns. |
| Multi-agent work | fan-out analysis, adversarial review, long-running research | Expensive reasoning should be orchestrated outside the kernel. |
| Session context | conversation history, compression, temporary working memory | Runtime context is not durable knowledge by default. |
| User confirmation | lightweight confirm/reject/defer phrasing | The kernel records state; Hermes asks naturally. |
| Platform gateways | chat platforms, webhooks, notifications | Transport is outside the knowledge kernel. |

## Shared Contract

CBrain tools must return bounded, structured envelopes:

- `display`: safe natural-language summary for Hermes to use directly.
- `summary`: compact status for routing and branching.
- `raw`: complete bounded payload for debug, audit, and follow-up tool calls.

Hermes must treat `display` and `summary` as the normal user-facing layers and use `raw` only for reasoning, routing, or troubleshooting.

## Practical Design Rules

1. CBrain should expose capabilities, not conversation scripts.
2. Hermes should compose capabilities, not bypass CBrain data governance.
3. CBrain may suggest next actions in `summary.next_steps`, but Hermes decides how to phrase them.
4. Hermes may propose memory updates, merges, corrections, or confirmations, but CBrain performs the write through deterministic APIs.
5. Any Agent-inferred fact remains `candidate` unless backed by explicit source or user confirmation.
6. A workflow that needs cron, delegation, context compression, or multi-platform notification belongs in Hermes first.
7. A workflow that changes graph state, trust state, provenance, index consistency, or versions belongs in CBrain.

## v2.0 Planning Implications

The v2.0 release should focus on making CBrain dependable and usable through Hermes, not on embedding more autonomous behavior inside CBrain.

### Keep In CBrain Before v2.0

- Degraded diagnostics and health summary.
- EvidenceBoard as the default grounded answer core.
- Reviewed entity merge workflow with preview and verification.
- Watcher backpressure and runtime stability.
- Safe write paths, consistency checks, provenance, and recovery.
- Installation and first-run validation.

### Move To Hermes / Skills Before v2.0

- Natural routing rules for query vs deep_recall vs get_org_tree vs recall_episode.
- First-turn short answer discipline and second-turn expansion behavior.
- User-facing formatting of health, discovery, dream, provenance, and degraded diagnostics.
- Cron prompts and delivery format for daily/weekly CBrain summaries.
- Release-gate smoke tests that run through Hermes-style prompts.

### Defer Until Post-2.0

- NER adversarial verification agent.
- Typed ingest router with per-content workflow harnesses.
- Bulk ingest fan-out and barrier review.
- Multi-agent research workflows.
- Automatic compounding review orchestration beyond strict low-frequency gating.

These should be implemented primarily through Hermes skills, cron, and delegation, while CBrain supplies deterministic write, retrieval, evidence, and audit APIs.

## Current Issue Mapping

| Issue | Boundary Decision | Planning Note |
| --- | --- | --- |
| #134 degraded diagnostics | CBrain owns reason codes and health aggregation; Hermes owns explanation to user. | Do not expose debug fields in normal display. |
| #139 EvidenceBoard default | CBrain owns evidence structure; Hermes owns final phrasing and progressive disclosure. | Keep EvidenceBoard compact and source-aware. |
| #135 reviewed merge | CBrain owns preview, verification, write, rollback; Hermes owns confirmation dialogue. | No manual SQL or ad hoc merge by Agent. |
| #128 watcher backpressure | CBrain owns runtime stability and backpressure gate. | Hermes only reports status or asks user to retry. |
| #29 bulk curation | CBrain owns safe batch primitives; Hermes owns guided maintenance workflow. | Require preview and explicit confirmation. |

## Hermes Skills Pack Direction

For v2.0, CBrain should ship or document a Hermes-oriented skills pack:

- `hermes-cbrain-brief.md`: startup routing contract.
- `recall-resolver.md`: natural query to MCP tool routing.
- `review.md`: full review workflow.
- `connect.md`: relationship analysis workflow.
- `cleanup.md`: guided maintenance workflow.
- `write.md`: CBrain-grounded writing workflow.
- `dream.md`: maintenance summary workflow.

Acceptance should verify that these skills route normal user language without requiring users to know CBrain tool names.

## Release Gate Additions

Before v2.0, add a Hermes-facing release gate in addition to `bun run check`:

1. Run anonymous natural-language smoke prompts.
2. Verify Hermes-style routing chooses the expected CBrain tool.
3. Verify first answer is short, useful, and free of internal fields.
4. Verify second-turn expansion uses the correct detail tool.
5. Verify degraded diagnostics are explainable without exposing raw trace.
6. Verify maintenance/discovery/dream outputs are user-facing summaries, not logs.
7. Verify no fixture or issue text contains private real-world identifiers.

## Non-Goals

- Do not move durable memory storage into Hermes memory.
- Do not let Hermes modify graph state except through CBrain tools.
- Do not use Hermes skills to bypass CBrain trust_state or provenance rules.
- Do not add Agent delegation inside CBrain core for v2.0.
- Do not treat other Agent runtimes as equal targets before Hermes UX is stable.

## Summary

CBrain should become more kernel-like as it matures: dependable, typed, observable, recoverable, and conservative.

Hermes should become more fluent as it matures: better routing, better phrasing, better timing, better task orchestration, and better use of CBrain without exposing CBrain's machinery to the user.

This division lets CBrain 2.0 be both technically solid and naturally useful.
