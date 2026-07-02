# Personal Tag Classifier — Design (Phase 1)

> Issue: [#236](https://github.com/chenhong268/cbrain/issues/236)
> Date: 2026-07-01
> Status: Approved — design review comment `4850956796`, scope clarification `4850536605`
> Base: `main` @ `521fa4e` (v2.0.4)
> Execution: isolated worktree, single independent commit, **no push, no issue close**

## Context

CBrain persists durable records with caller/frontmatter tags but has no low-noise
substrate for personal memory. When Hermes/Agent ingests a clear personal fact
(preference, habit, life event, reflection), nothing distinguishes it from work
or research material. This spec adds a **conservative, deterministic write-path
classifier** that merges a `personal` tag only when the content is clearly about
the user's personal context.

It improves natural recall filtering without touching vault layout, slug
behavior, ontology, schema, recall ranking, or the dialogue capture path.

## Goal

`ingest` / MCP ingest / CLI ingest writes automatically add `personal` to tags
**only** when incoming content is clearly personal and long-term useful, merged
via set union with existing tags, never overwriting or removing them.

## Scope

**In (Phase 1):**
- `src/core/ingestion/ingest.ts` — `ingestText`, `ingestMarkdown`, `ingestEntityAppend` durable write paths.
- New pure classifier module under `src/core/`.
- CLI + MCP ingest layers inherit behavior through `IngestManager`.

**Out (deferred / forbidden):**
- `src/core/ingestion/dialogue.ts` — `DialogueIngest`, its prompt, entity-stub creation, relation/event/fact extraction, and generated tags are **untouched**. Rationale: dialogue does not persist original dialogue as a durable personal record; it extracts entity stubs. Tagging a stub as `personal` mislabels an entity page, and the dialogue auto-prompt intentionally skips preferences/feelings without concrete facts — exactly where personal signals live. Making dialogue store those is a separate product/architecture change.
- No schema, table, or migration.
- No slug, file-path, vault-directory, or ontology behavior changes.
- No recall, search, or ranking changes.
- No `nerMode` / `skipNer` / `ner-backfill` / Dream Stage 1.5 behavior changes.
- No MCP tool-profile or MCP surface changes.
- No personal digest, profile update, proactive notification, or dashboard.

## Approach

| | Approach | Verdict |
|:-:|:--|:--|
| **A** | **Layered gates**: routing-marker → guardrail → positive, short-circuit | **Adopted** |
| B | Weighted score (signal sum over threshold) | Rejected — violates fail-closed, ambiguous cases misclassified, hard to explain. |
| C | NER-derived (infer from extracted entities) | Rejected — wrong timing: classifier must run before durable write; NER runs after and may defer. Also violates the pure (no DB/IO) constraint. |

Layered gates give conflict-wins natively (guardrail short-circuits positive),
which is the core review-focus requirement: **over-tagging work/research content
is the failure mode to prevent.**

## Module

New file: `src/core/ingestion/personal-tag-classifier.ts`

```ts
export interface PersonalTagInput {
  title?: string;
  content: string;
  tags?: string[];
}

/**
 * Deterministic, pure classifier. Returns true when content is clearly
 * personal long-term memory and no guardrail/routing-marker vetoes it.
 *
 * No LLM, no DB, no file IO. Source-agnostic — no mode/source param in Phase 1.
 * Conflict or uncertainty → false (fail closed).
 */
export function classifyPersonalTag(input: PersonalTagInput): boolean;
```

Design rules:
- **Pure**: no side effects, no async, no external calls.
- **Source-agnostic**: no `mode` / `source` parameter (YAGNI — the rule set does not branch on caller).
- **Fail closed**: any ambiguity, conflict, or missing signal → `false`.

## Classification Logic

Three gates evaluated in order; first decisive gate wins. Input text = `title + "\n" + content`, lowercased for matching; `tags` consulted only at Gate 0 (routing-marker veto). Idempotency is handled by the downstream set union (tags are only ever added, never removed), not by the classifier.

### Gate 0 — routing-marker (veto, highest)

If `tags` contains any of `agent_profile`, `action_loop`, `no_store` → **false**.

These are `signal-router` destinations, not CBrain memory. Normal ingest will
not carry them; this is a defensive check that satisfies the issue's "do not
tag control signals as CBrain memory" requirement.

### Gate 1 — guardrail (veto, overrides positive)

If the text hits **any** guardrail term → **false**, regardless of positive signals.
Conflict wins. Terms (case-insensitive, CN + EN):

| Category | Terms |
|:--|:--|
| Article / research / news | `文章 论文 研究 报告 行业 资讯 调研 新闻 白皮书 article paper research report industry news whitepaper` |
| Technical / engineering | `技术 架构 代码 系统 模块 组件 服务 接口 实现 重构 部署 运维 巡检 线上 technical architecture code system module component service api implementation refactor deploy deployment maintenance infra infrastructure` |
| Project / product | `项目 产品 需求 迭代 版本 功能 bug feature project product requirement version release` |
| Issue / PR / review | `issue pr pull request commit 分支 merge ticket review cr` |
| Work / team / business | `工作 团队 会议 职责 岗位 职位 汇报 业务 公司 组织 部门 客户 合作 work team meeting okr kpi business org organization department stakeholder` |

The `运维 / 巡检 / maintenance / system / 系统` entries exist specifically so that
`日常运维`, `巡检流程`, `system health`, `系统健康检查` are vetoed before the
positive `健康 / routine / health` signal can fire.

### Gate 2 — positive (hit → true)

If the text hits a positive term and Gate 1 did not fire → **true**. Two families:

**A. Possessive preference/habit** (first-person + pref/habit):
- CN: `我的偏好`, `我的习惯`, `我的喜好`, `我喜欢`, `我爱`, `我偏好`, `我习惯`, `我一般`, `我通常`, `我总是`
- EN: `my preference`, `my habit`, `my taste`, `i prefer`, `i like`, `i love`, `i always`, `i usually`

**B. Strong life signal** (domain term; **first-person NOT required**):
- Health: `健康 看病 体检 失眠 焦虑 运动 跑步 健身 锻炼 过敏 health workout fitness insomnia allergy`
- Family/relations: `家人 父母 妈妈 爸爸 孩子 儿子 女儿 老婆 妻子 丈夫 老公 兄弟 姐妹 朋友 family parent mother father kid spouse wife husband sibling`
- Routine/life/hobby: `作息 周末 假期 旅行 旅游 爱好 兴趣 读书 阅读 电影 音乐 游戏 烹饪 宠物 生活 日常 routine hobby interest reading movie music travel pet lifestyle`
- Reflection: `反思 感悟 心情 情绪 日记 reflection journal`

Justification for non-first-person life signals (decision `4850956796`): personal
memory often arrives as short notes ("周末去 旅行", "最近 失眠"), not fully phrased
first-person sentences. These are accepted as long as no guardrail fires.

### Gate 3 — fail closed

No routing-marker veto, no guardrail hit, no positive hit → **false**.

### The "个人" trap

The bare word `个人` / `personal` is **NOT** a positive signal on its own.
This is the central over-tagging defense (issue review focus):

- `个人 OKR`, `个人贡献`, `我个人负责的模块` → guardrail (`OKR` / `职责` / `模块`) → **false**.
- Business/technical text containing the English word `personal` → **false** (no positive life signal).
- Only possessive phrasing (`我的偏好`) or a strong life domain term is positive.

### Reading / 读书 / reading

`读书 / 阅读 / reading` are positive (life interest), **but**:
- `阅读论文`, `行业阅读`, `研究报告阅读` → guardrail (`论文` / `行业` / `研究`) → **false**.

The guardrail short-circuit handles the work-reading case without special-casing.

## Integration (`src/core/ingestion/ingest.ts`)

The classifier is pure and runs at the **entry** of each ingest path to compute
effective tags. All dedup gates, NER, and the ContentPipeline sit downstream and
are unaffected.

### Text ingest — `ingestText`

After `routedPersonTitle` / `rawTitle` resolve and before the
`findExistingPersonSlug` branch, compute a single `effectiveTags` from
`input.tags ?? []`, unioning `"personal"` when the classifier returns true on
`{ title, content: input.content, tags }`. Use `effectiveTags` for **both**
the `ingestEntityAppend` call (line ~239) and the `ingestCore` call (line ~248).
One injection point covers the whole text path.

```ts
const baseTags = input.tags ?? [];
const effectiveTags = classifyPersonalTag({ title: input.title ?? routedPersonTitle ?? rawTitle, content: input.content, tags: baseTags })
  ? [...new Set([...baseTags, "personal"])]
  : baseTags;
```

### Markdown ingest — `ingestMarkdown`

Respect existing precedence (`parsed.frontmatter.tags ?? input.tags ?? []`, line ~219), then run the classifier against `parsed.body` (frontmatter stripped) + `title` + the base tags, union `"personal"` into the effective tags before `ingestCore` (line ~221).

```ts
const baseTags = parsed.frontmatter.tags ?? input.tags ?? [];
const effectiveTags = classifyPersonalTag({ title, content: body, tags: baseTags })
  ? [...new Set([...baseTags, "personal"])]
  : baseTags;
```

### Entity append — `ingestEntityAppend`

Reaches `pages.patch({ tags_merge })`. `PageManager.patch` already merges via
set union (`page.ts:469`: `[...new Set([...currentTags, ...updates.tags_merge])]`),
so `personal` is safely unioned and existing tags (`auto-extracted`,
`duplicate-candidate`) are preserved. Because text-path injection computes
`effectiveTags` upstream, the append call already carries `personal` when
appropriate — no separate injection needed here.

## Boundary Guarantees

| Concern | Guarantee |
|:--|:--|
| Duplicate / no-op | Classifier is a pure entry-point function; the `ingestCore` dedup gate (~:414-446) returns `duplicate` without writing, so no tag side effect. |
| `nerMode` / `skipNer` / ner-backfill / Dream 1.5 | Classifier runs before `ingestCore`; never touches `resolveNerAction`, the submitter, or ContentPipeline. |
| MCP tool profiles / MCP surface | Untouched (#251/#260). |
| ContentPipeline | Remains the single deterministic write/index path; this issue is metadata classification only. |
| Slug / file path / ontology / vault dir | Untouched. |
| Recall / search / ranking | Untouched. |
| Existing caller/frontmatter tags | Preserved; `personal` only added via set union; idempotent. |

## Testing (RED-first, anonymous fixtures only)

Fixtures use sentinels only: `人物A / 事件B / 主题C / 资料D / 地点E` plus synthetic
`偏好X / 项目Y / 主题Z`. **No real names, companies, products, paths, or private
content** anywhere in tests, docs, comments, or logs (privacy scan is resident).

### `tests/core/personal-tag-classifier.test.ts` (new — pure classifier matrix)

Positive → `true`:
- possessive preference: "我的偏好是 偏好X" / "my preference is 偏好X"
- habit: "我习惯 每天 偏好X" / "I usually 偏好X"
- health (no first-person): "最近 失眠" / "morning workout"
- family: "妈妈 来看 我" / "kid's birthday"
- hobby: "周末 读书" / "reading on weekends"
- reflection: "复盘 这周 的 生活" / "journal reflection"

Guardrail → `false` (even with a life word present):
- `system health` / `系统健康检查`
- `team health` / `团队健康度`
- `maintenance routine` / `巡检流程` / `日常运维`
- `行业阅读` / `阅读论文` / `研究报告`
- article/research/project/technical/business/team material
- issue/PR/code/architecture/design-plan material

Bare "personal" → `false`:
- business/technical text containing `personal` (e.g. "个人 OKR", "personal contribution to 项目Y")

Mixed → `false`:
- work + life signal in the same content (e.g. "项目Y 让 我 失眠")

Routing marker → `false`:
- `tags` includes `agent_profile` / `action_loop` / `no_store`

Idempotent (union guarantees preservation):
- input already containing `personal` tag → classifier still returns based on content; the downstream set union never removes an existing `personal` tag, so re-ingest never drops it.

### `tests/core/ingest.test.ts` (extend — `IngestManager`)

- text ingest, clear personal preference → page written with `personal` in tags.
- markdown ingest, clear personal content → `personal` added, frontmatter tags preserved.
- caller-provided tags preserved and deduped.
- business/project/research text → no `personal`.
- ambiguous mixed text → no `personal`.
- entity append of clearly-personal text → `personal` merged, existing `auto-extracted` kept.
- duplicate/no-op ingest → no durable tag side effect.

### `tests/mcp/ingest-classify.test.ts` (extend — MCP layer)

- MCP `ingest` with clear personal content → durable page carries `personal` tag (same behavior as core).

### Dialogue

Not touched. No `DialogueIngest` test additions for #236.

## Privacy

All fixtures, doc examples, and comments use anonymous placeholders. No real
names, companies, products, organizations, paths, emails, or private content —
not even as negative assertions. The classifier dictionaries contain only
generic domain words.

## Verification

```bash
bun test tests/core/personal-tag-classifier.test.ts
bun test tests/core/ingest.test.ts
bun test tests/mcp/ingest-classify.test.ts
bun run lint
bun run check   # full gate before handoff if practical
```

If `bun run check` is impractical, report exactly which focused gates ran and
why full check was deferred.

## Non-goals

No vault directory changes (`records/personal/`). No new table or migration.
No LLM classifier. No recall/search/ranking changes. No personal digest, profile
update, proactive notification, or dashboard. No `raw/` changes. No broad rewrite
of ingest/dialogue extraction. No slug/path/ontology changes.

## Future extensions (separate issues)

- personal-only recall filter
- personal memory digest
- user-confirmed profile candidate extraction
- personal timeline
- personal topic clustering
- personal recall weighting
- privacy-aware export/sharing defaults
- (possible) dialogue creating a separate durable personal record — product/architecture decision, not this issue.
