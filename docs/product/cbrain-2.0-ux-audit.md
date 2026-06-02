# CBrain 2.0 UX Audit Matrix

> v1.9.0 → v2.0 产品化审计。从 Hermes Agent 作为用户唯一入口的角度，盘点每项能力的体验现状、差距和优先级。
>
> 不改业务代码。只产出诊断和规划。

---

## v2.0 用户体验原则

1. **无感优先**：用户不该知道"CBrain"或任何工具名。他们只说"我之前说过什么关于 X"，Hermes 应该自然回答。
2. **首轮即有用**：第一次回答就要够短、够准、够有用。不允许"让我查一下，你等我"之后给一堆内部字段。
3. **不泄露内部**：slug、chunk_id、score、distance、debug 字段、工具名——全部不出现。用户看到的是自然语言。
4. **可追溯可撤回**：每条知识有来源（对话、导入、推理），用户可以说"这条不对"来纠错或删除。
5. **安静增值**：低频复利反馈（discovery、compounding review）只在真正有价值时才出现，不刷屏。
6. **失败也要优雅**：找不到、搜不到、报错——都要给用户可理解的回答，不是 raw JSON 或 stack trace。
7. **一致性**：同样的问题，无论走哪条路由（RESOLVER、hermes-cbrain-brief、brain-ops），应该得到同样格式的回答。

---

## 能力清单（27 类，72 个 MCP 工具）

按用户场景分组，不按技术模块分组。

### A. 自然捕捉（用户主动或对话自动提取）

| # | 能力 | 工具 | 现状一句话 |
|---|------|------|-----------|
| A1 | 对话提取 | `ingest_dialogue` | auto 模式静默提取，manual 模式需触发。用户不知道发生了什么。 |
| A2 | 内容导入 | `ingest` | CLI 和 MCP 双入口。NER 自动提取实体。返回 slug 但用户看不懂。 |
| A3 | 页面创建/更新 | `put_page` | 核心写入工具。已有 Known Relations 双向同步（#104）。同名人物有警告。 |
| A4 | 页面追加 | `append_page` | 追加不覆盖。触发重新索引和 NER。 |
| A5 | 别名管理 | `add_alias` / `remove_alias` | 纯操作，无 UX 问题。 |
| A6 | 来源追踪 | `get_provenance` / `update_trust_state` / `get_provenance_history` | 来源分类 6 种，信任状态可更新。用户看不到这些信息，除非主动问。 |

### B. 自然增益回答（用户问，Hermes 答）

| # | 能力 | 工具 | 现状一句话 |
|---|------|------|-----------|
| B1 | 核查确认 | `deep_recall(grounded:true)` | 最高优先路由。≤300 字，标注"待确认"。有验收文档。 |
| B2 | 内容回忆 | `deep_recall(detail:"normal")` | 返回摘要 + 关系 + 时间线。首轮不自动展开。有验收文档。 |
| B3 | 快速搜索 | `query` | 底层 FTS/向量/混合搜索。返回 chunks，不是完整答案。 |
| B4 | 情境找人 | `recall_episode` | "那个跟我一起做项目的人"场景。多线索匹配。有验收文档。 |
| B5 | 关系分析 | `graph_query` / `get_links` | 遍历/反向链接/关联。link 带 source_type 和 confidence。 |
| B6 | 全景摘要 | `summarize` | 搜索 + 图遍历 1-2 跳，生成生态全景。 |
| B7 | 深度研究 | `agentic_research` | planner→executor→critic 多步管道。6 种意图，3 级预算。EXPERIMENTAL 标签。 |
| B8 | 实体展开 | `expand_entity` | stub → 完整信息。用户追问"展开"时调用。 |
| B9 | 档案生成 | `dossier` | 结构化人物/组织档案，7 天缓存自动刷新。 |
| B10 | 深度推理 | `brain_storm` | 盲区分析、策略推理。返回 gaps、connections、follow-up questions。 |
| B11 | 证据导出 | `export_grounded_artifact` | HTML 文件导出，支持匿名化。 |

### C. 情境回忆重建

