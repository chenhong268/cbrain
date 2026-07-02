# Wake-up Diff — 每日认知变化摘要设计规格

> Issue: #141 | Date: 2026-06-05

## 问题

CBrain 缺少一个关键维度：**我对世界的认知哪里变了**。现有 dream 做维护（sync/enrich/seal/cleanup），health 做巡检，但没有"昨天到今天，哪些实体的理解变了、哪些新知识进入了系统"的摘要。

## 设计

### 核心思路

每次运行时：快照当前 brain 状态 → 与上次快照对比 → 产出结构化 diff → 写报告。

纯规则提取，不调 LLM。输出 boring but reliable。

### 触发方式

- **Dream stage**: 作为 dream pipeline 的最后一个 stage（Stage 7.5），在 health/index 之后运行
- **MCP tool**: `wakeup_diff` 手动触发，供 Agent 日常查询和 smoke test
- **CLI**: `cbrain wakeup-diff` 命令行触发
- 不做独立 cron

### DB Schema

两张新表：

```sql
CREATE TABLE IF NOT EXISTS brain_snapshots (
  id TEXT PRIMARY KEY,            -- e.g. "2026-06-05T03:00:00Z"
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'wakeup_diff',
  page_count INTEGER NOT NULL,
  link_count INTEGER NOT NULL,
  health_issue_count INTEGER
);

CREATE TABLE IF NOT EXISTS brain_snapshot_items (
  snapshot_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT,
  tier INTEGER,
  mention_count INTEGER,
  link_count INTEGER,
  updated_at TEXT,
  page_type TEXT,
  confidence_decay REAL,
  PRIMARY KEY (snapshot_id, slug)
);
```

快照保留最近 7 份，dream 运行时清理旧快照。

### Diff 检测项

| 检测项 | 判定逻辑 | 输出摘要模板 |
|--------|----------|-------------|
| **新增记忆项** | 新快照有、旧快照没有的 slug | `"{title}（{type}）"` |
| **内容更新** | content_hash 变化 | `"{title}：内容已更新"` |
| **Tier 变化** | tier 数值变化（注意 tier 1=最高） | `"{title}：{旧tier} → {新tier}"` |
| **关系变化** | link_count delta（注意：只检测数量差异，"删一条加一条"的替换不会被检测到） | `"{title}：{+N/-M} 条关系"` |
| **删除/归档** | 旧快照有、新快照没有的 slug | `"{title}：已移除"` |
| **Confidence 衰减** | confidence_decay 下降超过 0.1 | `"{title}：置信度 {旧} → {新}"` |

### 输出格式

**Markdown**（`runtime/wakeup/wakeup-{date}.md` + `latest.md`）：

```markdown
CBrain Wake-up Diff · {{日期}}

认知变化（{{N}} 项）：
- {{title}}：{{什么变了}}
- ...

新增记忆项（{{N}} 个）：
- {{title}}（{{type}}）

降级/过期（{{N}} 项）：
- {{title}}：{{原因}}
```

总计控制在 20 行以内，超出按重要性排序截断（tier 变化 > 内容更新 > 关系变化）。

**JSON**（`runtime/wakeup/wakeup-{date}.json` + `latest.json`）：

```typescript
interface WakeupDiff {
  date: string;
  baselineCreated: boolean;
  previousSnapshotId: string | null;
  snapshotId: string;
  stats: {
    totalPages: number;
    totalLinks: number;
    previousPages: number;
    previousLinks: number;
  };
  changes: {
    contentUpdated: Array<{ slug: string; title: string; type: string }>;
    tierChanged: Array<{ slug: string; title: string; oldTier: number; newTier: number }>;
    linkCountChanged: Array<{ slug: string; title: string; oldCount: number; newCount: number; diff: number }>;
    confidenceDecayed: Array<{ slug: string; title: string; oldValue: number; newValue: number }>;
    removed: Array<{ slug: string; title: string; type: string }>;
  };
  newItems: Array<{ slug: string; title: string; type: string }>;
  truncated: boolean;
  truncationReason?: string;
}
```

### 文件组织

```
src/core/maintenance/wakeup.ts          — WakeupDiff 类：snapshot + diff + report
src/mcp/tools/wakeup.ts     — MCP tool: wakeup_diff
src/cli/                    — CLI 命令注册（复用 WakeupDiff）
tests/core/wakeup.test.ts   — 单元测试
tests/mcp/wakeup.test.ts    — MCP tool 测试
```

### 与现有系统的集成

1. **Dream pipeline**（`src/core/maintenance/dream.ts`）: 加 Stage 7.5 调 `WakeupDiff.run()`
2. **Dream brief**（`buildBrief()`）: 加一行 "Wake-up diff generated"
3. **MCP register**（`src/mcp/register.ts`）: 注册 wakeup tool
4. **Server tool list**（`tests/mcp/server.test.ts`）: 加 `wakeup_diff`

### 不做的事

- 不调 LLM（纯规则）
- 不做独立 cron
- 不做历史趋势分析（后续 issue）
- 不做"过去 N 天变化"查询（后续 issue）
- 不新增 config 表条目（用新表）
- 不改动现有 dream/health 逻辑（只追加 stage 和 brief 行）

## 验证

```bash
bun test tests/core/wakeup.test.ts
bun test tests/mcp/wakeup.test.ts
bun run check
```

关键测试场景：
1. 首次运行（无上次快照）→ 创建 baseline snapshot，报告"已建立基线，暂无变化摘要"，`previousSnapshotId: null`，`baselineCreated: true`，`changes` 为空。不输出全量新增。
2. 无变化 → 输出"无认知变化"
3. 有内容/tier/link 变化 → 正确分类输出
4. 超过 20 行 → 截断 + truncated flag
5. 旧快照清理 → 保留最近 7 份
