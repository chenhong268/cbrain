# Source-backed topic pages

## Approved scope

The user approved this design in conversation on 2026-09-13 and asked for implementation and rollout. Store generated topic Markdown in `brain/topics/`, preserve original records, begin with at most five topics supported by at least three distinct original records, then maintain them automatically. The existing recall front door remains the daily interface. No new database engine, service, MCP tool or standalone framework.

## Evidence and complexity decision

Current `ReflectManager` returns short entity summaries; it does not maintain source-versioned topic pages. `PageManager`, `ContentPipeline`, `VersionManager`, the job queue and hybrid search already exist. The missing behavior is a generated page whose validity follows its sources, including corrections and deletion. The decision is **split**, as already discussed with the user: bounded compilation, maintenance, then recall integration. New topic state and production code beyond 300 lines are necessary for the explicitly approved lifecycle; do not expand this into a general document compiler.

## Contract

- Add ontology page type `topic` with `vault_dir: brain/topics`. Generated topics must never feed NER, original-source discovery, independent evidence counts or another topic's source set.
- Source discovery considers actual record pages and their provenance, existing tags and links. Do not use `mention_count` (open issue #508). Count distinct records, not chunks or generated entities. Read full selected material within explicit budgets; reject oversize inputs rather than silently treating truncation as complete evidence.
- A topic contains a concise overview, principal observations, details, disagreements/open questions and explicit source links. User thoughts and unconfirmed assertions stay labeled. Model output is untrusted. Validate structured output and exact source excerpts. A model can synthesize but cannot promote trust states.
- Persist a versioned manifest in the topic's existing frontmatter: selected source slugs, source content fingerprints, relevant governance fingerprints, generation time and output fingerprint. Read from disk rather than trusting a stale `PageManager` cache. No new DB table is required for the initial bounded set.
- Recheck sources and target after LLM work and embedding, before commit. Source changes, deleted sources, invalid output, cancellation and concurrent user edits must leave previous content intact. Save previous version before replacement; use the existing indexing path. Failed indexing must not make the new topic usable as current. Never silently overwrite a user edit.
- Source freshness includes record content and relevant link/timeline trust/provenance changes, not just a timestamp. New-source discovery runs with maintenance. Where exact new-source membership is unknown, conservatively treat a changed record catalog as requiring reconciliation (at most five initial pages); explain this bounded tradeoff instead of claiming perfect immediate semantic classification.
- A generated topic is a derived reading aid, not independent corroboration. Raw-detail, temporal and verification questions must remain grounded in original records. Stale/invalid topics cannot contribute old body/snippets to current recall or read-page output. Ordinary queries with no topic candidates avoid filesystem scans and LLM work.
- Existing maintenance job access may run topic preview/refresh/enable/disable; no new daily tool. Persist enablement in existing config state, default off until the authorized pilot is activated. Reuse the job queue for execution. Coalesce pending work, refresh on a 30-minute cadence, reconcile on startup and daily, and stop scheduling on shutdown. Explicit refresh bypasses the cadence, never the validity guards. No model call when inputs are unchanged.
- Initial discovery previews are read-only. Before first real writes: backup, exact maximum five topic pages, private receipt, and source boundary audit. Test fixtures, issues and PRs contain anonymous material only.

## Verification

Real temporary SQLite/vault fixtures with a fake external model/embedding only: three records -> indexed topic -> unchanged no-op -> changed record invalidates -> regenerate -> corrected/deleted source stops old recall; hallucinated citations, generated-source input, late source changes, failed model/indexing, cancelled job, manual edit and restart. Test timer coalescing without wall-clock sleeps. Run existing ontology/page/sync/recall/job suites, CI gate and independent review before integration. Rollout uses the shared single writer and a real MCP recall; do not claim deployment from tests alone.