| # | 能力 | 工具 | 现状一句话 |
|---|------|------|-----------|
| C1 | 时间线 | `get_timeline` / `add_timeline_entry` | 结构化时间线 + body 日期行。可手动添加事件。 |
| C2 | 版本历史 | `get_versions` / `revert_version` | 每次更新自动快照。可回滚。用户不知道这个功能存在。 |
| C3 | 页面读取 | `get_page` | 按 slug 读取。默认截断 1500 字。include_full_body 可看全量。 |

### D. 低频复利反馈

| # | 能力 | 工具 | 现状一句话 |
|---|------|------|-----------|
| D1 | 发现检测 | `run_discovery` / `read_discoveries` | bridge/trend/gap/contradiction 四类。#100 做了用户可读 digest。 |
| D2 | 洞察管理 | `list_insights` / `query_insights` / `promote_discovery` | synthesis/pattern/anomaly/bridge 四类。有生命周期（active→archived→dismissed）。 |
| D3 | 复利回顾 | `get_compounding_reviews` / `act_on_review_candidate` | 5 门过滤（证据充分性、持久性、新颖性、行动价值、信任风险）。有验收文档。 |
| D4 | 反馈学习 | `record_feedback` | 相关结果提升，不相关衰减。用户无感知。 |

### E. 维护治理

| # | 能力 | 工具 | 现状一句话 |
|---|------|------|-----------|
| E1 | 健康检查 | `health` | 13 维度。输出是技术报告，用户看不懂；结构一致性仍需补强（#106）。 |
| E2 | 实体提升 | `enrich` | 基于热度评分自动提级。用户不知道什么时候触发的。 |
| E3 | 同步 | `sync` / `remove_orphans` | vault → DB 同步。CLI 和 MCP 双入口。 |
| E4 | 夜间管道 | `dream` / `dream_reset` | 一键跑 sync→enrich→seal→learn→index→health→insight-archive。 |
| E5 | 清理 | `watcher_quarantine` / `relation_audit` | 文件监控隔离 + 关系审计。运维级工具。 |
| E6 | 批量操作 | `batch_delete_pages` / `batch_add_links` / `batch_merge_pages` | 批量删除/链接/合并。一次性操作多页。 |
| E7 | 写回 | `writeback` | 洞察写回页面（追加/创建概念/创建链接）。 |
| E8 | 备份/恢复 | CLI: `backup` / `restore` | zip 打包 vault + DB + LanceDB。CLI only。 |
| E9 | 状态总览 | `status` | 页面/链接/chunk 计数。技术指标。 |

### F. 安装与启动

| # | 能力 | 工具/配置 | 现状一句话 |
|---|------|----------|-----------|
| F1 | 初始化 | CLI: `init` | 创建 config + vault 目录。一次性。 |
| F2 | Profile 管理 | `get_profile` / `update_profile` / `remove_profile` / `reload_profile` | 用户偏好/约束/习惯。profile YAML 文件。 |
| F3 | 层级关系 | `set_hierarchy` / `get_hierarchy` / `remove_hierarchy` | reports_to 关系。组织架构场景。 |
| F4 | 标签管理 | `get_tags` / `add_tag` / `remove_tag` | DB + frontmatter 双写。 |
| F5 | 任务队列 | `job_submit` / `job_list` / `job_status` / `job_cancel` / `job_retry` | 异步任务管理。用户不直接接触。 |
| F6 | Hermes Brief | `hermes-cbrain-brief.md` | Agent 启动加载的压缩路由表。~1200 词。 |
| F7 | RESOLVER | `RESOLVER.md` | 完整 intent→skill 路由表。Agent 启动时首读。 |
| F8 | MCP 服务 | CLI: `serve` / `serve --http` | stdio 不启动 watcher；HTTP serve 才启动 auto-sync watcher。Hermes 的主要接入方式应明确。 |
| F9 | 安装与 onboarding | README / usage / init flow | 目前分散在文档和 CLI 帮助中。2.0 推广前必须形成清晰、简易、可验证的安装路径。 |

---

## UX 审计矩阵

每项能力从 8 个维度打分。🔴 = 必须改，🟡 = 建议改，🟢 = 目前 OK。

### A. 自然捕捉

