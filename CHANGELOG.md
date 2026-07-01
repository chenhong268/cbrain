# Changelog

> Current: `v2.0.4` — 写入与 MCP 使用体验：NER 可延迟到 Dream backfill；MCP 工具分 profile 暴露，并支持 HTTP /mcp per-session profile。

## [Unreleased]

## [v2.0.4] — 2026-07-01

### 写入与 MCP 使用体验（#251, #252, #260）

- **NER 延迟处理（#252）**：新增 `CBRAIN_INGEST_NER_MODE=sync|defer|off` 与 `--ner-mode` / MCP `nerMode` 覆盖。`defer` 模式下 ingest 只完成确定性写入、chunks/FTS/vector 索引与 durable `ner-backfill` job，不等待 LLM NER；Dream Stage 1.5 有界消费 pending NER job，成功后清除 marker，失败按 job retry 语义处理。
- **MCP 工具 profile（#251）**：新增 `full` / `agent` / `maintenance` / `debug` 工具 profile。默认 full 保持完整工具面；Agent profile 将日常对话暴露面压到 20 个工具以内，maintenance/debug 分别面向巡检维护与调试审计，降低 Agent 误选底层工具的概率。
- **HTTP /mcp per-session profile（#260）**：HTTP MCP 每个 session 可通过 `X-CBrain-Tool-Profile` header 或 initialize metadata 选择 profile；缺省回退到 server 默认。maintenance wrapper 显式使用 maintenance profile，多个 Agent 可共享同一 runtime 但获得不同工具面。

### Release Checks

- `bun run check`：2869 pass / 0 fail。
- `bun run check:docs`：PASS。

## [v2.0.3] — 2026-06-30

### Recall 质量与延迟（#245, #250）

- **Knowledge Map 可选 recall context（#245）**：`deep_recall` 可在显式开启时使用稳定知识域补充同域上下文；主结果排序、exact match、grounded recall 不受影响，调试信息仅进入 raw，用户可见输出只保留自然语言相关提示。
- **默认 smart recall 延迟修复（#250）**：默认 smart 路径不再无条件调用 LLM query expansion；简单查询在 FTS 结果足够时跳过扩展，复杂或 FTS 不足时再扩展，并增加 expand budget guard。
- **degraded 语义修正（#250）**：`latency_budget_exceeded` 不再单独把完整结果标成 degraded；慢但完整的查询标记为 `latency_warning`，真正的 `degraded_rate` 聚焦低分、空结果、超时和预算耗尽等检索质量问题。

### Release Checks

- `bun run check`：2720 pass / 0 fail。
- `bun run check:docs`：PASS。
- targeted release smoke：CLI / skill-pack 52 pass / 0 fail。

## [v2.0.2] — 2026-06-29

### Knowledge Map 与维护稳定性（#232, #234, #240-#244, #248, #249）

- **Knowledge Map 第一阶段闭环**：新增只读图谱分析核心、CLI 报告、MCP 读取与 Dream 周报接入，用于识别社区、桥接节点、孤岛和弱连接，不写入新关系。
- **Temporal evidence completion（#232）**：时序/历史类 recall 可补齐 timeline、chunk 和 link 证据，避免仅靠相似度召回遗漏“之前/后来/为什么这么定”等问题。
- **graphSearch 批量遍历（#248）**：搜索热路径复用批量图遍历，减少 N+1 图查询；dangling link 不再作为召回候选暴露。
- **维护命令 single-writer 加固（#234）**：`cbrain compact` 遇到活跃 writer 时拒绝裸跑，维护任务应通过 HTTP MCP wrapper 执行，避免与唯一 runtime 并发写。

### Release Checks

- `bun run check`：2570+ pass / 0 fail。
- `bun run check:docs`：PASS。

## [v2.0.1] — 2026-06-27

### 搜索与可用性（#231, #237）

- **deep_recall 默认精简响应（#231）**：`deep_recall` 默认返回 compact 首轮响应（`display` + `summary` + 精简 entities + safe `search_meta`），不再把完整 `raw` / body / links / timeline / dossier 灌给 Agent；需要审计或调试时显式传 `include_raw=true` 取回完整 payload。grounded 模式默认只返回 `grounded_answer`。默认响应 12000 字符硬预算，按最终 `has_more` 语义测量，snippet / 尾部 entity 渐进降级保证不超。
- **HTTP-MCP 长请求不再被掐断（#237）**：`Bun.serve` 默认 `idleTimeout`（10s）会掐断 sync / 大文件 ingest 的重索引请求，导致 Hermes MCP client 收到 `RemoteDisconnected` 被判"不可用"；改为 `idleTimeout: 0`（禁用，Bun 正数上限仅 255s 对大批量仍不够），与 stdio MCP 无超时语义一致，session 清理走 app 层 TTL。

## [v2.0.0] — 2026-06-26

### Agentic Memory Kernel

- **自然语言前门**：Hermes 面向用户问题优先走 `cbrain_recall` / `deep_recall` / grounded recall / 情境回忆 / 组织架构 / 关系分析等高层路径，底层 `query` 降级为调试能力。
- **证据边界**：高频工具输出统一遵循 `display` / `summary` / `raw` 分层；Hermes 默认只使用自然语言 display 与摘要，不把 raw/debug/score/slug/trace/vector 暴露给用户。
- **Grounded recall 与 EvidenceBoard**：复杂问题先组织事实、来源、缺口和信任状态，再生成回答；candidate/rejected/superseded 等证据状态不会被静默当成事实。
- **情境回忆与组织架构召回**：支持按时间、事件、地点、共同关系找回人物和经历；组织架构查询走图遍历，不再依赖多轮关键词搜索拼接。

### 运行与发布稳定性

- **单 writer 多 Agent 拓扑**：`cbrain serve --http` 作为唯一写入 runtime，在 `/mcp` 暴露 MCP-over-HTTP；多个 Agent 共享同一个 DB/LanceDB/watcher runtime，避免 stdio 多 writer 并发写。
- **安全写入与恢复**：补齐 vault sync rollback、watcher shutdown drain、page delete recovery、FK repair、LanceDB rebuild、install smoke、daily patrol 等稳定性路径。
- **v2 发布门禁**：新增并持续通过 offline first recall、RC journeys、Hermes dialogue、performance、docs consistency、resolver pilot 聚合 gate。
- **安装上手路径**：README 与 `docs/install-onboarding.md` 提供版本锁定 Bun global install、first-run doctor、MCP/Hermes 接入、skill-pack 验证和故障排查路径。

### Release Checks

- `bun run check`：2466 pass / 0 fail。
- `bun run gate:v2-preflight`：GO。
- `bun run check:docs`：PASS。
- `bin/check-resolver-pilot.sh`：56 OK / 0 FAIL / 9 WARN。
- `bash bin/daily-patrol.sh`：runtime healthy。
- 公开测试、文档和发布说明继续使用匿名占位符，无用户知识库隐私信息。

## [v1.9.8] — 2026-06-22

### 稳定性与恢复（#209, #211, #220）

- **FK migration recovery**：serve 启动遇到外键违规时 fail-fast，并输出匿名化诊断和 `repair-fk` 修复路径；新增 `cbrain repair-fk` dry-run / execute，修复 orphan derived rows 后可重新启动。
- **版本读取安全**：package metadata 不可用时 `cbrain --version` / `--help` 不再崩溃，回退到安全版本字符串。
- **Ontology 运行时资产缺失诊断**：ontology 文件不可用时返回结构化、脱敏错误；不会静默使用空 ontology。

### 搜索与性能（#210, #214）

- **FTS5 回归保护**：补充长查询、混合标点、保留词、emoji/surrogate 等输入的安全测试，确保 trigram fallback 不再因查询语法抛错。
- **批量页面读取优化**：`get_pages` 并行读取页面文件，降低多实体召回和 Hermes 批量展开路径的延迟。

### 运维拓扑（#212）

- **Hermes 维护任务 wrapper**：新增 script-dir-safe maintenance wrapper，通过 HTTP MCP 调用 `dream`，避免 cron 裸跑 CLI 与唯一 writer 并发写。
- **拓扑文档加固**：补充维护任务、MCP-over-HTTP 和 single-writer 运行方式说明，并用 docs consistency 测试阻止旧命令回流。

### Release Checks

- `bun run check`：2452 pass / 0 fail。
- 公开测试、文档和发布说明继续使用匿名占位符，无用户知识库隐私信息。

## [v1.9.7] — 2026-06-21

### 多 Agent 稳定性（#208, #213）

- **Profile-wide single-writer gate**：同一 profile 下只允许一个 write-capable CBrain runtime 打开 SQLite/LanceDB。发现活跃 writer 时在打开数据库前拒绝启动，stale pid 文件自动清理，避免多进程并发写导致 `database is locked`、LanceDB concurrent writer 与 MCP stdio 断连。
- **MCP-over-HTTP**：`cbrain serve --http` 在 `/mcp` 暴露 Streamable HTTP MCP 端点，多 Agent 作为独立 MCP client 连接同一个 HTTP runtime，保留独立 session，但共享单一 DB/LanceDB/watcher。
- **迁移验证包**：新增 phase-3 Hermes HTTP MCP 迁移 checklist 与只读验证脚本，校验 launchd HTTP owner、单一 3399 listener、单 writer、`/mcp` initialize/listTools/callTool，以及 required/optional Hermes config 均无 stdio writer 回退。
- **现网迁移验收**：default 与 secondary Agent 已通过真实 `status` 调用验证，调用后仍只有一个 HTTP writer，gateway 日志无并发写、端口冲突或连接断开错误。

### Release Checks

- `bun run check`：2424 pass / 0 fail。
- `scripts/ops/verify-cbrain-http-mcp-migration.sh`：13 pass / 0 fail。
- 公开测试、文档和发布说明继续使用匿名占位符，无用户知识库隐私信息。

## [v1.9.6] — 2026-06-20

### v2.0 RC 发布门禁收口（#197, #199–#207）

