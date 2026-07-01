# MCP Tool Consolidation Audit

> Generated for #251. This is an audit **input** for follow-up issues — no tools are merged in #251.
> Profiles (`agent` / `maintenance` / `debug` / `full`) already reduce cognitive load at the exposure layer;
> consolidation is a separate, opt-in step that must coordinate with Hermes skill updates.
>
> Scope of #251 Phase 1: profiles + this audit. Scope of later issues: the merges proposed here.

## Summary

84 tools today: 81 via `registerTool`, 3 legacy `server.tool` (provenance). Many cluster into domain groups whose members differ only by an action verb. A unified tool with an `action` parameter would shrink the surface, but each merge is a breaking change for any caller that references the old names (notably Hermes skills).

## Merge candidates

For each group: **proposed** unified tool · **compat concern** · **risk** · **timing** (before or after Hermes skill updates).

| Group | Members | Proposed unified | Compat concern | Risk | Timing |
|:------|:--------|:-----------------|:---------------|:-----|:-------|
| Tag ops | `get_tags`, `add_tag`, `remove_tag` | `tag` (action: list / add / remove) | Hermes skills call by exact name | Low | After |
| Alias ops | `add_alias`, `remove_alias` | `alias` (action: add / remove) | Same | Low | After |
| Link ops | `add_link`, `remove_link`, `get_links` | `link` (action: list / add / remove) | Same | Low | After |
| Hierarchy | `set_hierarchy`, `get_hierarchy`, `remove_hierarchy` | `hierarchy` (action: set / get / remove) | `get_org_tree` stays separate (different shape) | Medium | After |
| Job ops | `job_submit`, `job_list`, `job_status`, `job_cancel`, `job_retry` | `job` (action: submit / list / status / cancel / retry) | Maintenance cron calls `dream`, not the job tools directly — relatively safe | Medium | After |
| Dream | `dream`, `dream_status`, `dream_reset` | `dream` (action: run / status / reset) | `bin/cbrain-maintenance.sh` calls `dream` — keep run as the default action | Medium | After (coordinate with the wrapper) |
| Batch | `batch_delete_pages`, `batch_add_links`, `batch_merge_pages` | `batch` (action: delete_pages / add_links / merge_pages) | Lower traffic | Low | After |
| Profile | `get_profile`, `update_profile`, `remove_profile`, `reload_profile` | `profile` (action: get / update / remove / reload) | Hermes uses the get/update variants | Medium | After |
| Insights | `list_insights`, `get_insight`, `archive_insight`, `dismiss_insight`, `query_insights`, `promote_discovery` | `insight` (action: list / get / archive / dismiss / query / promote) | Many call sites | Medium | After |

## Keep separate

These must NOT merge — different layers, semantics, or shapes:

- `merge_pages` (record / source layer) vs `merge_entities` (derived layer) — the canMerge layer rule forbids cross-layer merges.
- `query` vs `cbrain_recall` vs `deep_recall` — intentionally tiered recall (raw / frontdoor / deep). Merging defeats the routing goal of #251.
- `ingest` vs `ingest_dialogue` — different input shapes and pipelines.
- `get_page` / `get_pages` / `list_pages` — single vs plural vs raw listing are distinct access patterns.
- Provenance trio (`get_provenance`, `set_trust_state`, `confirm_evidence`) — legacy `server.tool` API; consolidate only after migrating them to `registerTool` (which also gains them error sanitization — call that out as a behavior change).

## Recommended sequencing

1. Ship profiles (#251) — done first, so we can observe Agent routing with a bounded surface before any merge.
2. Migrate the three provenance tools from `server.tool` to `registerTool` (this gains them error sanitization — document it as an intentional behavior change).
3. Merge low-risk groups (tag / alias / link / batch) behind the existing names as deprecated aliases first.
4. Update Hermes skills to call the unified names.
5. Remove the deprecated aliases once no caller references them.