#### A1. 对话提取（ingest_dialogue）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "记住这个"/"记到脑子里" | 不变 |
| Hermes 路由 | 🟡 | signal-detector → ingest，但 brief 没提 signal-detector | brief 应包含 signal-detector 触发规则 |
| 首轮响应 | 🟡 | auto 模式静默，用户不知道发生了什么 | 静默 OK，但当天首次触发应给一句确认 |
| 暴露内部字段 | 🟢 | 返回 slug 但 Hermes 不输出 | OK |
| 需要用户确认 | 🟡 | manual 模式需触发，auto 模式无确认 | auto 模式应有可配置的确认阈值 |
| 可追溯可撤回 | 🟢 | provenance 记录来源 | OK |
| 失败时用户看到 | 🔴 | LLM 调用失败时 error 返回，Hermes 可能原样输出 | 应给"暂时记不住，稍后再试" |
| 测试覆盖 | 🟢 | 有 routing eval | OK |
| 维护风险 | 🟢 | 低 | — |
| **v2.0 优先级** | **P1** | — | 静默提取的确认体验 + 失败优雅降级 |

#### A2. 内容导入（ingest）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "导入这篇内容"/"保存这个" | 不变 |
| Hermes 路由 | 🟢 | RESOLVER → ingest.md | OK |
| 首轮响应 | 🟡 | 返回 slug + 实体列表，Hermes 可能输出 slug | 应返回"已记住：{标题}，提取了 {N} 个人物/概念" |
| 暴露内部字段 | 🔴 | `ingest_result` 包含 entity_slugs、ner_candidates | Hermes 层过滤，用户只看到自然语言摘要 |
| 需要用户确认 | 🟡 | NER 提取的实体无确认直接入库 | 高置信度自动入库，低置信度应列出让用户确认 |
| 可追溯可撤回 | 🟢 | provenance 标记 `imported_content` | OK |
| 失败时用户看到 | 🟡 | JSON error | 应给可读错误 |
| 测试覆盖 | 🟢 | 有 routing eval | OK |
| 维护风险 | 🟢 | 低 | — |
| **v2.0 优先级** | **P1** | — | 响应格式自然化 + 低置信度 NER 确认 |

#### A3. 页面创建/更新（put_page）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "更新一下人物A的信息" | 不变 |
| Hermes 路由 | 🟢 | ingest.md → put_page | OK |
| 首轮响应 | 🟢 | 返回 action: "created"/"updated" + slug | Hermes 转换为自然语言即可 |
| 暴露内部字段 | 🟡 | 返回 slug，同名警告用中文但包含 slug | slug 不该给用户看 |
| 需要用户确认 | 🟢 | 同名人物有拦截机制 | OK |
| 可追溯可撤回 | 🟢 | 版本快照 + provenance | OK |
| 失败时用户看到 | 🟢 | error JSON，Hermes 可解析 | OK |
| 测试覆盖 | 🟢 | 双向 Known Relations 有测试 | OK |
| 维护风险 | 🟢 | #104 修完后同步 OK | — |
| **v2.0 优先级** | **P2** | — | 同名警告中 slug → 自然语言 |

#### A4. 页面追加（append_page）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "再补一段关于人物A的" | 不变 |
| Hermes 路由 | 🟢 | ingest.md → append_page | OK |
| 首轮响应 | 🟢 | 返回 action + new_length | OK |
| 暴露内部字段 | 🟡 | `new_length` 是内部指标 | Hermes 不输出 |
| 可追溯可撤回 | 🟢 | 版本快照 | OK |
| **v2.0 优先级** | **P2** | — | 过滤 new_length |

#### A6. 来源追踪（provenance）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🔴 | "这信息哪来的？"——但 Hermes 不知道该调 provenance | 应路由到 get_provenance |
| Hermes 路由 | 🔴 | RESOLVER 没有 provenance 路由 | 需要添加 |
| 首轮响应 | 🔴 | 直接返回 JSON，无自然语言模板 | 应返回"这条信息来自{对话日期/导入来源}，信任等级{已确认/待确认}" |
| 暴露内部字段 | 🔴 | 全部是内部字段 | 需要格式化层 |
| 可追溯可撤回 | 🟢 | update_trust_state 可纠正 | OK |
| **v2.0 优先级** | **P0** | — | 添加路由 + 自然语言格式化 |