- **Agent 输出边界**：Hermes brief 强制 `display → summary → raw` 消费顺序，禁止把 raw/debug/score/source id/reason codes/slug/trace/vector 等内部字段展示给用户。
- **自然语言前门**：新增 `cbrain_recall` 作为 Hermes 面向用户问题的统一入口，把自然语言请求路由到 grounded recall、content recall、情境找人、组织架构、关系分析、全貌总结或 debug 搜索。
- **真实对话验收**：新增 front-door dialogue acceptance gate，覆盖 10+ 个匿名自然语言场景，确保普通问题不直接落到底层 `query`。
- **写入与路径安全回归**：修复 markdown/frontmatter/路径式输入导致的静默空壳、错误 slug 或重复写入风险；`ingest` 拒绝 `@file`/本地路径引用，避免把路径当内容写入。
- **显示文案通俗化**：高频 MCP formatter 的 `display` 去除机械状态词和内部术语，让 Hermes 更容易输出自然、简洁的用户回复。
- **v2 preflight 聚合门禁**：新增 `bun run gate:v2-preflight`，统一执行 offline-first recall、RC journeys、Hermes dialogue、performance、docs consistency 与 resolver pilot。
- **RC 人工验收清单**：新增 v2.0 RC manual readiness checklist，固化真实 Hermes 对话观察、真实 p95 性能抽样、version-pinned install smoke 三项人工 go/no-go。

### Release Checks

- `bun run check`：2401 pass / 0 fail。
- `bun run gate:v2-preflight`：GO。
- `bun run check:docs`：PASS。
- 公开测试、文档和发布说明继续使用匿名占位符，无用户知识库隐私信息。

## [v1.9.5] — 2026-06-18

### v2.0 前稳定性加固（#185–#187）

- **Vault sync 回滚安全（#185）**：同步失败时恢复 SQLite、FTS 与 LanceDB 索引状态，避免部分写入造成召回污染。
- **Watcher 关闭排水（#186）**：服务关闭时等待 watcher 工作收敛后再释放 ownership lock，避免 stop/start 间隙丢任务或重复同步。
- **页面删除安全（#187）**：删除页面前快照目标文件与死链候选文件；SQLite cascade 放入事务；删除失败会恢复 vault 文件；LanceDB 清理失败时暴露 `lance_repair_required` 并记录待修复状态。

### Release Checks

- `bun run check`：2225 pass / 0 fail。
- `bun run gate:offline`：GO。
- `bun run gate:rc`：GO。
- `bin/check-resolver-pilot.sh`：54 OK / 0 FAIL / 8 WARN。
- 公开测试与发布说明使用匿名占位符，无用户知识库隐私信息。

## [v1.9.4] — 2026-06-06

### Ingest 可靠性（#151）

- **内容类型自动识别**：省略 `type` 时根据合法 frontmatter 确定 markdown/text，不再把 `---` 误作标题。
- **拒绝无语义输入**：缺少有效标题和正文的内容在写文件前返回校验错误，不再生成 `untitled-*` 脏页面。
- **失败回滚**：新页面写入失败会清理 vault、SQLite 与 LanceDB；已有页面失败会恢复正文、标签、关系与旧向量。
- **原子关系更新**：wikilink 关系替换与 mention 计数置于同一 SQLite 事务，单条失败不再留下半完成图谱。
- **回滚可观测**：回滚本身失败时返回 `INGEST_ROLLBACK_INCOMPLETE` 并写入审计记录，明确提示需要修复索引。

### 向量完整性诊断（#150）

- 新增只读 LanceDB 完整性检查，识别缺表、损坏、页面/向量数量偏差等异常。
- 诊断过程不自动重建或修改生产向量数据，修复动作继续由用户明确触发。

### Release Checks

- `bun run check`：1806 pass / 0 fail。
- `bin/check-resolver-pilot.sh`：54 OK / 0 FAIL。
- `bin/check-v193-ux-gate.sh`：15 OK / 0 FAIL。
- 公开测试与发布说明使用匿名占位符，无用户知识库隐私信息。

## [v1.9.3] — 2026-06-06

### 自然输出信封（#142–#144）

- **图/时间线/链接信封（#142）**：`graph_query`、`get_links`、`get_timeline` 返回 display/summary/raw，display 展示中文关系和信任标签，隐藏 slug/score/weight。
- **健康/梦境摘要（#143）**：`health` 展示大脑状态 + top 3 问题 + 行动建议；`dream_status`/`dream` 展示执行进度和日报摘要。内部路径、函数名、slug 全部清洗。
- **版本/偏好信封（#144）**：`get_versions`/`revert_version`/`get_profile`/`update_profile`/`remove_profile`/`reload_profile` 全部 envelope 化，不暴露路径和 raw JSON。

### 认知变化摘要（#141）

- **Wake-up Diff**：首次运行建立基线，后续运行对比快照输出结构化变化报告（新增/更新/删除/层级变化）。挂 dream 最后 stage + 独立 MCP/CLI 触发。

### Agent 行为规范（#147–#148）

- **信号目标路由（#147）**：4-way destination routing（action_loop / agent_profile / cbrain_memory / no_store），优先级：行动 > 档案 > 长期记忆 > 内容复利。
- **Channel-safe Response Contract（#148）**：定义 display/summary/raw 三层、5 类频道、禁止字段列表、工具状态矩阵。

### 发布门禁（#145）

- **v1.9.3 UX Release Gate**：`bin/check-v193-ux-gate.sh` 一键跑 lint + envelope 测试 + 隐私扫描 + 覆盖率检查。`tests/mcp/v193-ux-gate.test.ts` 覆盖 13 个工具的 display 禁词、compactness、raw 完整性。

### 数据一致性修复（#149）

- **person / record 同名冲突修复**：sync 遇到同 title 的 `records/` 与 `brain/entities/person/` 时，自动保留更具体的 person 页并清理旧 record 壳；ingest 遇到已有 person 的关系补充时改为 append，避免新建孤立 record。

### Release Checklist

- [ ] `bun run lint` 通过（tsc + biome）
- [ ] `bun test` 全量通过
- [ ] `bin/check-resolver-pilot.sh` 通过
- [ ] `bin/check-v193-ux-gate.sh` 通过
- [ ] 所有 envelope 工具 display 无 banned terms
- [ ] 所有 envelope 工具 display ≤ 500 chars
- [ ] 所有 envelope 工具 raw 保留完整结构
- [ ] 无真实隐私标识（姓名/邮箱/电话）在 tests/docs/skills
- [ ] signal-router + response-contract eval 覆盖率达标
- [ ] 版本号更新到 `package.json`
- [ ] `CHANGELOG.md` 日期确认
- [ ] tag + push

### 治理与测试

- `bun run check`：1723 pass / 0 fail / 7705 expect() calls

## [v1.9.2] — 2026-06-05

### Hermes 体验
- **统一响应信封（#137）**：MCP 输出统一分层为 `display / summary / raw`，让 Hermes 默认读取用户可见层，调试信息保留在 raw。
- **自然路由与 query 降级（#138）**：普通用户问题优先走 `deep_recall` / grounded answer / graph-first 路径，底层 chunk query 退为内部能力。
- **渐进披露与主动提示预算（#140）**：首轮回答短准，主动提示最多一条且必须相关、可行动，避免重复刷屏。
- **Evidence summary 边界修正（#139）**：证据摘要对齐 3+2 输出边界，避免把调试/内部字段带入 Hermes 首轮回答。
- **Hermes / CBrain 运行边界文档**：明确哪些能力留在 CBrain 治理层，哪些交给 Hermes skill / cron / dialogue runtime。

### 召回与写入质量
- **组织架构图优先召回（#129 / #131）**：新增 `get_org_tree`，并将组织架构类问题路由到 graph-first recall，减少多轮人名搜索拼图。
- **批量页面读取（#133）**：新增 `get_pages`，支持 Hermes 一次展开多个页面，降低重复工具调用和上下文浪费。
- **安全写入契约（#132）**：`put_page` 默认 patch/append，显式 `replace` 才覆盖，并保留版本快照，降低误覆盖风险。
- **Known Relations 自动同步（#130）**：graph mutation 后自动回写 markdown Known Relations，减少 DB / vault 不一致。
- **对话与 ingest 输出信封（#127）**：写入类工具也返回 Agent-facing display 信息，便于 Hermes 自然说明写入结果。

### 诊断与治理
- **degraded recall 诊断（#134）**：返回可解释的降级原因，health 汇总搜索质量，方便定位召回失败是向量、FTS、路由还是预算问题。
- **审核型实体合并（#135）**：新增 merge workflow，支持 dry-run、冲突检查、KR 同步验证和残留校验，替代手工 SQL 合并。
- **批量变更保护（#128）**：watcher 遇到非首次大批量文件变更会暂停并持久化状态，`bulk_resume` 每次只释放有限批次，避免 NER / LanceDB / dream 被写入风暴打爆。
- **批量写入安全门（#128）**：批量删除、批量链接、批量合并超过阈值时默认只预览，需显式确认才执行。
- **CBrain 2.0 UX 合同（#136）**：新增产品级 release gate 文档，把自然对话、证据边界、隐私、延迟和失败降级纳入后续 2.0 验收标准。

### 治理与测试
- `bun run check`：1596 pass / 0 fail / 5755 expect() calls
- 所有新增公开测试与文档示例继续使用匿名占位符，避免泄露真实知识库内容。

## [v1.9.1] — 2026-06-04

### 安全加固
- **MCP 输入长度限制（#123）**：92 个 `z.string()` 参数全面加 `.max()` 保护，新增 `src/mcp/validation.ts` 常量参考 + 自动回归测试，防止超长输入打爆 LLM / 存储
- **MCP 错误信息脱敏（#120）**：`sanitizeError()` 过滤内部路径、stack trace 和表名，避免 Agent 面向用户的回复泄露文件系统结构
- **Frontmatter slug 路径穿越校验（#118）**：`syncPage` 拒绝包含 `..` 的 slug，防止恶意 markdown 文件越权读写

