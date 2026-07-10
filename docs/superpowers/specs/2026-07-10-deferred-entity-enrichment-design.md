# Deferred Entity Enrichment Design (#321)

## Problem

`ner.ingest_mode=defer` removes ordinary NER from the write critical path, but
entity pages still await `extractEntityFacts()` synchronously. The existing
backfill processor also retries pages that can never be processed because their
source page or recoverable raw body no longer exists.

## Design

### One durable queue

Reuse the existing `ner-backfill` job and add a backward-compatible `kind`:

- absent or `ner`: existing NER behavior;
- `entity_facts`: targeted entity frontmatter extraction.

No body, title, path, or private text is stored in job data. The processor
reloads the current page and raw chunks by slug inside the trusted runtime.

### Write-path behavior

- `sync`: preserve the current inline entity-facts behavior.
- `defer`: submit one deduplicated `entity_facts` job and return after the page,
  chunks, FTS, vectors, and wikilinks are durable.
- `off`/`skipNer`: do not submit or call an LLM.

The queue adapter remains the only dependency of `IngestManager`; there is no
fire-and-forget promise.

### Processor behavior

Move targeted extraction into a shared helper used by sync ingest and deferred
processing. The helper only writes whitelisted empty fields and never replaces
an existing value.

Classify outcomes:

- missing/malformed job slug, missing page, or no recoverable body: terminal
  `done` with `{outcome:"skipped", reason:<fixed enum>}`;
- provider error or timeout: retryable through existing `failJob` attempts;
- success or valid no-facts response: `done`.

Result/error data uses fixed reason codes only. It must not contain slug, title,
body, evidence text, paths, or provider response content.

## Non-goals

- No new table, scheduler, or always-on worker.
- No LLMProvider interface change and no prompt redesign.
- No automatic overwrite of existing trusted frontmatter.
- No search/ranking/index ownership change.

## Acceptance

- Deferred entity writes make zero LLM calls before returning.
- Entity source content is searchable before backfill.
- Dream/manual backfill completes entity facts with the current page content.
- Permanent source loss terminates once; provider failure remains retryable.
- Sync/off/skipNer and legacy jobs remain compatible.
- Tests and persisted diagnostics contain anonymous fixtures and fixed codes.