### B. 自然增益回答

#### B1. 核查确认（deep_recall grounded）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "之前讨论过这个吗"/"有什么依据" | 不变 |
| Hermes 路由 | 🟢 | brief §1 + RESOLVER 最高优先 | OK |
| 首轮响应 | 🟢 | ≤300 字，标注"待确认" | OK |
| 暴露内部字段 | 🟢 | 有红线禁止 | OK |
| 测试覆盖 | 🟢 | routing eval + acceptance doc | OK |
| 一致性 | 🟢 | brief 和 RESOLVER 一致 | OK |
| **v2.0 优先级** | **🟢 维持** | — | 已收口，不需要改 |

#### B2. 内容回忆（deep_recall detail）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "当时怎么设计的"/"为什么选这个" | 不变 |
| Hermes 路由 | 🟢 | brief §2 + RESOLVER | OK |
| 首轮响应 | 🟢 | 首轮不展开，追问再展开 | OK |
| 暴露内部字段 | 🟢 | 有红线 | OK |
| **v2.0 优先级** | **🟢 维持** | — | 已收口 |

#### B3. 快速搜索（query）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "搜一下X"/"有没有关于X的" | 不变 |
| Hermes 路由 | 🟡 | brief §5 和 RESOLVER 都路由到 query，但 brief 禁止用 query 做 grounded/summary | OK 但容易混淆 |
| 首轮响应 | 🟡 | 返回 chunks，Hermes 需要自己合成 | 应该默认走 deep_recall 而不是 query |
| 暴露内部字段 | 🟡 | chunks 包含 slug、source_id、rank | Hermes 过滤 |
| **v2.0 优先级** | **P1** | — | query 应该只做底层，Hermes 路由应优先走 deep_recall |

#### B4. 情境找人（recall_episode）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "那个跟我做项目的人叫什么" | 不变 |
| Hermes 路由 | 🟢 | brief §3 + RESOLVER | OK |
| 首轮响应 | 🟢 | 多线索匹配，候选列表 | OK |
| 测试覆盖 | 🟢 | acceptance doc + routing eval | OK |
| **v2.0 优先级** | **🟢 维持** | — | 已收口 |

#### B5. 关系分析（graph_query）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "人物A和组织C什么关系" | 不变 |
| Hermes 路由 | 🟢 | brief §5 → graph_query，RESOLVER → connect.md | OK |
| 首轮响应 | 🟡 | 返回 link 列表（含 source_type、weight、confidence） | Hermes 应格式化为"他们通过{事件E}关联，关系是{合作}" |
| 暴露内部字段 | 🔴 | source_type、weight、confidence 是内部概念 | 需要 Hermes 层格式化 |
| 测试覆盖 | 🟡 | 有工具测试，无 routing eval | 需要 |
| **v2.0 优先级** | **P1** | — | 格式化层 + routing eval |

#### B6. 全景摘要（summarize）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "总结一下X"/"X的全景" | 不变 |
| Hermes 路由 | 🟢 | brief §5 → summarize | OK |
| 首轮响应 | 🟡 | 返回结构化数据 | 应直接输出摘要段落 |
| 暴露内部字段 | 🟡 | 可能包含 slug | 过滤 |
| **v2.0 优先级** | **P1** | — | 输出格式化 |

#### B7. 深度研究（agentic_research）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "帮我全面分析一下X"/"A和B各有什么优劣" | 不变 |
| Hermes 路由 | 🟢 | RESOLVER 标注 EXPERIMENTAL | OK |
| 首轮响应 | 🟡 | 可能需要 30s+，用户以为卡了 | Hermes 应先给自然语言预告；若要工具级进度，应走 job/progress 机制 |
| 暴露内部字段 | 🟢 | 有 answer contract 文档 | OK |
| 速度 | 🟡 | planner→executor→critic 多步 LLM 调用 | 需要预算提示或异步 job 机制 |
| 测试覆盖 | 🟢 | 有 answer contract + 单元测试 | OK |
| **v2.0 优先级** | **P1** | — | 进度预告或 job/progress 机制 |

