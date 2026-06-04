# CBrain 2.0 UX Contract

> **版本**: v2.0
> **性质**: Release gate — 以下每条合同都有对应测试，breaking = 不发版。
> **范围**: 不改业务能力，只约束"对外的嘴脸"。

---

## 合同总览

| # | 合同 | 测试位置 | 验证方式 |
|---|------|----------|----------|
| C1 | display / summary / raw 三层输出 | `ux-contract.test.ts` C1 | 结构断言 |
| C2 | 不泄露内部标识 | `format-result.test.ts` BANNED_INTERNAL | 词汇黑名单 |
| C3 | query 是底层能力，不直接暴露 | `ux-contract.test.ts` C3 | schema 检查 |
| C4 | EvidenceBoard 优先于 raw 实体列表 | `ux-contract.test.ts` C4 | 参数默认值 |
| C5 | proactive 严格预算，最多展示 1 条 | `ux-contract.test.ts` C5 | 常量 + 文案扫描 |
| C6 | 渐进披露：brief / normal / full | `ux-contract.test.ts` C6 | 默认值 + 截断 |
| C7 | 失败降级：有结构，不是 raw error | `ux-contract.test.ts` C7 | 降级字段存在 |
| C8 | 文档/测试不含真实人名 | `check-resolver-pilot.sh` §8 | 正则扫描 |
| C9 | 渐进披露路由：首轮 brief，二轮按需展开 | `ux-contract.test.ts` C9 | 源码扫描 |

---

## C1: 三层输出 (CaptureEnvelope)

**原则**: 对外输出永远分三层：`display`（自然语言）、`summary`（结构摘要）、`raw`（完整数据）。Agent 看 display 就够用；需要程序化消费时翻 raw。

**约束**:
- 使用 CaptureEnvelope 的工具（`ingest`、`ingest_dialogue`）**必须**返回这三个字段
- `display` 是中文自然语言，不含 slug / chunk_id / score 等内部标识
- `summary.status` 只能是 `"recorded" | "skipped" | "needs_review"`
- `raw` 是完整内部结果，不做裁剪

**实现位置**: `src/mcp/tools/format-result.ts` → `CaptureEnvelope<T>`

**测试**: 断言 `formatIngestResult` 和 `formatDialogueResult` 输出包含 display / summary / raw，且 display 不含 BANNED_INTERNAL 词汇。

---

## C2: 不泄露内部标识

**原则**: Agent 面向用户说话时，不应暴露 CBrain 内部术语。用户不需要知道 slug、chunk、score、distance。

**约束**:
- `display` 和 `summary.message` 中不出现：`slug, stubsCreated, filtered, chunk, source_id, JSON, ner_candidates, entity_slugs, stubs, LLM, llm, parse, error, 解析`
- Discovery digest 的 `display` 中不出现：`score, hops, shared_neighbors, distance, vector, threshold, algorithm`
- `_debug` 字段只在 `debug=true` 时返回

**实现位置**: `format-result.test.ts` BANNED_INTERNAL, `discovery-digest.test.ts` BANNED_WORDS

**测试**: 已有。新增时同步更新黑名单。

---

## C3: query 是底层能力，不直接暴露

**原则**: `query`（向量搜索）是 recall 的底层引擎。Agent 不应直接调 `query` 给用户看搜索结果——应该走 `deep_recall` 或 `summarize`，它们做 enrichment + evidence + 渐进披露。

**约束**:
- `query` 工具的 description 必须标明 "底层搜索能力，优先使用 deep_recall"
- `deep_recall` 和 `summarize` 的返回结构必须比 `query` 更丰富（至少多 entity enrichment、proactive hints、degradation metadata）

**实现位置**: `src/mcp/tools/search.ts` query 工具

**测试**: 断言 query 工具的 description 包含提示文字。

---

## C4: EvidenceBoard 优先

**原则**: 事实类查询（"我之前说过什么关于 X"）优先走 EvidenceBoard + grounded recall，不是直接返回实体列表让 Agent 自己拼。

**约束**:
- `deep_recall` 的 `grounded` 参数默认为 `true`（在 skill 层面，非 MCP schema 默认）
- grounded 模式返回 `confidence`（high/medium/low）+ `facts[]` + `conflicts[]` + `gaps[]`
- 未 grounded 时，返回结构仍包含 `search_meta`（策略、延迟、是否降级）

**实现位置**: `src/core/grounded-answer.ts` → `GroundedRecallResult`, `src/core/evidence.ts`

**测试**: 断言 `GroundedRecallResult` 必须包含 confidence + facts + conflicts + gaps 字段。

---

## C5: proactive 安静增值，严格预算

