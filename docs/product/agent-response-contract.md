# Agent Response Contract

> Channel-safe response contract between CBrain and Hermes.
> This document is the normative spec. Tool implementations follow in downstream issues.

## 1. Three Layers

CBrain responses have three layers. Hermes consumes them differently:

| Layer | Purpose | Who sees it |
|:------|:--------|:-----------|
| `display` | User-safe natural-language answer | User (via Hermes) |
| `summary` | Compact status for routing and branching | Hermes (for flow control) |
| `raw` | Complete payload for debug, audit, follow-up tool calls | Hermes only, never user |

### `display` Target Shape

Not all tools produce every field. The contract defines the target; individual tools may omit fields that don't apply.

```
display.title          — one-line headline
display.answer         — core answer or conclusion (1-3 sentences)
display.key_points     — bullet list of key findings (max 5)
display.evidence       — supporting details (max 3 items)
display.gaps           — what's missing or uncertain
display.next_actions   — suggested follow-up (max 2)
```

### `summary` Fields

```
summary.status         — "ok" | "empty" | "degraded" | "error" | "recorded" | "skipped" | "needs_review"
summary.message        — one-line human-readable status
summary.count          — result count (retrieval tools)
summary.truncated      — boolean
summary.confidence     — "high" | "medium" | "low" (when applicable)
summary.next_steps     — optional suggested actions
summary.degraded_reason — optional, only when status = "degraded"
```

### `raw` Rules

`raw` contains complete structured data for audit and follow-up tool calls. Hermes may read `raw` for reasoning but must never render it to the user.

## 2. Agent Expression Rules

How Hermes turns CBrain output into user-facing messages:

1. **Lead with the answer** — first sentence is the conclusion, not the process
2. **Keep first response compact** — target short-message channel limits by default
3. **Use bullets for scanability** — avoid dense paragraphs
4. **Mention uncertainty only when it changes interpretation** — don't qualify everything
5. **At most one proactive insight per response** — don't overwhelm
6. **Progressive disclosure** — summarize first; expand only when user asks
7. **Never expose internal fields** — see ban list below

### Progressive Disclosure

```
First response:    answer + key points (compact)
User says "展开":  + evidence + gaps
User says "详细":  full depth, may use long-form channel rules
```

## 3. Channel Classes

| Channel | Length budget | Format | Notes |
|:--------|:-------------|:-------|:------|
| Short-message (iMessage, WeChat) | 300-500 chars Chinese | Compact bullets, no tables, no markdown headers | Default target for all first responses |
| Long-form (Telegram, Slack thread, Email) | 800-1500 chars | May use sections, longer evidence, structured summaries | Only when user asks for detail |
| CLI/debug (Terminal) | Unlimited | May show diagnostic context when explicitly requested | `debug: true` mode |
| Web/card (Web UI, App) | Unlimited | May use cards, timelines, tables, expandable sections | Future |
| Voice | 100-200 chars | Shorter, fewer bullets, no dense lists | Future |

**Rule: short-message is the default.** All first responses must work within 300-500 chars. Longer format is opt-in via user request or channel detection.

## 4. Banned Fields

User-facing output must never contain:

- `slug` — use title/name
- Raw JSON — always render as natural language
- `score`, `distance`, `similarity` — use confidence levels (high/medium/low)
- `shared_neighbors`, `hops`, `bridge` — use relationship descriptions
- `debug`, `_debug`, `trace` — never in user output
- `candidate`, `filter`, `reason_codes` — internal pipeline terms
- `vector`, `embedding`, `latency_ms`, `threshold` — implementation details
- `degraded_reason` — handle silently, don't show to user
- `_stub`, `source_type`, `weight` — internal markers
- Local file paths (`/tmp/`, `runtime/`, `.json`, `.md` as report paths)
- SQL, stack traces, tool names (unless client UI already shows them)
- Internal candidate/filter/reason fields from any pipeline

## 5. Response Families

Each response family has a first-response template. These are targets, not hard requirements for existing tools.

### Grounded Recall (核查确认)

```
✅ 确认：[结论]
- [关键依据 1]
- [关键依据 2]
⚠️ [不确定之处]（如有）
```

### Content Recall (内容回忆)

```
[主题] 的 [方面]：
- [要点 1]
- [要点 2]
- [要点 3]
```

### Episodic Recall (情境找人)

```
你说的是 [人物A]。
- [匹配线索：时间/事件/关系]
- [其他可能：人物B]（如有歧义）
```

### Graph / Timeline (关系/时间线)

```
[人物A] 和 [人物B] 的关系：
- [关系描述]
- [来源/场景]
```

### Discovery / Compounding (发现/复利反馈)

```
🔍 发现 [N] 条关联：
- [关联 1：人物A ← 关系 → 人物B]
- [关联 2：...]
```

### Health / Dream Summary (健康/维护摘要)

```
🧠 大脑状态：[健康/需注意]
- [记忆页数] 页，[关系数] 条关系
- [关键发现]
```

### Capture Result (录入结果)

```
已记录：[捕获摘要]
- [新增实体数] 个实体，[关系数] 条关系
```

### Failure / Degraded (失败/降级)

```
暂时无法完成 [操作]。
- 原因：[用户可理解的一句话]
- 建议：[替代方案]
```

## 6. Tool Status Matrix

Current envelope coverage and downstream issues:

| Status | Tools | Notes |
|:-------|:------|:------|
| ✅ Has envelope | `ingest`, `ingest_dialogue`, `deep_recall`, `grounded_recall`, `query`, `get_page`, `get_pages`, `summarize`, `recall_episode`, `get_org_tree`, `read_discoveries`, `run_discovery` | 11 formatters in `format-result.ts` |
| 🔧 Needs envelope → #142 | `graph_query`, `get_links`, `get_timeline`, `provenance` | Graph/timeline natural display |
| 🔧 Needs envelope → #143 | `health`, `dream` (ops/maintenance) | Health/dream natural summaries |
| 🔧 Needs routing + envelope → #144 | `get_versions`, `revert_version`, `get_profile`, `update_profile`, `remove_profile`, `reload_profile` | Version/profile routing |
| ⏳ Future | `agentic_research`, `batch`, `brainstorm`, `compounding_review`, `dossier`, `expand_entity`, `feedback`, `insights`, `jobs`, `knowledge`, `merge_workflow`, `sync`, `tags`, `trim`, `wakeup_diff` | Apply contract per tool as needed |

## 7. Non-goals

- This contract does not require immediate tool refactoring
- This contract does not define TypeScript interfaces (deferred to post-v1.9.3)
- This contract does not add platform-specific rendering code
- This contract does not change the `display/summary/raw` envelope structure already in use

## 8. Verification

```bash
# Contract doc exists
ls docs/product/agent-response-contract.md

# Brief references contract
grep "response-contract" skills/hermes-cbrain-brief.md

# Eval exists
ls skills/response-contract.routing-eval.jsonl

# No tool code changed
git diff --stat HEAD -- src/
```
