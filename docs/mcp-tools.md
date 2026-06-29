# MCP 工具参考

> MCP 工具参考。完整工具清单（由 `cbrain serve` 注册输出自动生成）见文末「完整工具索引」。

## 接入方式

在 Agent 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "cbrain": {
      "command": "cbrain",
      "args": ["serve"]
    }
  }
}
```

---

## 核心工具

### query

底层关键词搜索，返回 slug + snippet。默认 smart 策略（FTS 优先，空结果回退混合）。用于调试、定位精确关键词、deep_recall 降级。**自然语言问题请用 `deep_recall`**，全貌用 `summarize`，找人用 `recall_episode`。

```json
{ "query": "组织A", "limit": 10 }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索内容 |
| strategy | "smart" \| "fts" \| "vector" \| "all" | 否 | 默认 smart（FTS 优先，空则混合）；all=全量混合（最慢） |
| limit | number | 否 | 默认 10 |
| multiStep | boolean | 否 | 多轮深度搜索（换策略重试 + LLM 重排序），默认 false |

### ingest

录入内容。自动分块、NER 实体提取、图谱建边。

```json
{
  "content": "完整内容...",
  "type": "text",
  "title": "文档标题",
  "pageType": "record",
  "tags": ["重要", "组织A"]
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| content | string | 是 | 要录入的内容 |
| type | "text" \| "markdown" | 否 | 默认 text |
| title | string | 建议 | 页面标题 |
| pageType | "entity" \| "concept" \| "event" \| "record" \| "source" | 否 | 默认 record |
| tags | string[] | 否 | 标签列表 |

### status

知识库统计。

```json
{}
```

返回：页面总数、各类型分布、链接数、分块数。

### health

14 维度健康检查，报告写入 `<profileDir>/runtime/health/`。

```json
{}
```

### sync

全量同步 vault 文件到索引。自动清理孤儿和过期 stub。

```json
{}
```

### enrich

实体层级升级（基于提及次数）。

```json
{ "slug": "brain/entities/人物a" }
```

不传 slug 则全部升级。

### remove_orphans

删除 DB 中有但 vault 中无对应文件的记录。

```json
{}
```

### generate_indexes

生成首页、实体索引、概念索引、来源索引到 `<profileDir>/runtime/indexes/`。

```json
{}
```

### merge_pages

合并重复页面。源页面的 links/timeline/tags 全部迁移到目标页面，源页面删除。

```json
{ "source": "brain/entities/人物b-1", "target": "brain/entities/人物b" }
```

---

## 页面工具

### get_page

获取页面完整内容。

```json
{ "slug": "brain/entities/人物b" }
```

### list_pages

分页列出页面。

```json
{ "type": "entity", "limit": 50, "offset": 0 }
```

### put_page

创建或更新页面。**已存在页面默认 patch 模式**（追加正文、合并 tags、保留原内容）；显式 `mode: "replace"` 才整页覆盖（覆盖前自动建版本快照）。新建页面时 mode 无效。

```json
{
  "slug": "brain/entities/新实体",
  "content": "页面内容...",
  "mode": "patch",
  "type": "entity",
  "title": "新实体",
  "tags": ["标签"]
}
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| slug | string | 是 | 页面 slug |
| content | string | 是 | 正文（patch 追加 / replace 替换） |
| mode | "patch" \| "replace" | 否 | patch=默认（追加+合并 tags）；replace=显式整页覆盖 |
| title | string | 新建必填 | 页面标题 |
| type | string | 否 | 默认 record |
| tags | string[] | 否 | patch 合并 / replace 替换 |

注意：不能写入 `raw/` 前缀的 slug。

### delete_page

删除页面（同时删除 vault 文件和 DB 记录）。

```json
{ "slug": "brain/entities/过时内容" }
```

### resolve_slugs

批量确认名称在 CBrain 中的存在。

```json
{ "queries": ["人物C", "人物D", "组织A"] }
```