#### B8. 实体展开（expand_entity）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 首轮响应 | 🟢 | 首轮禁自动展开 | OK |
| 触发时机 | 🟢 | 用户追问时 | OK |
| **v2.0 优先级** | **🟢 维持** | — | 已收口 |

#### B9. 档案生成（dossier）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "人物A的完整档案" | 不变 |
| Hermes 路由 | 🟢 | RESOLVER → review.md | OK |
| 首轮响应 | 🟡 | 首次生成需 LLM 调用，可能慢 | 应有缓存提示 |
| 暴露内部字段 | 🟡 | 包含 cached_at 等 | 过滤 |
| **v2.0 优先级** | **P2** | — | 缓存状态提示 |

#### B10. 深度推理（brain_storm）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "帮我分析一下X的盲区" | 不变 |
| Hermes 路由 | 🟢 | RESOLVER → query.md | OK |
| 首轮响应 | 🟡 | 返回 findings + gaps + connections | 格式化不足 |
| **v2.0 优先级** | **P2** | — | 输出模板化 |

#### B11. 证据导出（export_grounded_artifact）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟡 | 很少主动说"导出 HTML" | 应该在研究/回忆结果后主动提议 |
| 隐私 | 🟢 | 有 anonymize 参数 | OK |
| **v2.0 优先级** | **P2** | — | 主动提议导出 |

### C. 情境回忆重建

#### C1. 时间线（timeline）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "人物A的时间线"/"什么时候发生了X" | 不变 |
| Hermes 路由 | 🟢 | RESOLVER → review.md | OK |
| 首轮响应 | 🟡 | 返回 event 列表 | 应渲染为时间线叙事 |
| **v2.0 优先级** | **P1** | — | 时间线叙事格式化 |

#### C2. 版本历史（versions）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🔴 | "恢复之前的版本"——但 Hermes 不知道该调 revert_version | 需要路由 |
| Hermes 路由 | 🔴 | RESOLVER 无 versions 路由 | 需要添加 |
| 可感知性 | 🔴 | 用户不知道有版本历史 | 应在更新后提及"可恢复" |
| **v2.0 优先级** | **P1** | — | 添加路由 + 更新后提示 |

#### C3. 页面读取（get_page）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "看一下人物A的完整信息" | 不变 |
| 首轮响应 | 🟢 | 默认截断，可请求全量 | OK |
| **v2.0 优先级** | **🟢 维持** | — | OK |

### D. 低频复利反馈

#### D1. 发现检测（discovery）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "最近有什么发现" | 不变 |
| Hermes 路由 | 🟢 | brief §4 | OK |
| 首轮响应 | 🟢 | #100 后有 digest cards | OK |
| 暴露内部字段 | 🟢 | 有红线禁止 score/distance | OK |
| **v2.0 优先级** | **🟢 维持** | — | 已收口 |

#### D2. 洞察管理（insights）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟡 | 很少主动说"看洞察" | 应由 cron 定期推送 |
| Hermes 路由 | 🟢 | RESOLVER → query.md | OK |
| 首轮响应 | 🟡 | 返回 insight 列表 | 应格式化为卡片 |
| **v2.0 优先级** | **P1** | — | 格式化 + cron 推送机制 |

#### D3. 复利回顾（compounding review）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "有什么值得回顾的" | 不变 |
| Hermes 路由 | 🟢 | 有 routing eval + acceptance doc | OK |
| 首轮响应 | 🟢 | 5 门过滤，低质量自动沉默 | OK |
| **v2.0 优先级** | **🟢 维持** | — | 已收口 |

#### D4. 反馈学习（record_feedback）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟡 | "这个结果不对"/"不是这个" | Hermes 应调 record_feedback |
| Hermes 路由 | 🟢 | RESOLVER → query.md | OK |
| 感知性 | 🟢 | 静默学习，不需要用户感知 | OK |
| **v2.0 优先级** | **🟢 维持** | — | OK |

### E. 维护治理