### 性能优化
- **LanceDB compact 集成（#124）**：dream 周期新增 Stage 4.6 碎片合并，实测 5.3GB → 56MB，解决 manifest 版本无限堆积
- **EntityResolver 查询缓存（#122）**：`getAllEntityTitles` 在 resolve session 内缓存，避免同一批次 N 次 NER 重复查 DB

### 可靠性
- **Logger 体系化（#125 / #126）**：7 个核心类接入可选 Logger，14 处 `console.error` 迁移为结构化日志；ENOENT（测试临时目录清理）静默，真实错误 fallback 到 console.error
- **NER 同批次前缀去重（#116）**：`"人物A全名"` 和 `"人物A全"` 不再创建两个 stub，Layer 0b 前缀分组合并
- **Title 碰撞静默重放修复（#114）**：`idx_pages_title_uniq` 冲突不再每次 sync 循环重复报错
- **Dream / query 超时分离（#115）**：dream timeout 不影响实时查询，各自独立控制
- **Discovery ID 闭环**：`DigestCard` 新增 `id` 字段，Agent 可从 `read_discoveries` 返回的卡片直接调用 `update_discovery_status`

### 新功能
- **结构化知识写入（#112）**：新增 `add_knowledge` MCP 工具，支持直接写入事实和关系（facts + relations），跳过 ingest 管道
- **来源溯源（#107）**：`deep_recall` 返回 provenance 信息，Agent 可展示"这个答案来自哪里"
- **首运行诊断（#108）**：新增 `cbrain doctor` 快速检查 DB / vault / LanceDB 就绪状态
- **reports_to 同步（#110）**：frontmatter `reports_to` 字段变更自动同步为 graph link

### 治理与测试
- `bun run check`：1342 pass / 0 fail / 3561 expect() calls
- 所有测试数据继续使用匿名占位符（人物A-F, 组织D）

## [v1.9.0] — 2026-06-02

## [v1.9.0] — 2026-06-02

### Agent 体验
- **Hermes 启动速查（#103）**：新增 `skills/hermes-cbrain-brief.md`，为 Agent 启动和 cron 场景提供紧凑 CBrain 使用规则，覆盖 grounded recall、content recall、情境找人、discovery 展示和硬禁止项
- **Agent-facing 路由验收（#102）**：新增结构化自然语言路由 eval，校验 Hermes 对 grounded/content/episodic/discovery 等场景是否选对工具、参数和输出红线
- **Discovery 输出安全化（#101）**：`run_discovery` 默认只返回用户可读摘要，raw/debug report 仅在 `debug=true` 时返回，避免定时任务把图算法指标展示给用户

### 用户可见质量
- Discovery digest 只展示 `display/cards/summary`，禁止暴露 score、图距离、共享邻居、候选、过滤和 debug 字段
- 内容回忆首轮默认一次 `deep_recall(detail=normal, limit=3)`，减少多工具连调和上下文浪费
- Hermes 用户回答新增通用红线：不展示工具名、raw JSON、slug/source id/chunk id、debug/trace/internal 字段

### 治理与测试
- `bin/check-resolver-pilot.sh` 扩展为 Agent-facing routing + Hermes brief 双门禁
- 所有公开示例继续使用匿名占位符，避免泄露真实知识库内容
- `bun run check`：1215 pass / 0 fail / 3235 expect() calls

## [v1.8.11] — 2026-06-02

### Agent 体验
- **Discovery Digest 用户化（#100）**：每日发现默认输出最多 3 条用户可读卡片，包含为什么重要、依据和建议动作，不再暴露 raw score、图距离、共享邻居等内部调试指标
- **弱信号降噪**：过滤空 suggestion、高跳数弱桥接和低行动价值发现，避免把内部候选当成用户提醒
- **可调试但不打扰**：保留 debug 模式用于开发排查，默认面向 Hermes / 用户的输出只展示自然语言摘要

### 可靠性
- **标题冲突诊断（#98）**：sync / watcher 遇到 `pages.title` 唯一约束冲突时，返回可操作的冲突摘要，帮助定位重复页面与隔离原因
- **矛盾检测误报修正（#99）**：健康检查区分互补上下文与真实冲突，避免把不同业务线、角色或描述维度误判为矛盾

### 测试
- `bun run check`：1211 pass / 0 fail / 3156 expect() calls

## [v1.8.10] — 2026-06-01

### Agent 体验
- **情境回忆重建（#10）**：新增 `recall_episode` MCP 工具，Hermes 可在用户忘记人名时，用时间段、主题、场景或共同关系召回人物候选
- **证据收敛**：情境召回只返回匹配当前线索的 timeline/link evidence，避免把无关社会关系或经历带入回答
- **不主动打扰**：该能力仅在用户请求或当前对话直接相关时使用，不会因为关系沉默时间长而建议联系某人

### 质量修正
- **Discovery 评分修正（#81）**：移除 `scoreCandidate()` 的 content/semantic 固定常量 padding，改用真实邻居重叠信号，提高复利发现候选排序质量
- **episodic recall 评分修正（#82）**：query fallback 不再把同一 queryBody 同时填入 topic/context，避免单次文本命中被双重加权
- **阈值与测试加固（#83/#84）**：补充 Jaccard、排序、actionable threshold 与 auto-applicable 边界测试

### 可靠性与隐私
- 过滤 rejected / superseded evidence，低置信结果以候选形式呈现
- `source_slug` 保持可追溯，`limit` 限制在 1-8
- 测试与公开描述使用匿名占位符，避免泄露真实知识库内容

### 测试
- `bun run check`：915 pass / 0 fail / 2246 expect() calls

## [v1.8.9] — 2026-05-29

### Agent 体验
- **内容回忆增强**：`deep_recall(detail=normal)` 返回 `memory_skeleton`，包含 `key_points` 与 `structure_terms`，让 Agent 在不展开全文的情况下还原方案结构、关键机制与选择理由
- **Grounded / Content Recall 路由分离**：核查确认类问题继续走 grounded evidence board；“当时怎么设计/为什么选/具体方案”类问题走普通 recall，避免误触证据分类模式
- **首轮工具门控**：内容回忆首轮只允许一次 `deep_recall`，禁止默认追加 `get_page` / `expand_entity` / 二次检索，减少延迟和上下文消耗
- **主动提示收敛**：普通 recall 默认不展示 proactive hints，仅在直接改变当前判断时压缩为一句后续变化提示

### 测试
- 新增 `key-points` 单元测试，覆盖 frontmatter、heading、bold list、bullet、dossier stripping、L1 summary merge 与结构词提取
- 新增 MCP 契约测试，确保 `detail=normal` 返回 `memory_skeleton`，`detail=brief` 不返回
- `bun run check`：854 pass / 0 fail / 2062 expect() calls

## [v1.8.8] — 2026-05-28

### 稳定性
- **运行时产物迁出 vault（#77）**：日志、health、indexes、dream 报告、自动备份统一迁移到 `<profileDir>/runtime/`，不再写入 Obsidian 内容 vault
- **migrate-runtime**：新增安全迁移旧 `vault/outputs/` 的 CLI，目标已有文件时迁入 `legacy-outputs-<timestamp>`，避免覆盖当前 runtime 状态
- **Watcher/Obsidian 风险收口**：运行时写入与内容 vault 解耦，降低 Obsidian 索引风暴和挂起风险

### 备份与恢复
- **自动备份 DB-only**：`dream` 自动备份只保存 SQLite，一致性快照使用 `VACUUM INTO`，不再备份可重建的 LanceDB
- **手动全量备份**：`cbrain backup` 支持 DB + vault full backup，并兼容自定义 `dbPath` / `vaultPath`
- **restore 安全门控**：恢复前检测活跃 CBrain 服务、数据库锁、`.rollback` / `vault.pre-restore` 残留文件
- **原子数据库安装**：恢复数据库先写入 `.restoring` 临时文件并验证，再原子 `rename` 到正式路径，避免半写入 DB
- **WAL 一致回滚**：full restore 前用 `VACUUM INTO` 保存 `.rollback` 快照，vault 替换失败时可恢复包含 WAL 已提交数据的原数据库

### 验证
- `bun run check`：782 pass / 0 fail / 1882 expect() calls
- 真实部署验证：单 HTTP 进程、单 watcher owner、`vault/outputs/` 已清理，Obsidian 重启后无新增 runtime 写入

## [v1.8.7] — 2026-05-26

### 新功能
- **QueryRouter**：规则引擎按意图（关系/复盘/实体详情）自动选 fast/hybrid/agentic 路径，明确意图不浪费 LLM

### Bug 修复
- **L1 残留清理**：空 body 的 `writeIndexes` 现在同时删除 L1 sealed summary（SQLite + LanceDB vector），搜索不再命中已删除内容
- **LanceDB 孤儿报告**：`cleanLanceOrphans()` 只返回成功删除的 slug，不再把失败项计为成功
- **Dream 竞态消除**：`removeOrphans` 完成后才跑 `cleanLanceOrphans`，不再漏掉新孤儿
- **Research trace 透传**：follow-up 子查询现在共享 `_trace`，MCP 调用方能看到完整计时
- **Follow-up query 去重**：同一轮 LLM 返回的重复查询在归一化后过滤，不浪费搜索

## [v1.8.6] — 2026-05-26

### 性能优化
- **查询变体并行化**：`searchWithExpansion` 多查询变体从串行改为 `Promise.all`，simple/medium 查询延迟降 49-59%
- **Embedding 缓存**：LRU 100、TTL 5 分钟，重复查询缓存命中延迟从 647ms → 7ms（99%）
- **MCP hints 去重**：smart 策略预计算的 `resolveSlugs`/`isComplexQuery` 通过 `_hints` 传入 HybridSearch，避免重复计算
- **Research 并行**：后续查询从串行改为 `Promise.all`
- **分阶段延迟日志**：expand_ms / total_ms / slugs 数写入 search_log

## [v1.8.5] — 2026-05-25