### writeback

将 Agent 修改的内容写回 vault markdown 文件。

```json
{ "slug": "brain/entities/人物b", "content": "追加内容..." }
```

注意：不能写入 `raw/` 前缀的 slug。

---

## 标签工具

### get_tags

```json
{ "slug": "brain/entities/人物b" }
```

### add_tag

```json
{ "slug": "brain/entities/人物b", "tag": "重要" }
```

### remove_tag

```json
{ "slug": "brain/entities/人物b", "tag": "过时标签" }
```

---

## 链接工具

### get_links

```json
{ "slug": "brain/entities/人物b", "direction": "out" }
```

direction: "out"（出链）、"in"（入链）、不传则双向。

### remove_link

```json
{ "from": "brain/entities/人物b", "to": "brain/entities/组织a", "relation": "works_at" }
```

### graph_query

图谱遍历。

```json
{ "slug": "brain/entities/人物b", "mode": "traverse", "depth": 2 }
```

mode: "traverse"（前向遍历）、"backlinks"（反向引用）、"related"（关联实体）

---

## 时间线工具

### get_timeline

```json
{ "slug": "brain/entities/组织a" }
```

### add_timeline_entry

```json
{
  "slug": "brain/entities/组织a",
  "summary": "进入第二轮谈判",
  "eventDate": "2026-04-15",
  "source": "brain/records/会议纪要0415"
}
```

---

## 版本历史

### get_versions

```json
{ "slug": "brain/entities/人物b" }
```

### revert_version

回退到指定版本（回退前自动创建快照）。

```json
{ "slug": "brain/entities/人物b", "version": 3 }
```

---

## 任务队列

| 工具 | 参数 | 说明 |
|------|------|------|
| job_submit | `{ name, data?, priority? }` | 提交异步任务 |
| job_list | `{ status? }` | 列出任务 |
| job_status | `{ id }` | 查看任务详情 |
| job_cancel | `{ id }` | 取消任务 |
| job_retry | `{ id }` | 重试失败任务 |

---

## 可观测性

| 工具 | 参数 | 说明 |
|------|------|------|
| get_chunks | `{ slug }` | 获取分块列表 |
| get_ingest_log | `{ limit? }` | 查看 ingest 日志 |

---

## 完整工具索引

由 `cbrain serve` 注册输出自动生成，勿手改（运行 `bun bin/check-docs-consistency.ts --update` 刷新）。

<!-- cbrain:auto-gen mcp-tools:start -->
共 83 个 MCP 工具（`cbrain serve` 注册输出，按字母序）。