#### E1. 健康检查（health）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "脑子怎么样"/"检查一下" | 不变 |
| Hermes 路由 | 🟢 | RESOLVER → dream.md | OK |
| 首轮响应 | 🔴 | 13 维度技术报告，用户看不懂 | 应翻译为"脑子状态：良好/注意/异常"，附简短摘要 |
| 暴露内部字段 | 🔴 | 全部内部 | 需要格式化层 |
| **v2.0 优先级** | **P1** | — | 输出自然语言摘要 |

#### E2. 实体提升（enrich）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 首轮响应 | 🟡 | 触发时不通知用户 | 批量提升后应给一句"更新了 {N} 个实体的信息" |
| **v2.0 优先级** | **P2** | — | 通知机制 |

#### E3. 同步（sync）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "同步一下" | 不变 |
| 首轮响应 | 🟢 | 返回同步统计 | OK |
| **v2.0 优先级** | **🟢 维持** | — | OK |

#### E4. 夜间管道（dream）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 首轮响应 | 🟡 | 每步输出技术日志 | 应给执行摘要 |
| **v2.0 优先级** | **P2** | — | 执行摘要格式化 |

#### E6. 批量操作（batch）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟡 | "把这几个重复的合并" | OK |
| 安全性 | 🟡 | 批量删除无二次确认 | 应要求确认 |
| **v2.0 优先级** | **P1** | — | 批量操作确认机制 |

### F. 安装与启动

#### F2. Profile 管理

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟡 | "记住我喜欢X"/"我的偏好是Y" | 应自动路由到 update_profile |
| Hermes 路由 | 🔴 | RESOLVER 无 profile 路由 | 需要添加 |
| **v2.0 优先级** | **P1** | — | 添加 profile 路由 |

#### F3. 层级关系（hierarchy）

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🟢 | "人物A汇报给谁"/"组织架构" | 不变 |
| Hermes 路由 | 🟢 | RESOLVER → query.md | OK |
| **v2.0 优先级** | **🟢 维持** | — | OK |

#### F9. 安装与 onboarding

| 维度 | 评分 | 现状 | v2.0 期望 |
|------|------|------|----------|
| 用户会怎么说 | 🔴 | "我怎么装起来给自己的 Agent 用？" | 有一条从零到可用的安装路径 |
| Hermes 路由 | 🟡 | 不适用，属于人类安装文档 | Agent 可辅助解释安装步骤 |
| 首轮体验 | 🔴 | init、serve、profile、runtime、MCP/HTTP、cron 分散在多处 | 一份 guide 覆盖安装、配置、启动、验证、排错 |
| 失败时用户看到 | 🔴 | 依赖、端口、runtime、watcher 问题需要人工判断 | guide 必须有 smoke test 和常见错误处理 |
| 测试覆盖 | 🟡 | CLI 有测试，但 onboarding 无端到端验收 | 增加 install smoke checklist |
| **v2.0 优先级** | **P0** | — | 新用户安装/onboarding guide |

---

## 优先级汇总

### P0 — v2.0 发布前必须完成

| ID | 问题 | 影响 | 建议 issue |
|----|------|------|-----------|
| A6 | provenance 无 Hermes 路由 | 用户问"信息哪来的"走不通 | `feat: add provenance routing to RESOLVER and brief` |
| E1a | 缺少结构一致性 health 检查 | graph、Markdown、wikilink、结构化字段不一致会静默影响 recall | `#106 health: add structural consistency checks for graph, markdown, and structured fields` |
| F9 | 新用户安装/onboarding 不成体系 | 2.0 推广时其他用户难以顺利安装、配置、验证和接入 Agent | `docs: create end-to-end install and onboarding guide for CBrain 2.0` |

### P1 — v2.0 应该完成