### 新功能
- **Agentic search multiStep**：检索后自动判断结果充分性，不够则换策略重试（最多 3 轮），最后 LLM rerank
- **Auto-trigger**：复杂查询自动启用 multiStep，无需手动传参。精确查单个实体走快路径
- **Early exit**：空结果 / 结果停滞时立即终止，防止 58s 死循环

### Bug 修复
- **SQLite 锁竞争**：添加 `busy_timeout=5000ms`，减少并发写入冲突

## [v1.8.4] — 2026-05-25

### 新功能
- **Graph-aware query decomposition**：复杂查询自动拆解为子查询，结合知识图谱上下文提升搜索精度（agentic search phase 1）
- **双层路由**：`isComplexQuery` 规则检测 + LLM 拆解，简单查询走快路径不浪费 token

### Bug 修复
- **Discovery contradiction detection 从未执行**：路由路径 `record/` → `records/` 拼写错误
- **FTS5 排序翻转**：rank 是负数，取 `Math.abs(rank)` 修正
- **Dream locked 语义错误**：locked 实体不应参与 dream 循环
- **Zhipu tokenCount 批量膨胀**：批量 embedding 时 token 计数重复累加

## [v1.8.3] — 2026-05-24

### Bug 修复
- **read_discoveries gap 被 bridge 挤出**：无 typeFilter 时改用 round-robin 类型交替，防止高分 bridge 挤掉 gap
- **gap suggestion 不回传**：根因是 gap 排名太低读不出来，排序修复后解决
- **enrichment 截断**：ENRICH_PER_TYPE 15→25，high-actionable gap 覆盖率从 30/35 提升到 44/44

### 新功能
- **typeFilter 参数**：read_discoveries 支持按类型筛选（bridge/trend/gap/contradiction）
- **getDiscoveriesByType**：DB 层新增按类型查询方法
- **enrichment 诊断**：DiscoveryReport 新增 enrichment 统计（attempted/saved/errors）
- **clearPendingDiscoveries**：每次 runDiscovery 前清除未读 pending 记录

## [v1.8.2] — 2026-05-23

### 重构
- **NER 类型映射去硬编码**（#34）：删除 6 处硬编码类型/关系映射，全部改为从 ontology.yaml 动态生成
  - `loader.ts`：删除 16 条 `NER_TO_PAGE_TYPE`，改为动态构建 Map
  - `ner-prompt.ts`：删除硬编码类型列表，改为动态 type union
  - `pipeline.ts`：删除字符串前缀检查，新增 `isDerivedPageType()`
  - `shared.ts`：删除废弃的 `CANONICAL_RELATION_TYPES` 和 `REVERSE_RELATIONS` 常量
  - `sqlite.ts` / `ops.ts`：3+3 处改为函数调用
- **NER 上限放宽**：概念 3→8，实体总数 8→10

## [v1.8.1] — 2026-05-22

### Bug 修复
- **Smart 模式不再走 FTS 捷径**（#30）：recall.ts smart 策略有 FTS 结果就短路返回，跳过 vector/graph/temporal/RRF。现在始终走完整 hybrid pipeline
- **短查询不再跳过向量搜索**（#30）：查询 < 4 字符时只用 FTS+temporal，中文人名/公司名 2-3 字全中招。现在所有查询走完整 hybrid，保留精确标题匹配快路径
- **Graph 通道不再形同虚设**（#30）：`graphSearch` 接收原始 query 做 BFS 但需要 slug 匹配，自然语言永远匹配不到。现在调用前先 resolveSlugs 转换

## [v1.8.0] — 2026-05-20

### 新功能
- **Seal 页级摘要压缩**（#5）：每页的 raw chunks 自动压缩成一条 L1 摘要，搜索优先返回摘要，减少碎片化结果
- Schema migration：chunks 表新增 `summary_level` + `content_hash` 列，UNIQUE 约束重建
- `SealManager`：LLM 驱动的摘要生成，支持批量 sealAll / 增量 sealChanged
- Dream Stage 3.5：seal 自动在 dream 管线中执行
- Search 去重：vector search 同一页有 L1 时只返回 L1

### Bug 修复
- LanceDB `getOrCreateTable` 并发竞态修复（重复建表报错）
- Pipeline `writeIndexes` 保留 L1 摘要不被覆盖
- 生产 vault 清理 434 条孤儿 chunks（FK constraint 修复）

## [v1.7.8] — 2026-05-20

### Bug 修复
- enrich 实体丰富度永远为 0（`statSync` 用了相对路径）— #18
- dream 返回 `success` 语义反转（`locked` 字段赋值错误）— #18
- 标签添加/删除只改 frontmatter 不改 DB（tags 表和 markdown 不同步）— #18
- `upsertPage` 每次同步重置 `expires_at`（实体永不过期）— #18
- ORDER BY 参数无白名单校验（SQL 注入风险）— #19
- HTTP 端点跳过 Zod schema 校验（任意参数直达 handler）— #19

## [v1.7.7] — 2026-05-19

### 新功能
- 对话式自动写入（#9）：`ingest_dialogue` 加 `mode: "auto"` — Hermes 每 3-5 轮对话自动捕获高置信事实写入知识图谱，中置信进候选，低置信直接跳过，返回 `decision` 字段
- LLM 超时保护（#8）：`ZhipuLLMProvider` 加 AbortController 超时机制，默认 30s，可配置
- NER 短文快速路径（#8）：短文本（<2500 字）跳过 `Promise.all` 并行拆分开销，直接单次 LLM 调用

### 改进
- `DialogueIngest` 新增 `DialogueMode` 类型（auto/manual）、`AUTO_DIALOGUE_PROMPT`（更严格的提取标准 + `should_ingest` 预判）
- `signal-detector` skill 更新：Agent 知道何时用 auto mode 自动捕获对话事实
- `writeLog` 记录 mode 字段到 ingest_log，便于审计

## [v1.7.6] — 2026-05-19

## [v1.7.6] — 2026-05-19

### 修复
- 下属/上级关系自动双向：`insertLink` 写入下属时自动创建反向上级（反之亦然），删除时联动删除（closes #4）
- `deleteLink`/`deleteLinkById` 同步删除反向 link，避免孤儿关系
- NER 提取 prompt 新增上级关系类型
- `relation_audit fix` 新增双向补齐：检测并修复缺失的反向 link
- 历史数据修复：57 条下属 link 补齐 57 条上级反向 link

### 架构
- `REVERSE_RELATIONS` — 非对称关系双向映射表（shared.ts）
- `insertLink` `_skipReverse` 参数防止递归

## [v1.7.5] — 2026-05-18

### 修复
- 版本号统一：CLI/MCP/HTTP 三处改为共用 `src/version.ts`（单一事实来源），不再各自硬编码
- HTTP/MCP 工具注册对齐：提取 `src/mcp/register.ts` 共享注册函数，HTTP 模式从 14 个工具补齐到 21 个
- 文档准确性：标记 `cbrain check-resolvable` 为未实现，`deep_recall` 说明为 MCP 工具而非 CLI 命令
- CLI 版本号测试改为动态读取 package.json，不再硬编码

### 架构
- 新增 `src/version.ts` — 版本号单一来源
- 新增 `src/mcp/register.ts` — `registerAllTools()` 共享注册

## [v1.7.4] — 2026-05-17

### 修复
- deep_recall 搜索结果中 record 类型自动降权（×0.5），人名搜索时人物实体排名更高（ closes #3 ）

## [v1.7.3] — 2026-05-17

### 修复
- deep_recall 移除 stub 实体（`_stub: true`），所有返回实体均包含完整上下文（链接/时间线/标签/档案）
- limit 上限从 10 降为 5，避免返回 AI 无法利用的摘要实体浪费 token

## [v1.7.2] — 2026-05-17

### 新功能
- 生日信息新增中国生肖（shengxiao 字段），deep_recall 人物实体自动返回
- 生肖计算：(year - 4) % 12 → 鼠牛虎兔龙蛇马羊猴鸡狗猪

## [v1.7.1] — 2026-05-17

### 文档
- 新增 `docs/agent-collaboration.md` — 小爱与 Claude Code 的协作分工协议

> Current: `v1.7.0` — 主动提示引擎 + 小爱查询行为优化。

## [v1.7.0] — 2026-05-16

### 主动提示引擎（Proactive Hints）
- 新增 `src/core/proactive.ts` — 基于规则引擎的上下文感知主动推送
- 3 条规则：网络动态（邻居近期事件）、共同联系（结果实体间的隐藏关联）、过期提醒
- `deep_recall` 和 `query` 返回结果新增 `proactive_hints` 字段
- 工具描述强制 AI 展示 hints（💡 主动提示：开头，不省略）
- 新增 `getPageTitlesAndTypes()` DB 方法支持 slug→title 转换
- 垃圾 slug 过滤（records/templates/attachments 前缀不进 hints）

### 小爱行为优化
- SKILL.md 新增「查询构建规则」：query 参数必须用核心实体名，禁止改写成描述性短语
- 解决自然语言查询被改写为描述性短语导致搜索失败的问题（如"XX最近在忙啥"→"XX最近动态"）

### 测试
- 新增 `tests/core/proactive.test.ts` — 4 个测试用例覆盖 3 条规则 + 错误隔离


## [v1.6.4] — 2026-05-16

### 过期信息闭环
- `upsertPage()` / `insertPage()` 对 entity 类型自动设置 90 天有效期
- DB 初始化时自动回填已有 entity 的 `expires_at`
- 小爱 SKILL.md 添加过期信息处理规则：主动告知过期、提议更新、不过滤不丢弃


## [v1.6.3] — 2026-05-16

### Batch 操作
- 新增 `batch_delete_pages` — 一次调用删除最多 100 个页面
- 新增 `batch_add_links` — 批量创建链接，自动校验 + markdown 同步去重
- 新增 `batch_merge_pages` — 批量合并页面对，检测级联删除冲突

### 过期内容标注
- `deep_recall` 返回的实体新增 `expiry_warning` 字段：已过期（⚠️）、即将过期（⏰ 30天内）
- summary 统计过期实体数量