| 工具 | 说明 |
|------|------|
| `act_on_review_candidate` | 对复利洞察候选执行操作：接受（确认洞察）、拒绝（丢弃）、推迟（稍后提醒）、禁用（永久静默）。每次操作会记录审计日志。 |
| `add_alias` | Add an alias to a page. |
| `add_knowledge` | 添加事实或关系到知识图谱。自动解析实体名称，不存在时创建 stub entity（非 record）。支持结构化字段、关系、汇报关系和文本备注。不会创建新的 record 页面。支持 dry_run… |
| `add_link` | Create a link between two pages. |
| `add_tag` | Add a tag to a page. |
| `add_timeline_entry` | Add a timeline entry to a page. |
| `agentic_research` | [EXPERIMENTAL/INTERNAL] 多步 agentic 研究：规划→执行→评估→(一次补充)→结果。适用于复杂查询需要多步推理、交叉验证的场景。简单查询仍用… |
| `append_page` | Append content to an existing page's body. |
| `archive_insight` | Archive an insight. |
| `batch_add_links` | Create multiple links in one call. |
| `batch_delete_pages` | Delete multiple pages in one call. |
| `batch_merge_pages` | Merge multiple page pairs in one call. |
| `brain_storm` | Deep reasoning and knowledge gap analysis. |
| `cbrain_recall` | CBrain 自然语言前门。Hermes 面向用户提问时优先调用本工具，由 CBrain 决定走证据核查、内容回忆、情境找人、组织架构、全貌总结、关系分析、复杂判断或 debug 搜索。返回… |
| `confirm_evidence` | 用户明确确认一条知识为可信事实。必须提供 confirmation_record_slug（vault 中已存在的页面）和 excerpt（该页面正文中必须包含的确认原文），系统会验证页面存在且 excerpt… |
| `deep_recall` | 【默认查询工具】查找人物、公司、概念等实体。默认返回精简视图（200字摘要+基础信息）。需要完整上下文（关系、时间线、档案、层级）时传… |
| `delete_page` | Delete a page by slug. |
| `dismiss_insight` | Dismiss an insight as not useful. |
| `dossier` | Generate or retrieve a structured dossier (brief/profile) for an entity. |
| `dream` | 异步执行完整夜间维护流程（sync → enrich → seal → cleanup → health → insight archive）。立即返回 job_id，后台执行。使用 dream_status… |
| `dream_reset` | Clear the dream cycle lock. |
| `dream_status` | 查询最近一次 dream 任务的状态和阶段进度。 |
| `enrich` | Run entity enrichment. |
| `expand_entity` | Expand a single entity to full detail — complete body, all links, full timeline, tags, related entities, and… |
| `export_grounded_artifact` | 导出 grounded recall 或 agentic research 结果为本地 HTML artifact。仅在用户明确要求导出/保存/分享时调用。不执行新的检索。 |
| `generate_indexes` | Generate Obsidian-readable index files: All-Entities, All-Concepts, All-Sources, Dashboard. |
| `get_chunks` | Get indexed text chunks for a page. |
| `get_compounding_reviews` | 生成复利洞察：只有通过全部5个门槛（证据充分性、持久性、新颖性、行动价值、信任风险）的候选才会出现在结果中。没通过门槛的候选会被过滤，返回 silence_reason 说明原因。 |
| `get_hierarchy` | Get the full hierarchy context for an entity: direct manager, subordinates, and peers. |
| `get_ingest_log` | Get recent ingest log entries. |
| `get_insight` | Get full insight details by ID, including content and linked source entities. |
| `get_links` | Get links for a page. |
| `get_org_tree` | 获取实体的组织架构树。沿 reports_to 边遍历，返回向上（上级链）和/或向下（下属树）的完整层级。接受 slug 或 query（自动解析实体名）。多候选时返回候选列表让调用方澄清。 |
| `get_page` | Get a page by slug. |
| `get_pages` | 批量获取多个页面的摘要信息。用于 get_org_tree / deep_recall 后批量补详情。返回 compact 格式，默认不含长正文。连续多次 get_page → 改用本工具一次搞定。缺失的 slug 按… |
| `get_profile` | Query personalized profile entries — preferences, constraints, habits, and context specific to the user. |
| `get_provenance` | 获取知识条目的溯源信息：来源、信任状态、纠正历史 |
| `get_tags` | Get all tags for a page. |
| `get_timeline` | Get timeline entries for a page. |
| `get_versions` | Get version history for a page. |
| `graph_query` | Query the knowledge graph. |
| `health` | Run a 14-dimension health check (errors, dedup, slug collisions, consistency, structural consistency,… |
| `ingest` | Ingest content into the brain. |
| `ingest_dialogue` | Ingest a dialogue/conversation into the brain. |
| `job_cancel` | Cancel a pending or running job |
| `job_list` | List jobs, optionally filtered by status |
| `job_retry` | Retry a failed job |
| `job_status` | Get detailed status of a specific job |
| `job_submit` | Submit a new job to the queue |
| `list_insights` | List structured insights generated by reflect or promoted from discoveries. |
| `list_pages` | List pages in the brain. |
| `mark_discovery_seen` | 标记发现为已读。建议使用 update_discovery_status 替代。 |
| `merge_entities` | 实体合并专用安全入口。支持 dry_run（返回合并规划，零写入）和 execute（安全执行合并 + 自动验证残留）。仅限 derived 层（entity/concept/insight），拒绝 record… |
| `merge_pages` | Merge a source page into a target page. |
| `promote_discovery` | 将结构发现升级为结构化洞察。Agent 或用户审核发现后确认值得保留时使用。如果发现有 LLM 生成的建议，会自动用做洞察内容。 |
| `put_page` | Create or update a page. |
| `query` | 底层关键词搜索，返回原始文本片段（slug + snippet）。仅限以下场景：调试（确认某个关键词是否被索引、出现在哪些页面）、定位（已知精确关键词，需要找到对应的 slug）、deep_recall… |
| `query_insights` | Semantic search over insights. |
| `read_discoveries` | 读取知识图谱的结构发现摘要（最多 3 条）。返回用户可见的发现卡片，包含为什么重要、依据、建议动作。如需处理发现，用 update_discovery_status 标记已读、已解决或忽略。 |
| `read_knowledge_map` | 【知识图谱】读取最近一次生成的知识图谱报告（由每周 dream 的 knowledge-map 阶段或 `cbrain knowledge-map` 生成）。回答：我的知识图谱长什么样 / 哪些领域成熟 /… |
| `recall_episode` | 被动情境找人：根据时间、主题、关系、场景、事件等线索，召回可能匹配的人物。适用于用户不记得人名、但记得某些情境信息的场景。触发信号：'见过谁'、'认识谁'、'那个人是谁'、'叫什么来着'、'去年团建见过谁'、'在XX认识… |
| `record_feedback` | Record feedback on recall/search results. |
| `relation_audit` | Audit and fix non-standard relation types. |
| `reload_profile` | Reload profile data from YAML files. |
| `remove_alias` | Remove an alias from a page. |
| `remove_hierarchy` | Remove the reports_to hierarchy for an entity. |
| `remove_link` | Remove a link between two pages. |
| `remove_orphans` | Remove database entries that have no corresponding vault file. |
| `remove_profile` | Remove profile entries by ID. |
| `remove_tag` | Remove a tag from a page. |
| `resolve_slugs` | Resolve page titles or partial names to slugs. |
| `revert_version` | Revert a page to a specific version. |
| `run_discovery` | 运行发现管线，检查知识图谱中的变化和机会。完成后返回用户可见的发现摘要（最多 3 条）。可用 read_discoveries 查看历史发现，用 update_discovery_status… |
| `set_hierarchy` | Set the direct manager (reports_to) for an entity. |
| `set_trust_state` | 设置知识条目的信任状态（仅降级/纠正，不可升级为 trusted）。要将条目升级为 trusted，请使用 confirm_evidence。 |
| `status` | Get brain status: page counts, sync info, watcher state, quarantine, etc. |
| `summarize` | 探索一个领域或主题的全貌。搜索相关实体后沿图做 1-2 跳遍历，发现实体间的关联和邻居节点。适用：'帮我了解 XX 生态'、'这个领域有哪些关键玩家'、'XX 和 YY 之间有没有我没注意到的联系'。与… |
| `sync` | Sync vault files to SQLite + LanceDB indexes. |
| `update_discovery_status` | 更新发现的处理状态。支持标记已读(seen)、已解决(resolved)、已忽略(dismissed)。 |
| `update_profile` | Create or update profile entries. |
| `wakeup_diff` | 生成认知变化摘要（Wake-up Diff）。对比上次快照，产出新增记忆项、内容更新、tier 变化、关系变化、置信度衰减等差异。首次运行建立基线。可由 dream 自动触发或手动运行。 |
| `watcher_quarantine` | Manage watcher quarantine and bulk-change backpressure. |
| `writeback` | Write insights back to the knowledge base. |
<!-- cbrain:auto-gen mcp-tools:end -->