| ID | 问题 | 影响 | 建议 issue |
|----|------|------|-----------|
| A1 | 对话提取失败不优雅 | 用户看到 raw error | `fix: graceful degradation for ingest_dialogue failures` |
| A2 | ingest 返回内部字段 | slug、ner_candidates 泄露 | `feat: natural-language summary for ingest results` |
| B3 | query 应默认走 deep_recall | 搜索结果不合成 | `refactor: Hermes routing should prefer deep_recall over raw query` |
| B5 | graph_query 输出内部字段 | source_type、weight 泄露 | `feat: natural-language formatter for graph query results` |
| B6 | summarize 输出未格式化 | 返回结构化数据而非摘要段落 | `feat: output template for summarize tool` |
| B7 | agentic_research 缺少进度预告或异步机制 | 用户可能误以为卡住，尤其复杂研究耗时较长 | `feat: add agentic research progress preface or job-mode execution` |
| C1 | 时间线无叙事格式 | 返回事件列表 | `feat: timeline narrative renderer` |
| C2 | 版本历史无路由 | 用户无法恢复 | `feat: add versions/revert routing to RESOLVER` |
| D2 | 洞察无格式化和推送机制 | 用户不知道有洞察 | `feat: insight card formatter + cron push` |
| E1 | health 输出是技术报告 | 用户看不懂 | `feat: natural-language health summary` |
| E6 | 批量操作无确认 | 误操作风险 | `feat: confirmation gate for batch operations` |
| F2 | profile 无路由 | 用户偏好无法自然设置 | `feat: add profile routing to RESOLVER` |

### P2 — v2.0 可以推后

| ID | 问题 | 建议 issue |
|----|------|-----------|
| A3 | 同名警告包含 slug | slug → 自然语言 |
| A4 | 返回 new_length | 过滤内部字段 |
| B9 | dossier 无缓存状态提示 | 缓存命中/miss 提示 |
| B10 | brain_storm 输出未模板化 | 输出模板 |
| B11 | 证据导出不主动提议 | 研究/回忆后主动问 |
| E2 | enrich 无通知 | 批量提升后通知 |
| E4 | dream 输出技术日志 | 执行摘要 |

### 🟢 已收口，维持现状

B1 (grounded recall)、B2 (content recall)、B4 (episodic recall)、B8 (expand_entity)、C3 (get_page)、D1 (discovery)、D3 (compounding review)、D4 (feedback learning)、E3 (sync)、F3 (hierarchy)

---

## 路由一致性审计

### RESOLVER.md vs hermes-cbrain-brief.md 差异

| 意图 | RESOLVER 路由 | Brief 路由 | 一致？ |
|------|-------------|-----------|--------|
| 核查确认 | query.md [grounded] | §1 → deep_recall(grounded:true) | ✅ 一致（skill 文件再路由到工具） |
| 内容回忆 | query.md [detail=normal] | §2 → deep_recall(detail:"normal") | ✅ 一致 |
| 情境找人 | query.md [episodic] | §3 → recall_episode | ✅ 一致 |
| 关系分析 | connect.md | §5 → graph_query | ✅ 一致 |
| 发现摘要 | query.md | §4 → read_discoveries | ✅ 一致 |
| provenance | **无路由** | **未提及** | 🔴 缺失 |
| versions/revert | **无路由** | **未提及** | 🔴 缺失 |
| profile | **无路由** | **未提及** | 🔴 缺失 |
| signal-detector | signal-detector.md | **未提及** | 🟡 brief 缺失 |

### 建议新增路由

```
### Source Tracking
| "这信息哪来的" / "来源" / "依据来源" / "who said that" | provenance | query.md |

### Version History
| "恢复之前的版本" / "版本历史" / "回滚" / "之前的内容" | versions | review.md |

### User Profile
| "我的偏好" / "记住我喜欢" / "我习惯" / "设置偏好" | profile | ingest.md |
```

---

## 不做事项

| 不做 | 原因 |
|------|------|
| 在本审计 issue 中实现安装流程 | #105 只做 UX 审计矩阵；但 v2.0 必须单独完成 install/onboarding guide |
| UI/HTML artifact 重新设计 | 导出功能可用，不阻塞 |
| Ontology 变更 | 类型体系稳定，不因 UX 改动 |
| NER 引擎替换 | 准确率够用，优化投入产出比低 |
| 多用户/多租户 | 个人知识库，不在 v2.0 范围 |
| 关系类型体系重新设计 | relation_audit 已有治理工具 |
| FTS5 搜索引擎替换 | 混合搜索已可用 |
| #29 (master roadmap) | 独立跟踪，不合并 |