**原则**: 主动提示（proactive hints）默认不展示。Hermes 面向用户最多展示 **1 条**，且必须强相关、能改变当前判断、可行动。不满足这三条就不展示。

**约束**:
- Hermes 面向用户最多展示 **1 条** hint（不是"逐条列出"，不是"原样展示"）
- 工具 description **禁止**包含"必须把每一条 hint 原样展示""💡 主动提示""逐条列出"等强制展示文案
- 内部生成可以产多条（供 Agent 选择），但 Agent 面向用户只能用 1 条
- 单条 hint text ≤ 120 字符（`truncateText` 截断）
- `MIN_SCORE` = 0.5（低于此分数的 hint 不返回）
- 生成失败不阻塞主响应（try-catch 返回 `[]`）

**实现位置**: `src/core/proactive.ts` → `generateProactiveHints`, `src/mcp/tools/recall.ts` 硬规则

**测试**: 断言 `trimHint` 输出 text ≤ 123（含截断省略号）。断言 search.ts / recall.ts 不得包含强制展示文案。断言 `MIN_SCORE` 常量值。

---

## C6: 渐进披露

**原则**: 数据按需给，不全量倒。Agent 首轮拿到 brief 视图，需要更多再请求 normal/full。

**约束**:
- `deep_recall`: `detail` 默认 `"brief"`（200 字 body，无 dossier/peers/subordinates）
- `summarize`: Top 3 实体全量，其余为 `_stub: true`
- `get_page`: body 默认截断 1500 字，`has_more` 标记是否有更多
- `agentic_research`: 3 档预算（brief: 3s/3search/1llm, normal: default, full: 15s/12search/5llm）
- `_stub: true` 标记让 Agent 知道这是精简视图

**实现位置**: `src/mcp/tools/recall.ts`, `src/mcp/tools/summarize.ts`, `src/mcp/tools/trim.ts`, `src/mcp/tools/agentic-research.ts`

**测试**: 断言常量值（TOP_N=3, body 截断 1500, detail 默认 "brief"）。

---

## C7: 失败降级

**原则**: 搜不到、报错、超时——都给结构化降级响应，不是 raw JSON error 或 stack trace。

**约束**:
- 搜索降级时返回 `degraded: true` + `vector_skipped: "timeout" | "error"` + `latency_ms`
- proactive 生成失败返回空数组 `[]`，不抛异常
- FTS fallback：向量搜索超时后降级到纯文本搜索，不返回空结果
- pipeline 状态枚举：`"ok" | "partial" | "degraded" | "insufficient"`
- 错误隔离模式：`try { ... } catch { /* non-critical */ }` 至少 25 处

**实现位置**: `src/core/search.ts` SearchTrace, `src/core/agentic/pipeline.ts` PipelineStatus

**测试**: 断言 `PipelineStatus` 是 `"ok" | "partial" | "degraded" | "insufficient"` 联合类型。断言 search trace 有 `degraded_reason` 字段。

---

## C8: 文档/测试不含真实人名

**原则**: 代码仓库是公开的。文档、测试、样例中不得出现真实人名、公司名、组织名或知识库私有内容。

**约束**:
- 测试 fixture 使用通用名：`PersonA`, `PersonB`, `Test`, `Note`, `Sub`, `Boss` 等
- 文档中使用占位符：`Agent`, `用户`, `某公司`
- 已有的真实名字（如果存在）需要替换

**实现位置**: `bin/check-resolver-pilot.sh` §8 + `tests/mcp/ux-contract.test.ts` 隐私扫描

**测试**: 正则扫描测试文件和文档中是否出现中文名模式。

---

## C9: 渐进披露路由

**原则**: 首轮回答必须短（brief），第二轮按需展开。路由规则必须在代码和文档双重存在。Proactive hints 代码级执行预算。

**约束**:
- `deep_recall` 默认 `detail="brief"`（代码：Zod default）
- recall.ts 工具描述必须包含首轮硬门控文本（禁止 get_page/expand_entity/get_timeline）
- recall.ts 工具描述必须声明第二轮展开条件（展开/原文/详细）
- recall-resolver.md 必须描述首轮/第二轮模式
- hermes-cbrain-brief.md 必须提及首轮约束且 ≤ 3000 bytes
- `applyProactiveBudget()` 代码级执行：grounded → []，normal → 最多 1 条

**实现位置**: `src/mcp/tools/trim.ts` → `applyProactiveBudget`, `src/mcp/tools/recall.ts`

**测试**: `ux-contract.test.ts` C9 源码扫描。

---

## Release Gate 清单

发版前执行：

```bash
bun run check                          # lint + 全量测试
bash bin/check-resolver-pilot.sh       # 路由 eval + brief + UX 合同 §8
```

两项全绿才发版。任何 UX 合同测试失败 = 阻塞。
