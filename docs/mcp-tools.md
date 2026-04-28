# MCP 工具参考

> 38 个 MCP 工具，通过 `cbrain serve` 暴露给 AI Agent

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

混合搜索，自动融合向量 + 全文 + 图谱 + 多查询扩展。

```json
{ "query": "诺华项目进展", "strategy": "all", "limit": 10 }
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| query | string | 是 | 搜索内容 |
| strategy | "all" \| "vector" \| "fts" \| "graph" | 否 | 默认 all |
| limit | number | 否 | 默认 10 |
| multiQuery | boolean | 否 | 是否 LLM 扩展查询，默认 true |

### ingest

录入内容。自动分块、NER 实体提取、图谱建边。

```json
{
  "content": "完整内容...",
  "type": "text",
  "title": "文档标题",
  "pageType": "record",
  "tags": ["重要", "诺华"]
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

10 维度健康检查，报告写入 `outputs/health/`。

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
{ "slug": "brain/entities/张三" }
```

不传 slug 则全部升级。

### maintain

一键维护：sync → enrich → health。

```json
{}
```

### remove_orphans

删除 DB 中有但 vault 中无对应文件的记录。

```json
{}
```

### generate_indexes

生成首页、实体索引、概念索引、来源索引到 outputs/。

```json
{}
```

### merge_pages

合并重复页面。源页面的 links/timeline/tags 全部迁移到目标页面，源页面删除。

```json
{ "source": "brain/entities/王强-1", "target": "brain/entities/王强" }
```

---

## 页面工具

### get_page

获取页面完整内容。

```json
{ "slug": "brain/entities/王强" }
```

### list_pages

分页列出页面。

```json
{ "type": "entity", "limit": 50, "offset": 0 }
```

### put_page

创建或覆盖页面。

```json
{
  "slug": "brain/entities/新实体",
  "content": "页面内容...",
  "type": "entity",
  "title": "新实体",
  "tags": ["标签"]
}
```

注意：不能写入 `raw/` 前缀的 slug。

### delete_page

删除页面（同时删除 vault 文件和 DB 记录）。

```json
{ "slug": "brain/entities/过时内容" }
```

### resolve_slugs

批量确认名称在 CBrain 中的存在。

```json
{ "queries": ["王磊", "张伟", "诺华"] }
```

### writeback

将 Agent 修改的内容写回 vault markdown 文件。

```json
{ "slug": "brain/entities/王强", "content": "追加内容..." }
```

注意：不能写入 `raw/` 前缀的 slug。

---

## 标签工具

### get_tags

```json
{ "slug": "brain/entities/王强" }
```

### add_tag

```json
{ "slug": "brain/entities/王强", "tag": "重要" }
```

### remove_tag

```json
{ "slug": "brain/entities/王强", "tag": "过时标签" }
```

---

## 链接工具

### get_links

```json
{ "slug": "brain/entities/王强", "direction": "out" }
```

direction: "out"（出链）、"in"（入链）、不传则双向。

### remove_link

```json
{ "from": "brain/entities/王强", "to": "brain/entities/诺华", "relation": "works_at" }
```

### graph_query

图谱遍历。

```json
{ "slug": "brain/entities/王强", "mode": "traverse", "depth": 2 }
```

mode: "traverse"（前向遍历）、"backlinks"（反向引用）、"related"（关联实体）

---

## 时间线工具

### get_timeline

```json
{ "slug": "brain/entities/诺华" }
```

### add_timeline_entry

```json
{
  "slug": "brain/entities/诺华",
  "summary": "进入第二轮谈判",
  "eventDate": "2026-04-15",
  "source": "brain/records/会议纪要0415"
}
```

---

## 版本历史

### get_versions

```json
{ "slug": "brain/entities/王强" }
```

### revert_version

回退到指定版本（回退前自动创建快照）。

```json
{ "slug": "brain/entities/王强", "version": 3 }
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

## 原始数据

| 工具 | 参数 | 说明 |
|------|------|------|
| put_raw_data | `{ slug, key, data, mime_type? }` | 存储二进制数据 |
| get_raw_data | `{ slug, key }` | 获取二进制数据 |
| list_raw_data | `{ slug }` | 列出所有 key |
| delete_raw_data | `{ slug, key }` | 删除二进制数据 |

---

## 可观测性

| 工具 | 参数 | 说明 |
|------|------|------|
| get_chunks | `{ slug }` | 获取分块列表 |
| get_ingest_log | `{ limit? }` | 查看 ingest 日志 |
| get_config | `{ key }` | 读取配置 |
| set_config | `{ key, value }` | 设置配置 |
