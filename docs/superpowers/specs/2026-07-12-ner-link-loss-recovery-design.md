# NER Mention Link Loss Recovery Design

> Issue: #329
> Scope: prevent wikilink replacement from destroying NER-owned mention links,
> and reuse the existing durable NER backfill path after synchronous NER failure.

## Problem

`ContentPipeline.replaceWikilinks()` currently deletes every outgoing `提及`
edge before inserting links parsed from Markdown. The deletion ignores
`source_type`, so it also removes NER, manual, and dialogue edges. In deferred
mode the replacement happens before the `ner-backfill` job runs. In synchronous
mode an extraction timeout/error is caught and the ingest succeeds. In either
case, a failed NER run can leave the page permanently without its prior NER
mentions.

## First-Principles Invariants

1. A writer may replace only data it owns.
2. Explicit Markdown wikilinks are stronger evidence than NER candidates.
3. NER failure must not destroy the last known graph state.
4. Recovery must reuse the durable `ner-backfill` queue; no second marker,
   scheduler, table, or migration is allowed.
5. Ingest remains fail-open for NER errors: page, chunks, FTS, and vectors stay
   available.

## Design

### Wikilink ownership

Add two narrow storage operations:

- `deleteWikilinkMentions(fromSlug)` deletes only rows with
  `relation='提及' AND source_type='wikilink'`.
- `upsertWikilinkMention(fromSlug, toSlug)` inserts a trusted wikilink mention.
  On the existing `(from_slug,to_slug,relation)` unique key, it promotes a weak
  NER/dialogue/unknown row to `source_type='wikilink'`, `trust_state='trusted'`,
  weight `0.3`, strength `weak`, confidence `0.9`, and source page provenance.
  An existing `manual` row remains manual because it is already explicit human
  evidence.

`replaceWikilinks()` calls only these operations. It never deletes NER,
manual, or dialogue mentions.

### Durable fallback after synchronous failure

The MCP/CLI contexts already inject `JobQueueNerSubmitter`. In both regular
ingest and entity-append paths, an NER timeout/provider error:

1. keeps returning `nerSkipped: 'timeout' | 'error'`;
2. submits a deduplicated `ner-backfill` job when a submitter exists;
3. returns `nerPending: true` when recovery is durably represented;
4. records only bounded recovery flags in the ingest log.

When a direct library caller constructed `IngestManager` without a submitter,
the path stays fail-open and returns `nerPending` absent. Source ownership still
prevents destructive link loss.

### Existing damaged pages

Production repair is operational and happens only after the code is merged.
Maintenance submits one existing `ner-backfill` job per affected page. Public
artifacts contain only anonymous counts, never real slugs or page content.

## Known Trade-off

This phase prioritizes no-loss semantics. NER candidate mentions that no longer
match edited content may remain until a successful source-aware NER replacement
is designed. Exact stale-NER pruning is a separate phase because current
`processNer()` does not expose a complete desired mention set and the links
unique key does not model multiple provenance rows. This issue must not hide a
schema or graph-semantics change inside an urgent fix.

## Non-goals

- No links unique-key migration or multi-provenance edge model.
- No NER prompt, entity resolver, ranking, or ingest-mode change.
- No automatic production repair in tests or runtime startup.
- No broad rewrite of NER relation replacement.
- No push, merge, tag, release, or issue close from the implementation branch.

## Acceptance Tests

1. NER/manual/dialogue mentions survive wikilink replacement.
2. Removed wikilinks are deleted; new wikilinks are added.
3. A same-edge NER candidate is promoted to one trusted wikilink row.
4. A same-edge manual row remains manual.
5. Sync NER timeout and provider error keep prior NER mentions and enqueue one
   durable job with `nerPending=true`.
6. Repeated failures for one slug do not create multiple active backfill jobs.
7. Deferred ingest remains non-blocking and keeps existing NER mentions.
8. Backfill retry semantics and all existing ingest tests remain green.
9. Fixtures and diagnostics are anonymous and contain no local paths/content.