### 搜索优化
- 短查询（<4 字符）走 FTS 优先路径，跳过向量搜索，中文名搜索准确度提升

## [v1.6.2] — 2026-05-16

### 自动反馈闭环
- `expand_entity` 展开实体时自动记录 "expanded" feedback + 0.15 activity bump
- `writeback` 写入成功时自动记录 "relevant" feedback + 0.2 activity bump
- `create_link` 时两端实体都记录正向信号
- `LearnManager` 新增 `bumpOnExpand()` + `bumpOnWriteback()` 方法
- `QUERY_VALUES` 新增 `expand: 1.5`（展开 = 比搜索更强的兴趣信号）

### 数据库索引补全（9 个新索引）
- `idx_pages_title` / `idx_pages_updated_at` / `idx_pages_created_at`
- `idx_pages_activity_wt`（partial，WHERE > 0）/ `idx_pages_expires_at`（partial，WHERE NOT NULL）
- `idx_tags_page_slug` / `idx_timeline_page_slug`
- `idx_ingest_log_created` / `idx_feedback_created`

### Bug 修复
- `pages.title` 加 UNIQUE 索引（防重复，已有重复数据只 warn 不中断启动）
- `discoveries.seen` 改为 `NOT NULL DEFAULT 0` + 修存量 NULL 数据
- `query_feedback` FK 改为 `ON DELETE CASCADE`，新数据库直接正确
- `cleanOldQueryLogs()` 改为先删 feedback 再删 log，避免孤儿记录

## [v1.6.1] — 2026-05-16

### 学习闭环（5 Phases）

**Phase 1 — 查询日志：**
- `query_log` 表：记录所有 MCP 查询（recall/search/graph），含 tool、query、result_slugs、latency、session_id
- recall.ts / search.ts / graph.ts 三个工具在返回结果前自动记录

**Phase 2 — 活动权重：**
- `pages` 表新增 `activity_weight` + `last_queried_at` 列
- `LearnManager`（`src/core/learn.ts`）：recomputeAll（dream 调用）+ bumpOnQuery（实时微增）
- 权重公式：`Σ(query_value × position_weight × time_decay)`，14 天半衰期
- Dream 管线新增 Stage 3: Learn，自动重算权重

**Phase 3 — 排序集成：**
- Search RRF 加 activity_weight bonus（W_ACTIVITY = 0.15）
- Graph 排序改为复合排序：`activity_weight + LOG(mention_count + 1)`
- Enrich tier 计算改为：`mention_count × 0.4 + activity_weight × 0.6`
- Recall quality label 修正：tier ≤ 1 = "high"，不再反转

**Phase 4 — 反馈机制：**
- `query_feedback` 表 + `record_feedback` MCP 工具
- 小爱可回报 relevant/irrelevant/expanded 信号
- LearnManager.recomputeAll 中反馈影响权重

**Phase 5 — 会话共现：**
- query_log 含 session_id，共现信号增强已有 link weight
- 只增强已有关系，不凭空发明新关系

### 备份优化
- Dream backup 不再包含 vault（有 iCloud 备份），只备份 DB + LanceDB（1.3GB → 143MB）
- 修复 dbPath 解析错误导致备份静默失败（0MB）

## [v1.6.0] — 2026-05-16

## [v1.6.0] — 2026-05-16

### 性能优化（19 fixes，4 Sprints）

**Sprint 1 — 独立高影响：**
- reflect 图邻接缓存 — BFS/label propagation 不再每次重建邻接表
- NER Stage 1 并发 — 串行 LLM 调用改为 CONCURRENCY=5 batch
- getBySlug LRU 缓存 — 200 上限，30s TTL，list/update 自动 invalidat
- resolveEntityName 预构建小写索引 — 消除 O(n) 线性扫描
- pipeline Set 去重 — Array.includes → Set.has
- deletePageCascaded 去冗余 DELETE — 依赖 ON DELETE CASCADE
- stripCodeBlocks O(n^2) → O(n) — 逐字符拼接 → parts.join

**Sprint 2 — 批查询 + 缓存：**
- recall 批量查询 — N+1 → batchGetLinks/Timeline/Tags
- graph traverse 批量 — 逐节点查询 → 按层批量取
- search 查询扩展缓存 — 5 分钟 TTL
- countNewPagesSince — 两条 COUNT → GROUP BY 一条
- insight TTL 配置缓存 — 1 分钟 TTL
- insight 签名从 SQLite 取 — 不再读磁盘

**Sprint 3 — 异步 I/O + SQL 优化：**
- sync/dream/watcher/shared 全部同步 I/O → async
- dream 并行阶段 — cleanup+health+insight archive Promise.all
- rewriteVaultLinks 按需扫描 — chunks_fts LIKE 定位候选文件
- resolveSlugs 批量 — 逐条查询 → 3 条批量 SQL
- 关联子查询 → LEFT JOIN

**Sprint 4 — 清理：**
- ingest 代码去重 — ingestMarkdown/ingestText 提取 ingestCore

## [v1.5.2] — 2026-05-13

### 索引时间戳

- **时间戳格式** — All-Entities、All-Concepts、Dashboard 的 updated 列从纯日期 `YYYY-MM-DD` 改为完整时间 `YYYY-MM-DDTHH:MM:SS`

## [v1.4.1] — 2026-05-12

### Dream 索引生成

- **Stage 6: indexes** — dream 维护流程末尾自动调用 `IndexGenerator.generateAll()`，刷新 All-Entities、All-Concepts、Dashboard 索引文件，不再需要手动 `cbrain index`

## [v1.4.0] — 2026-05-12

### Wiki-link 全生命周期

- **delete 死链清理** — 删除页面时自动扫描 vault，将 `[[slug]]` 还原为纯文本
- **merge 链接重写** — 合并页面时自动将 `[[source]]` → `[[target]]` 全 vault 替换
- **rewriteVaultLinks 共享函数** — merge（替换）和 delete（移除）共用一套 vault 扫描逻辑

### Raw 类型移除