---

## 数据一致性风险

| 风险 | 现状 | 建议 |
|------|------|------|
| DB/Vault 双写不同步 | sync 可修复，但写入路径有多张表和索引投影 | #106 增加结构一致性 health 检查，dream 通过 health 自然覆盖 |
| NER 类型翻转 | resolveTypePriority 保护 | 维持 |
| 重复实体 | type gate + 同名警告 | 维持 |
| Known Relations 单向或缺失 | #104 修完，双向同步已上线，但需要 health 持续检测回归 | #106 监控 links 表 ↔ Known Relations |
| 跨层 merge | canMerge 拦截 | 维持 |
| LanceDB 文件膨胀 | compact 命令可用 | dream 管道应定期 compact |

---

## 附录：建议新 issue 草案

> 以下为建议清单，待 PM 审核后正式创建。按 P0 → P1 → P2 排序。

### P0

1. **`feat: add provenance routing to RESOLVER and brief`**
   - 范围：RESOLVER 添加 Source Tracking 路由 → query.md；brief 添加 §provenance；Hermes 格式化 provenance 输出为自然语言
   - 验收：用户问"这信息哪来的"→ Hermes 返回来源描述 + 信任等级

2. **`#106 health: add structural consistency checks for graph, markdown, and structured fields`**
   - 范围：health 增加结构一致性维度，检查 links 表、Known Relations、wikilink、结构化字段之间的不一致
   - 验收：graph/Markdown/structured fields 不一致时，health 和 dream 都能报告用户可理解的问题

3. **`docs: create end-to-end install and onboarding guide for CBrain 2.0`**
   - 范围：从安装依赖、初始化、配置 vault/profile/runtime、启动 HTTP/MCP、Hermes 接入，到 health/sync/query smoke test
   - 验收：新用户按步骤执行后，能启动 CBrain、接入 Agent，并完成一次保存、同步、查询和健康检查

### P1

4. **`fix: graceful degradation for ingest_dialogue failures`**
   - 范围：LLM 调用失败时返回用户可读消息而非 raw error

5. **`feat: natural-language summary for ingest results`**
   - 范围：ingest 返回自然语言摘要（"已记住{标题}，提取了 {N} 个人物/概念"）；Hermes 过滤 slug/ner_candidates

6. **`refactor: Hermes routing should prefer deep_recall over raw query`**
   - 范围：调整路由优先级，大部分搜索意图走 deep_recall，query 只做底层

7. **`feat: natural-language formatter for graph query results`**
   - 范围：graph_query 返回自然语言关系描述，过滤 source_type/weight/confidence

8. **`feat: output template for summarize tool`**
   - 范围：summarize 输出渲染为摘要段落

9. **`feat: add agentic research progress preface or job-mode execution`**
   - 范围：Hermes 发起复杂研究时先给自然语言预告；如需工具级进度，改为 job/progress 机制，而不是在单次 MCP 调用中硬塞进度

10. **`feat: timeline narrative renderer`**
   - 范围：时间线渲染为叙事格式

11. **`feat: add versions/revert routing to RESOLVER`**
   - 范围：添加路由 + 更新后提示可恢复

12. **`feat: insight card formatter + cron push`**
    - 范围：洞察格式化为卡片；cron 定期推送

13. **`feat: natural-language health summary`**
    - 范围：health 输出翻译为"良好/注意/异常" + 简短摘要

14. **`feat: confirmation gate for batch operations`**
    - 范围：batch_delete/batch_merge 执行前要求用户确认

15. **`feat: add profile routing to RESOLVER`**
    - 范围：用户偏好/习惯设置路由到 update_profile

### P2

16. **`fix: replace slug in duplicate-title warning with natural language`**
17. **`fix: filter internal fields from append_page response`**
18. **`feat: dossier cache status hint`**
19. **`feat: brain_storm output template`**
20. **`feat: proactive artifact export suggestion`**
21. **`feat: enrich completion notification`**
22. **`feat: dream execution summary format`**

---

> 审计完成于 v1.9.0。下一步：PM 审核 issue 草案，确认 P0/P1 后开始实施。