- **raw→record 统一** — 去掉 raw 页面类型，所有 raw/* 迁移为 records/*
- **slug 路径简化** — TYPE_PREFIX map 替代 pluralize+prefix 双层逻辑
- **DB v5 迁移** — 自动将 raw/* 和 brain/records/* 统一为 records/*，覆盖 pages/links/chunks/tags/timeline/versions/ingest_log 全部表
- **vault 目录结构** — 不再创建 raw/ 目录，init 只建 records/
- **sync inferTypeFromPath** — 路径类型推断去掉 raw 分支，records/ → record
- **health check 适配** — health 检查中 raw 引用全部改为 record

### Profile 热重载

- **mtime stale 检测** — Profile 文件修改后自动重新加载，无需重启

### Auto-link 撤回

- **移除 autoLink 功能** — CJK 正则匹配不成熟，撤回待后续重做

## [v1.3.1] — 2026-05-11

### Raw 类型 + 合并层级隔离

- **`raw` 页面类型** — 新增 raw 类型，`raw/` 目录文件不再被错误标记为 record
- **层级系统** — `getLayer()` + `canMerge()` 抽象，source 层（raw/record）与 derived 层（entity/concept/insight）隔离
- **合并防护三重机制** — MCP tool、核心 merge 方法、canonicalSlug 均强制层级隔离
- **sync 路径映射修复** — `raw/xxx` 正确推断为 raw 类型（之前错误返回 record）
- **DB schema 迁移** — pages 表 CHECK 约束增加 raw，存量 92 条 raw 路径记录批量修正
- **slug 工具兼容** — canonicalSlug 对 raw 类型跳过目录重写，避免 `raw/raws/` 错误路径

## [v1.1.0] — 2026-05-09

### Insight 系统 (P0-1)

- **insights 表 + InsightManager** — 新表存储 LLM 生成的跨域洞察，独立于 discoveries
- **6 个 Insight MCP 工具** — `create_insight`, `read_insights`, `get_insight`, `promote_discovery`, `mark_insight_read`, `read_unread_insights`
- **reflect 从 dream 拆出独立** — `cbrain reflect` CLI 命令，reflect 不再阻塞 dream 流程
- **insight 页面类型全面支持** — list_pages/ingest/sync/pipeline 全部识别 insight 类型

### Discovery 闭环 (P0-2)

- **discoveries 表扩展** — 新增 `actionable`(high/medium/low)、`suggestion`(LLM 建议)、`proposed_actions`(JSON)、`auto_applicable` 四列
- **发现分级** — `classifyActionable()` 基于 score+type+entityTypes 自动分级
- **LLM 建议生成** — 对 actionable != low 的发现自动生成中文建议和操作建议
- **`run_discovery` MCP 工具** — Agent 可按需触发发现管线
- **`read_discoveries` 人类可读** — 返回中文格式化输出，不再是原始 JSON
- **`cbrain discover` CLI 命令** — 手动/cron 触发发现管线
- **embedding 缓存** — `scoreCandidate()` 加 `embCache`，O(N²) embedding 调用降为 O(N)

### 文档

- **Agent 兼容性说明** — README 明确 CBrain 以 Hermes Agent 为开发对象
- **功能分类表** — 三类：独立 CLI / Agent 按需 / Agent 定时任务

## [v1.0.1] — 2026-05-05

### Fixes

- **Config loading: dual cbrain.json architecture fix** — `CBRAIN_DIR` env var removed (caused stale config reads from iCloud vault). New `CBRAIN_CONFIG` env var points directly to config file. Eliminates dual-config drift risk. (`src/cli/context.ts`)
- **NER UNIQUE constraint fix** — `upsertPage()` in dialogue.ts now uses INSERT OR REPLACE instead of raw INSERT, preventing crash on duplicate entity names during dialogue ingestion. (`src/core/dialogue.ts`)
- **Undefined relation type in stub bodies** — `pipeline.ts` stored raw `rel.relation` (could be undefined) instead of `normalizeRelation()` result in stub body generation. Now uses `normRel` consistently. (`src/core/pipeline.ts`)

## [v1.0.0] — 2026-05-05

### HTTP API

- **`cbrain serve --http`:** New HTTP transport on `127.0.0.1:3399`. All 41 MCP tools exposed as `POST /tools/:name`. Persistent via launchd.
- **Binary build:** `bun build --compile` produces self-contained 152MB binary. Zero dependencies at runtime.

### NER Refactoring

- **Model upgrade:** glm-4-flash → glm-5-turbo. Dramatically improved entity classification accuracy.
- **Classifier simplified:** 5-layer ~50 rules → 3-layer ~10 rules. LLM as primary classifier, rules as safety net.
- **Text chunking:** Long texts split at sentence boundaries, merged with dedup. Replaces blunt 3000-char truncation.

### Vault Cleanup

- entities 492→309, removed 200+ misclassified concept stubs
- concepts 582→553, removed 29 empty stubs
- Legacy `brain/nodes/` directory removed

### Fixes

- summarize/deep_recall: use `fts` strategy instead of vector search (1000x faster, avoids embedding timeout)
- sync: insight pages excluded from NER (both batch and single-page paths)
- PID lock removed for multi-Agent support
- classifyEntity: 2-3 char Chinese no longer blindly classified as entity
- MCP server version → 1.0.0

## [v0.4.1] — 2026-05-04

### P1: 数据质量基础设施

- **时效性标记：** pages 表新增 `expires_at` + `confidence_decay` 字段。health 新增"时效性"维度，自动检测过期和低置信度内容。
- **关系强度：** links 表新增 `weight` (0-1) + `strength` (strong/medium/weak) 字段。关系自动推导（任职→strong/1.0，提及→weak/0.3）。`graph_query` 支持 `minWeight` 过滤。
- **矛盾检测：** health 新增"矛盾检测"维度。同一 entity 被多个 raw/ 源引用时，Jaccard 词重叠检测潜在矛盾。

### P2: 上下文动态摘要

- **新增 `summarize` MCP tool：** 搜索 + 图遍历 + 权重过滤 + 上下文聚合，一次调用给出领域全貌（正文、关系链、时间线、标签、邻居、近期动态）。

### Insight 功能重构

- **`generateInsights` 禁用。** 旧系统 65 条 auto insight 全部归档删除。auto insight 替换为新架构。
- **discoveries 表：** 新表，存图算法发现的结构化异常（bridge/community_crossing/structural_hole）。
- **dream 新增 discovery stage：** 每次 dream 跑 5 维打分 + 社区检测 + BFS，产出 top-20 结构化发现（0 LLM 调用）。
- **MCP tools：** `read_discoveries` + `mark_discovery_seen`。Agent 读取发现 → 呈现给用户 → 用户判断 → 确认后写成 `brain/insights/` 笔记。
- **brain_storm：** `cross_domain_insights` 改名为 `connections`。description 重写，明确"推理找空白用 brain_storm，查事实用 search/query"。
- **诊断工具：** `diagnose-insight` CLI 命令 + `tests/insight-sim.ts` 模拟脚本。

### Bug 修复（8 个）

- **悬空链接清理：** 新增 `cleanDanglingLinks()`，sync 时自动清理引用不存在页面的 link（修复 `brain/nodes/` 迁移残留 8 条）。
- **`audit.ts` 死代码：** AuditLogger 类及 14 处调用全部删除。只保留 `MetricsSnapshot` 接口。
- **多 serve 进程保护：** PID 文件锁（`cbrain.pid`），重复启动自动拒绝。
- **`source`/`event` 类型残留：** slug.ts、audit.ts、health.ts、brain.ts 中死代码清理。DB CHECK 约束修复。3 条 event 页面转为 record。
- **空 catch 日志：** 3 处静默吞错的 catch 块加 `console.error`。
- **brain_storm slug 空路径：** 加长度检查，无效 slug 跳过。
- **`outputs/` 文件误入图谱：** `collectMarkdownFiles` 加 `excludeDirs`。清理 19 条误同步的 outputs 页面。
- **关系强度 SELECT 漏列：** `getOutgoingLinks`/`getIncomingLinks` 补上 weight/strength 列。

### 运维

- **`cbrain-restart` alias:** shell alias for quick serve restart.
- **团队数据入库:** batch entity structuring with relation links.

## [v0.4.0] — 2026-05-03

### 目录结构重构：entities/ + concepts/ 恢复独立

`brain/nodes/` 是历史妥协，统一目录模糊了 entity（人/公司/产品）和 concept（方法论/理论/效应）的边界。恢复为 `brain/entities/` + `brain/concepts/`，581 个文件按 type 迁移，DB 全量更新。

### Slug 规范化：`canonicalSlug()`

所有页面创建路径（put_page、NER stub、wikilink stub、ingest、writeback）强制校验 slug 目录前缀。`syncPage` 发现错放文件自动迁移。不再产生 `brain/nodes/` 或路径错误。

### NER 分类器重构：统一三路分流

三个碎片函数（`isNoiseEntity`、`isGenericConcept`、`correctEntityType`）合并为单一 `classifyEntity(name, llmType) → entity | concept | null`。五层优先级：黑名单 → 强 concept 信号 → 强 entity 信号 → 泛化词过滤 → LLM 信任。Prompt 从平铺列表改为决策树。

中英文实体全量人工审查：22 个泛化词删除，30 个 entity→concept，1 个 concept→entity，9 个重复合并。最终 315 entities + 227 concepts。

### 新增 `deep_recall` MCP 工具

一次 MCP 调用替代之前 5-7 次串行查询（query→get_page→graph_query→get_links→get_timeline）。内部 `Promise.all` 并行获取搜索结果 + 每个实体的 page/links/timeline/tags/related，返回结构化 bundle + quality/tier 评估。

### put_page 补全 NER + wikilink

`put_page` 创建/更新页面时同步执行 NER 实体提取和 wikilink 解析。之前只更新了索引，NER 靠 watcher 补跑但被 hash 检查跳过。

### Tags 同步写文件

`add_tag` / `remove_tag` 改为通过 `PageManager.update()` 同时写 DB 和 vault 文件 frontmatter，不再出现"标签只在 DB 不在文件"的问题。`get_tags` 合并两处来源。

### 禁用 inferred relations

ReflectManager 的 LLM 推断关系质量太差（746 条垃圾链接，方向搞反、间接关联当直接关系）。`inferRelations()` 改为直接 return []，保留 entity synthesis 和 insight generation。

### 健康检查阈值调整

overall status 从"任一维度有 high issue → fail"改为"high issue > 5 个 → fail"，避免 3 个疑似重复就把 715 页的健康检查拉红。

### 每日简报推送

Dream 报告新增 `buildBrief()`：人类可读的日报替代枯燥计数。`DreamReport` 加 `brief` 字段，MCP dream handler 返回 brief。

### deep_recall 跨域关联

`deep_recall` 新增 Phase 3 `cross_refs`：查询实体时列出关联实体中最近 7 天有更新的，Agent 能主动说"对了，XX 3天前更新了笔记"。

### brain_storm：大脑思考模式

新增 MCP tool `brain_storm`，实现感知 → 推理+自省 → 发现（写回CBrain）→ 呈现+提问 的完整循环。当内部知识不足时返回 `search_queries` 建议外部搜索。与 `deep_recall` 分工：查实体用 deep_recall，需要分析/出主意用 brain_storm。

### outputs/ 移入 vault

`outputs/` 从 vault 外侧移到 `vault/outputs/`，和 `brain/` 平级。Obsidian 可以直接看到备份、健康报告、索引。清理了残留的 `outputs/records/` 目录，移除无用的 `All-Records.md`。



### 关系类型规范化

46 种中英混杂关系 → 10 种 MECE 规范类型（认识/提及/任职/创立/归属/合作/竞争/资本/制造/间接关联）。`CANONICAL_RELATIONS` + `normalizeRelation()` 在 shared.ts，NER/reflect/health 三处同步。963 条 link 已迁移，health check 一致性维度 ✅。

### Insight Agent 访问

- type enum 补全 insight，list_pages/ingest/sync/pipeline 全部支持
- ReflectManager 注入 pipeline，insight 创建后立刻 embed+FTS，不等 sync
- dream_reset MCP 工具

### Dream Sub-Agent 方案

dream no longer limited by MCP 30s timeout — sub-agent mode with extended timeout, user-friendly message on lock conflict.

### Agent 记忆更新

Agent protocol files updated: CBrain data paths, relation types, insight query protocol, dream sub-agent protocol.

## [Dev] — 2026-05-02

### 系统大扫除

- **死功能清理** — 删 raw_data 全链路（0 行数据）、ResolverChecker + RoutingEval（无关代码）、config MCP 工具（无人使用）。AuditLogger 空壳化，Logger 只写 warn/error，info 不进磁盘。共计 **-666 行**。
- **页面类型合并** — event + source → record，从 6 种减为 4 种（entity/concept/record/insight）。brain/ 目录从 5 个减为 3 个（nodes/insights/records）。`normalizePageType()` 在 PageManager 入口把关，raw/ 文件的非标类型自动归一化。

### 两阶段 NER 提取（借鉴 Hyper-Extract）

- **阶段 1** — 只抽实体 + 事件，过滤后产出精确 entity list。
- **阶段 2** — 用 entity list 作为 context 只抽关系，LLM 只能引用列表里的名字，彻底杜绝 dangling reference。
- **Schema-Guideline 分离** — ENTITY_SCHEMA/GUIDELINE + RELATION_SCHEMA/GUIDELINE，为领域定制铺路。

### DeepSeek 迁移

- 新增 `DeepSeekLLMProvider`（deepseek-v4-flash），reflect 走 DeepSeek，NER 继续走智谱 glm-4-flash。
- 并发 2 → 3。

### Insight 质量优化

- 置信度门槛 >= 0.8，source_entities 重叠度 >50% 去重，标题限 10 字。
- prompt 去风格化——强调"好的洞察是稀有的"，默认为空。
- 三阶段 `Promise.all` 并行。产出从 87 个降至 11 个精选。

### Bug Fixes

- 修复 22 个实体文件的 wikilink 双链接错误（brain/sources/ → brain/records/）。

## [Dev] — 2026-05-01

### ReflectManager — 洞察质量 + 速度优化

- **去AI化 prompt 重写** — INSIGHT_SYSTEM 全部重写：短句、口语化、有节奏、不铺垫。给出好坏范例对比，禁止"不仅...而且""揭示""表明"等 AI 套路句式。要求洞察是推理结论，不是摘要复述。
- **glm-5-turbo 模型** — 通过 coding plan 端点调用，质量远超 glm-4-flash。
- **串行阶段执行** — reflectAll() 从 Promise.all 并行改为串行，避免三阶段同时打 API 导致 429。
- **Retry + 指数退避** — callLLM 加 3 次重试，退避 3s/6s/9s。
- **CONCURRENCY=2** — 从 5 降到 2，稳定跑完不触发限流。

### Health Check — 从数据 dump 变成诊断工具

- **状态持久化** — `outputs/health/state.json` 存 issue 快照 + 慢性计数器。
- **Delta 计算** — 每次运行对比上次：新增、消失、慢性（连续 3+ 次）、不变。
- **三层输出** — summary（<50 行给人看）、actions（只有新增/恶化）、detail（JSON 给工具消费）。
- **Severity 折叠** — high 全列、medium 前 10、low 只报数量。
- **滚动清理** — 自动删除 7 天前的报告文件。
- **CLI 增强** — `--full` 完整 Markdown、`--json` 输出 JSON、`--dimension <name>` 单维度检查。
- **终端 delta 展示** — 显示 vs 上次变化：新增/消失/慢性数量。

### Bug Fixes
- **health.ts dead code 删除** — lines 83-93 unreachable 重复代码块。
- **page.ts 类型修复** — 参数类型对齐。

### Repository Layer — 消灭 131 处 SQL 泄漏

- **CBrainDB 成为唯一 SQL 入口** — 18 个消费者文件中的 131 处 `db.prepare("SQL")` 全部替换为 CBrainDB 方法调用。
- **`prepare()` 改为 `private`** — 从外部无法再直接写 raw SQL，改表结构只需改 `sqlite.ts` 一处。
- **新增 ~50 个 typed 方法** — pages (25+), links (12+), chunks (3), config (3), ingest log (2), timeline (3), tags (2), FTS (1)。
- **MCP server 拆分为 12 个 per-domain tool 文件** — server.ts 从 866→83 行，每个 tool 独立文件：`pages.ts`, `graph.ts`, `search.ts`, `ops.ts`, `tags.ts`, `timeline.ts`, `versions.ts`, `jobs.ts`, `raw-data.ts`, `sync.ts`, `config.ts`, `ingest.ts`。

### Bug Fixes
- **maintenance.ts 死代码清理** — 删除引用已不存在的 `enrichWithContent`/`enrichAllWithContent`。
- **EnrichManager 构造函数修复** — maintenance.ts 多传了 `vaultPath` 参数。
- **pipeline.ts addTimelineEntry 参数顺序** — 与 CBrainDB 原始签名对齐。

## [Dev] — 2026-04-30

### NER Quality Overhaul
- **Prompt philosophy reversed** — from "cast a wide net" to "precision first". Explicit skip rules for daily items, roles, departments, abstract qualities, generic business terms.
- **New `isGenericConcept()` filter** — pattern-based rejection of generic compound Chinese terms (管理/策略/能力/思维 suffixes, 大众/消费者/市场 prefixes).
- **Expanded noise detection** — job titles (经理/总监/人员/管理员/作家), departments (团队/部门/小组/中心), 30+ new `GENERIC_TERMS` entries.
- **Extraction limits tightened** — 12 entities + 5 concepts → 8 entities + 3 concepts (MAX_TOTAL_ENTITIES=8, MAX_CONCEPTS=3).
- **Strict concept rules** — only recognized methodologies, theories, effects, laws, models pass. Examples: 奥卡姆剃刀 ✅, 注意力管理 ❌.
- **Relevance-aware capping** — entities sorted by relevance before slicing; low-relevance dropped first.
- **Production cleanup** — deleted 75 garbage entities (41 concepts + 36 daily items/roles/departments) from DB + vault.
- **5 new tests** — generic concepts, daily items, job titles, type preservation, limit enforcement.

### Architecture
- **entities + concepts → `brain/nodes/`** — merged into single directory. Type field distinguishes entity vs concept, no more classification guesswork.
- **`ContentPipeline`** — extracted unified write pipeline. `writeIndexes`, wikilink processing, and NER application now have one implementation shared by sync, ingest, and MCP server. Removed 508 lines of duplicated code across sync.ts (617→406), ingest.ts (324→143), shared.ts.

### NER Prompt
- **"Broad extraction" philosophy** — LLM casts wide net, downstream filters decide what to keep. Removed 65 lines of DO/DON'T rules, replaced with simple Golden Rule.
- **Six-filter pipeline**: `findEntitySlug` (known entities) → `relevance` (low = skip) → `length` (≤20 chars) → `GENERIC_TERMS` (blacklist) → `isNoiseEntity` (phones/emails/titles) → `isValidEntityName` (fragments).

### Watcher
- **Polling mode** — replaced `fs.watch` (broken on iCloud Drive) with 3-second content-hash polling.
- **Full pipeline** — watcher now runs wikilink extraction + NER (previously only synced file metadata).
- **Reuses deps** — watcher shares embedding/lance instances with MCP server, no duplicate API connections.

### Bug Fixes
- `syncPage` now runs wikilink extraction (was missing — watcher-triggered syncs ignored `[[...]]`).
- `isValidEntityName` no longer rejects names ending in 着 (was blocking 功能固着).
- `resolveLinkTarget` in ingest uses `findEntitySlug` (was matching raw/ records as wikilink targets).
- `upsertLinks` only deletes "mentions" links, preserving NER-created relations.
- Image embeds (`![[img.png]]`) no longer treated as wikilinks.
- `removeOrphans` uses `PageManager.delete()` for cascade cleanup.
- `enrich.ts` reads `type` from DB directly (was broken by nodes/ migration).

### Added
- **`DialogueIngest`** (`src/core/dialogue.ts`) — conversation-aware ingestion with incremental entity matching, avoids re-creating known entities
- **`dialogue` MCP tool** — agents can ingest conversation snippets directly

### Removed
- **`cbrain watch` command** — `cbrain serve` already includes watcher. Having both caused double-watcher conflict and MCP disconnection.
- **API key plaintext warning** — `console.error` nag on every command removed. Key-in-config is the expected default.
- `extractEnglishTerms` — regex-based English acronym extraction (LLM does this better).
- `extractChineseRelations` — regex-based Chinese relation extraction (sentence fragment source).
- `extractMarkdownLinks` — unused.
- Duplicate `extractWikiLinks` in ingest.ts — unified with extract.ts.
- Duplicate `indexPageContent` in MCP server — unified with shared.ts.
- Dead `parallelBatch` method in sync.ts.
- **Relevance scoring** — LLM rates each entity high/medium/low. Low-relevance entities don't create stubs.
- **Prompt-level noise filter** — Skip generic gov bodies (国务院), political titles (中共党员), common locations.
- **Regex extraction filter** — `isValidEntityName()` blocks sentence fragments (24小时内或下个, 色的管理者就) and wiki-link path entities (e.g. brainentities某实体名).
- **Entity/concept NER skip** — No more re-extracting entities from entity pages (cascade noise amplifier). Speed 4.8x, noise -79%.
- **Parallel NER batching** — 5 concurrent LLM calls instead of sequential.
- **Dollar amounts & time periods** — Explicitly excluded from extraction (93亿美元, Q1 2026).
- **Sync time**: ~12min → 2.5min. **Auto-extracted noise**: 264 → 80 (-70%).

### Added
- **`cbrain backup` / `cbrain restore`** — zip backup of vault + DB + LanceDB
- **Auto-backup before dream** — `cbrain dream` creates pre-maintenance backup, keeps last 7
- **`AGENTS.md`** — agent protocols for open source users (review/connect/cleanup/write)
- **UX improvements**: human-readable `query` output, `init` shows next steps, `health` uses plain language, `serve` prints MCP config

### Fixed
- **Cascade cleanup** — `PageManager.delete()` now cleans links/tags/timeline/chunks/FTS/ingest_log/raw_data
- **NER async** — ingest no longer blocks on LLM extraction, fixing timeout on long documents
- **Backup path** — auto-backups now go to `outputs/backups/` not vault root
- **TypeScript** — `tsc --noEmit` now zero errors

### Changed
- **maintain merged into dream** — `cbrain dream` is the single maintenance command
- **Agent memory streamlined** — verbose protocol rules replaced by pointer to AGENTS.md
- **cli/index.ts split** — 997-line file → 8 command modules + thin registry

## [Dev] — 2026-04-28

### Added
- **`cbrain dream` CLI command** — 5-stage nightly pipeline (sync→enrich→cleanup→health→report) with cycle lock
- **`src/core/dream.ts`** — `runDream()` with 30-min cycle lock, stage-level error isolation, daily markdown report
- **NER English entity extraction** — now extracts drugs, regulators, medical terms (Cosentyx, FDA, CHMP, IgAN...)

### Fixed
- **ingest path** — all types (record/event/source) now go to `brain/` instead of `raw/`
- **broken references** — all 26 auto-extracted stubs updated from `raw/records/` to `brain/records/`
- **NER now extracts English** — drugs, regulators, medical terms (Cosentyx, FDA, CHMP, IgAN)

### Earlier today
- **10 new CLI commands**: `show`, `list`, `delete`, `status`, `versions`, `revert`, `config`, `maintain`, `tags`, `timeline` — now 23 total
- **4 new skills**: `review.md`, `connect.md`, `cleanup.md`, `write.md` — 11 total
- **`skills/RESOLVER.md`** + `cbrain check-resolvable` — 26 rules, 11 categories, skill routing validation

## [Dev] — 2026-04-26

### Added (afternoon)
- **`merge_pages` MCP tool** — merge duplicate pages: links, timeline, tags all moved to target, source deleted
- **`PageManager.merge(sourceSlug, targetSlug)`** — core merge logic with version snapshot, body append, link/timeline migration
- **Slug collision detection** in health check — new "疑似重复" dimension detects `王强` vs `王强-1` patterns with `merge_pages` suggestion
- **Content hash change detection** — verified working; unchanged files skip re-index on sync
- **System Logger** (`src/core/logger.ts`) — info/warn/error levels, daily markdown log files, wired into PageManager, SyncManager, MCP server, CLI
- **Error detection in health check** — new "系统错误" dimension (10 dimensions now), reads recent 7-day error log
- **Health check relation whitelist** expanded — added 下级, 汇报给, 负责, 职位, 就读于, 毕业于, 专业, 专业为, 配偶关系, 条线
- **CBrain 技术全景** + **CBrain vs GBrain 横向对比** + **CBrain 使用指南** — three technical docs saved to Obsidian

### Added (morning)
- **Zero-LLM regex extraction engine** (`src/core/extract.ts`) — GBrain-inspired deterministic fallback
  - `extractWikiLinks()`: `[[target]]` wikilink extraction
  - `extractEnglishTerms()`: 3+ uppercase acronyms with known-term whitelist (RAG, LLM, MMLU...)
  - `extractChineseRelations()`: 任职于/创立了/投资了/认识/指导/成员 patterns
  - `stripCodeBlocks()`: no false positives from code samples
  - Runs alongside LLM NER in sync pipeline; creates stubs for missed entities
- **File Watcher as standalone daemon** — `cbrain watch` command + launchd plist
  - Auto-sync on file change (debounce 2s)
  - Auto-clean orphans on file delete
- **Stale stub auto-cleanup** — auto-extracted stubs whose source no longer references them are removed on sync
- **38 MCP tools** — added `maintain` tool (sync → enrich → health → brief)

### Changed
- **NER prompt**: relation types English→Chinese (任职于/认识/创业了...)
- **NER prompt**: expanded to extract English tech terms (benchmarks, acronyms, architectural patterns)
- **NER limits**: concepts 3→5, entities 8→12
- **Health check whitelist**: synced to Chinese relation types
- **Outputs fully Chinese**: 健康检查, 操作日志, 指标快照
- **`mcp_cbrain_query`**: strategy hidden from agents, always uses optimal hybrid

### Fixed
- NER noise filter: phone numbers, email/WeChat, bare locations, abbreviations, job titles, dates
- 2-char abbreviation filter narrowed to avoid killing LLM/GPU/RAG etc
- English terms now extracted: MMLU, C-Eval, GPT, Claude, CBrain, API, RAG...
- `put_page` now indexes content (chunks, vector, FTS) after create/update
- `inferTypeFromPath` updated for `raw/` / `brain/` dir naming
- `get_timeline` returns unified events list (structured + body date lines)
- `add_timeline_entry` appends to page body + auto-reindex
- Date regex fixed: single-separator dates (2007.12) now matched
- `cbrain sync` auto-runs removeOrphans + cleanStaleStubs

## [Dev] — 2026-04-25

### Added
- **Agent integration** — brain-ops skill (37-tool reference), signal-detector skill (SCAN→CLASSIFY→QUERY→INGEST)
- **Vault directory standardization** — `1_raw`→`raw`, `2_Cbrain`→`brain`, `3_outputs`→`outputs`
- **raw/ read-only boundary** — `PageManager.update()`, `writeback`, `put_page` all block writes to raw/ files
- **Auto version snapshot** — `put_page` and `sync` create version before every overwrite
- **2-char FTS fallback** — short CJK queries (e.g. "星辰") use LIKE search when trigram tokenizer lacks data
- **Design doc** — `docs/design.md` covering architecture, search pipeline, storage rationale, GBrain comparison
- **Known issues** — `docs/known-issues.md`

### Fixed
- `put_page` now indexes content (chunks, vector, FTS) after create/update — pages created via put_page were unsearchable
- `inferTypeFromPath` updated for new `raw/` / `brain/` dir naming
- `mcp_cbrain_query` no longer exposes `strategy` parameter to agents — always uses optimal hybrid

### Testing
- 264 tests, 22 files, 574 expect() calls, all green
- MCP server tests: 54 tests covering all 37 tools
- New test files: version, audit, health, zhipu (LLM)

## [0.3.0] - 2026-04-25

### Added
- **25 new MCP tools** — MCP tools grew from 12 to 37, fully covering page CRUD, tags, links, timeline, chunks, ingest log, config, versions, jobs, and raw data
- **Page tools** — `put_page`, `delete_page`, `resolve_slugs` for full page lifecycle management
- **Tag tools** — `get_tags`, `add_tag`, `remove_tag` for page-level tagging
- **Link tools** — `get_links`, `remove_link` for knowledge graph edge management
- **Timeline tools** — `get_timeline`, `add_timeline_entry` for event tracking
- **Utility tools** — `get_chunks`, `get_ingest_log`, `get_config`, `set_config` for observability and configuration
- **Version History** — `versions` table in SQLite, `VersionManager` class, `get_versions` and `revert_version` MCP tools. Auto-snapshot before revert.
- **Multi-query Expansion** — `HybridSearch` uses LLM (GLM-4-flash) to generate 2-3 query variants, searches each independently, merges with RRF. Default enabled, configurable via `multiQuery: false`.
- **SQLite Job Queue** — `jobs` table with priority, retry, and status tracking. `JobQueue` class with handler registration and work loop. 5 MCP tools: `job_submit`, `job_list`, `job_status`, `job_cancel`, `job_retry`.
- **Raw Data Storage** — `raw_data` table for BLOB storage attached to pages. 4 MCP tools: `put_raw_data`, `get_raw_data`, `list_raw_data`, `delete_raw_data`. Supports base64-encoded binary data.

### Changed
- `HybridSearch` constructor accepts optional `{ llm, multiQuery }` config
- `CBrainDB` now exposes 35+ query methods across all tables
- MCP server script in package.json updated to `--serve` command

## [0.2.0] - 2025-04-25

### Added
- **NER (Named Entity Recognition)** — LLM-based entity extraction from ingested content using 智谱 GLM-4-flash
- **Auto entity stubs** — Discovered entities (people, companies, locations, concepts, products) auto-create pages
- **Relationship inference** — Typed relations (works_at, knows, invested_in, founded, attended, etc.) written to links table
- **Timeline extraction** — Events with dates and participants extracted to timeline table
- **LLM provider interface** — Pluggable LLM backend (`src/llm/provider.ts` + `src/llm/zhipu.ts`)
- **NER config** — `ner` section in config (enabled, llm_provider, llm_model, llm_api_key, llm_base_url)
- NER runs automatically during ingest when LLM provider is configured
- MCP server version bumped to 0.2.0
- 11 new tests for NER pipeline (unit + integration)

### Changed
- `IngestManager` constructor now accepts optional `LLMProvider` for NER
- `CBrainDeps` includes optional `llm` field
- CLI `createDeps()` auto-creates `ZhipuLLMProvider` when NER is enabled
- Config type fix: `normalizeJsonConfig` now uses proper `NormalizedConfig` type

## [0.1.1] - 2025-04-25

### Fixed
- `get_page` now returns full file content via `body` field, not just metadata
- `ingestMarkdown` now uses externally passed `title` and `pageType` as fallback when frontmatter lacks them (was defaulting to "Untitled")
- Full `sync` now auto-runs `removeOrphans` — deleting vault files no longer leaves stale DB entries
- Added standalone `remove_orphans` MCP tool

### Changed
- Skill file updated: instruct agents to pass content whole (no splitting), one ingest call per document
- Skill file updated: `record` is the default pageType for multi-entity content

## [0.1.0] - 2025-04-24

### Added
- SQLite storage layer with FTS5 trigram (Chinese full-text search)
- LanceDB vector storage with pluggable embedding provider
- 智谱 embedding-3 provider (2048d)
- Hybrid search: vector + FTS + graph, fused with RRF
- Obsidian bidirectional sync (vault ↔ SQLite/LanceDB indexes)
- Ingest pipeline: text and markdown with auto-chunking
- Page CRUD with Chinese-aware slug generation
- Knowledge graph: traverse, backlinks, related entities (wiki-link based)
- Entity enrichment: tier promotion based on mention count
- MCP server with 8 tools (query, ingest, get_page, list_pages, graph_query, enrich, sync, status)
- CLI: init, doctor, ingest, query, sync, enrich, graph-query, serve
- P0 skills: brain-ops, signal-detector, ingest, query, enrich
- Open source scaffolding: README, CONTRIBUTING, issue/PR templates

## Roadmap

### v0.2 — NER + Auto Relationships ✅
- [x] Auto entity extraction (NER) from ingested content
- [x] Relationship type inference (knows, works_at, invested_in, etc.)
- [x] LLM-assisted Chinese relationship reasoning
- [x] Timeline event extraction

### v0.3 — Full MCP Coverage + Infrastructure ✅
- [x] 25 new MCP tools (12 → 37) — page CRUD, tags, links, timeline, chunks, config
- [x] Version History — versions table, VersionManager, get_versions, revert_version
- [x] Multi-query Expansion — LLM query variant generation + RRF merge
- [x] SQLite Job Queue — jobs table, JobQueue class, 5 MCP tools
- [x] Raw Data Storage — raw_data table, 4 MCP tools (base64 BLOB)

### v0.4 — Automation ✅
- [x] File watcher: auto-index on Obsidian file changes
- [x] Signal detector: auto-extract entities from conversations
- [x] Dream: nightly maintenance pipeline
- [x] Daily briefing with person context

### v0.5 — Quality of Life (current)
- [ ] Auto entity enrichment (web data) for Tier 1 entities
- [x] Content hash change detection in sync
- [x] Deduplication / merge detection
- [ ] Additional embedding providers (OpenAI, Ollama)
- [ ] CI pipeline (lint + test)
