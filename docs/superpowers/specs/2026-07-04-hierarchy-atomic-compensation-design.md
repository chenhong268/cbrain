# Atomic reports_to Writes via Compensation (#273)

> 状态：设计已确认（基于宏哥 #273 评论 spec + 代码事实），待 writing-plans 拆实现计划
> Issue: #273
> 日期: 2026-07-04

## Context

`setHierarchy()` / `removeHierarchy()` 对 vault frontmatter（Markdown 文件 + DB hash）与 SQLite graph edge（`reports_to` link）做双写，但**不是原子**：

- `setHierarchy` (`src/core/graph/hierarchy.ts:50-75`)：先 `pages.update(slug, { extra: { reports_to } })`（写文件 + DB hash），后 `graph.setActiveReportsTo(...)`。第二步抛错 → frontmatter 已改、graph 未改（或 stale）。
- `removeHierarchy` (`hierarchy.ts:81-105`)：先 `graph.supersedeReportsTo(slug)`，后 `pages.update(..., { extra: { reports_to: undefined } })`。第二步抛错 → graph 已 supersede、frontmatter 还指向旧 manager。

**关键约束**：`PageManager.update` (`page.ts:398-450`) 写 Markdown 文件（`writeFileSync`）再更新 DB `content_hash`——SQLite transaction **覆盖不了文件写**。所以**不能用假的 cross-store transaction**（issue #273 + 宏哥评论明确）。正确做法：**deterministic compensation + 清晰 failure semantics**，复用 #233 的 `RollbackIncompleteError` 模式（`src/core/safety/atomic-move.ts:11-22`，已 re-export `page.ts:27`）。

graph 层已是原子的：`GraphManager.setActiveReportsTo` (`graph.ts:65-76`) 包一个 db transaction（`supersedeReportsTo` + `upsertActiveReportsTo`），全成功或全失败——**graph 失败 = graph 未改**，所以 compensation 只需 restore frontmatter 那一半。

## Goal

`setHierarchy` / `removeHierarchy` 提供捕获旧值 → 改 → 失败补偿 → 补偿也失败抛 `RollbackIncompleteError` 的写路径。MCP/CLI 把 rollback-incomplete 转成明确失败（不报 success），不泄露本地路径 / stack。保留 #233 current-fact 语义（`reports_to` 仍走 `setActiveReportsTo` / `supersedeReportsTo` 的 trusted/active 边）。

## Design

### 方案选择（issue 给了 3 个，宏哥评论选了 compensation）

- ❌ 假 cross-store DB transaction：不可行（文件写不在 tx 内）。
- ❌ 只调顺序不加补偿：仍有窗口期不一致。
- ✅ **compensation**：capture-old → mutate-A → mutate-B → B 失败 restore-A → restore 失败抛 `RollbackIncompleteError`（照搬 `atomic-move.ts` 的 shape，实现放 `hierarchy.ts`）。

### setHierarchy 新流程（顺序不变：frontmatter → graph，加 capture + 补偿）

```
setHierarchy(slug, reportsToSlug, deps):
  validate slug !== reportsToSlug                      # 现状, hierarchy.ts:57-59
  pages.getBySlug(slug) / getBySlug(reportsToSlug)     # 现状存在校验, :61-65
  oldReportsTo = pages.getBySlugFresh(slug).frontmatter.reports_to ?? null   # 新: capture（fresh 避免缓存）

  # (A) frontmatter write — 失败则 graph 未动, 直接 throw 原错误
  pages.update(slug, { extra: { reports_to: reportsToSlug } })

  # (B) graph write — 失败则补偿 frontmatter
  try:
    graph.setActiveReportsTo(slug, reportsToSlug, "agent", 0.95, { source_page_slug: slug })
  except graphError:
    try:
      # restore: oldReportsTo === null → 清除（写 undefined）; 否则写回旧值
      pages.update(slug, { extra: { reports_to: oldReportsTo ?? undefined } })
    except restoreError:
      throw new RollbackIncompleteError(graphError, restoreError)
    throw graphError   # 补偿成功, 仍抛原 graph 错误（MCP/CLI 报失败）
```

成功态：frontmatter → reportsToSlug，graph 有唯一 active `reports_to` 边 → reportsToSlug，stale prior 边被 supersede（`setActiveReportsTo` 内部 supersede+upsert）。

### removeHierarchy 新流程（**翻转顺序**：frontmatter clear → graph supersede）

理由（宏哥评论）：避免"graph superseded 但 frontmatter 还指向旧 manager"。frontmatter clear 先 → 失败则 graph 未动（安全）；graph supersede 后失败 → restore frontmatter。

```
removeHierarchy(slug, deps):
  page = pages.getBySlug(slug)                         # 现状, :87-88
  oldReportsTo = pages.getBySlugFresh(slug).frontmatter.reports_to ?? null  # fresh capture
  if oldReportsTo === null: return null                # 现状 early-return, :91

  # (A) frontmatter clear — 失败则 graph 未动, 直接 throw
  pages.update(slug, { extra: { reports_to: undefined } })

  # (B) graph supersede — 失败则补偿 frontmatter
  try:
    graph.supersedeReportsTo(slug)
  except graphError:
    try:
      pages.update(slug, { extra: { reports_to: oldReportsTo } })   # 写回旧值
    except restoreError:
      throw new RollbackIncompleteError(graphError, restoreError)
    throw graphError

  return oldReportsTo
```

成功态：frontmatter 无 `reports_to`，graph 无 active `reports_to` 边（旧边 superseded，证据保留）。

### MCP / CLI 错误传播（catch RollbackIncompleteError）

- **MCP** `src/mcp/tools/hierarchy.ts`：`set_hierarchy` (`:22`) / `remove_hierarchy` (`:68`) 包 try/catch。
  - catch `RollbackIncompleteError` → `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "reports_to 写入失败且回滚未完成，状态可能不一致，需人工核查", rollback_incomplete: true, slug }) }] }`。
  - catch 普通 error → `{ isError: true, content: [{ text: JSON.stringify({ error: message, slug }) }] }`。
  - **不泄露** file_path / stack / 内部路径。
- **CLI** `src/cli/commands/maintenance.ts:932, 948`：try/catch 包 core 调用。`RollbackIncompleteError` → stderr "rollback incomplete — manual repair required: <slug>"，`process.exit(1)`。普通 error → stderr message + exit 1。

### 不变项

- 现有 public 函数名 + return shape（`setHierarchy` void/throw、`removeHierarchy` string|null）不变。
- `setActiveReportsTo` / `supersedeReportsTo` 调用参数 + provenance 不变（#233 current-fact 语义保留）。
- 不改 schema、不加 background job、不动 Known Relations rewrite、不改 `syncAffectedSlugs()`。

## Non-goals

- 不做真的 cross-store transaction（不可能）。
- 不改 PageManager.update 内部原子性（那是另一个 issue；#273 范围是 hierarchy 层 cross-store）。
- 不加 cycle detection on set（现状 read-time warn，#273 不动）。
- 不重构 graph/page 内部。
- 无私密 fixture（测试用 `entity/a` / `entity/b` / `person/甲` 等匿名 slug）。

## Acceptance Criteria（宏哥评论）

Core (`tests/core/hierarchy*.test.ts`):

1. `setHierarchy`: frontmatter 写成功 + graph 写 throw → frontmatter restored 旧 `reports_to`；不返回 success。
2. `setHierarchy`: 无旧 `reports_to` + graph throw → frontmatter 事后无 `reports_to`。
3. `setHierarchy`: graph throw + restore 也 throw → `RollbackIncompleteError`。
4. `removeHierarchy`: frontmatter clear throw → graph current edge 保持 active（未动）。
5. `removeHierarchy`: frontmatter clear 后 graph supersede throw → 旧 frontmatter restored。
6. `removeHierarchy`: graph supersede throw + restore throw → `RollbackIncompleteError`。
7. happy path 仍过（`hierarchy-lifecycle.test.ts` 现有 7 case）。

MCP (`tests/mcp/hierarchy.test.ts`):

8. `set_hierarchy` graph failure → `isError: true` + error JSON，不报 success。
9. `remove_hierarchy` graph failure → failure + 最终状态一致。

Final:
10. `bun test tests/core/hierarchy*.test.ts tests/mcp/hierarchy.test.ts` 过。
11. `bun run typecheck && bun run lint` 过。
12. **对抗审查**：error text 无 path/slug 隐私泄露；无 candidate `reports_to` 被当 current fact 重新引入；无 hierarchy 写路径之外的 broad refactor。

## Test Plan

模板：`tests/core/hierarchy-lifecycle.test.ts`（real `CBrainDB` + real `GraphManager` + real `PageManager` + stub LanceDB，匿名 slug）。新增 `tests/core/hierarchy-rollback.test.ts`（或扩展 lifecycle 文件）+ 扩展 `tests/mcp/hierarchy.test.ts`。

**Fault-injection seam**（照搬 `tests/core/page-move.test.ts:915-988` 模式）：

- **graph throw**：monkeypatch 实例方法 `graph.setActiveReportsTo = () => { throw new Error("injected graph failure"); }`（同理 `graph.supersedeReportsTo`）。`HierarchyDeps` 收 `GraphManager` 实例（`hierarchy.ts:4-7`），一行 monkeypatch。
- **restore throw**（补偿也失败）：让 `pm.update` 第 2 次调 throw —— counter + monkeypatch `pm.update`，或 monkeypatch `db.updatePageHash`（`page.ts:434` 是 update 内部第 5 步，文件已写、hash 更新失败模拟"frontmatter 写失败"）。

Cases 覆盖 Acceptance 1-9。匿名 fixture：`entity/a`、`entity/b`（seed pages + 1-2 个 `reports_to` 边）。

## Files

- Modify `src/core/graph/hierarchy.ts`（setHierarchy + removeHierarchy compensation）。
- Modify `src/mcp/tools/hierarchy.ts`（try/catch + error shape）。
- Modify `src/cli/commands/maintenance.ts:932, 948`（try/catch + stderr）。
- Create `tests/core/hierarchy-rollback.test.ts`（or extend lifecycle）+ extend `tests/mcp/hierarchy.test.ts`。
- 不改：`atomic-move.ts`（只复用 `RollbackIncompleteError`）、`page.ts`、`graph.ts`、`sqlite.ts`、schema。

## Risks / 对抗审查关注

- **restore 语义**：`pages.update` restore 调用本身也可能失败（磁盘满 / 权限）→ 必须落到 `RollbackIncompleteError`（不能静默）。测试 #3/#6 锁死。
- **顺序翻转回归**：removeHierarchy 改 frontmatter → graph。现有 lifecycle test `:74-86`（remove supersedes）、`:88-91`（remove-no-op）、`:93-102`（traversal excludes superseded）必须仍过——它们验证最终态，不依赖内部顺序，应不受影响，但要跑。
- **隐私**：error message 只用 slug（`entity/a`），不用 `file_path` / 绝对路径 / stack。对抗审查 grep `error text` 无 `/tmp` / `/Users` / 真名。
- **current-fact**：补偿不能把 candidate `reports_to` 当 current 重新引入。restore 用 `pages.update`（frontmatter）+ graph 失败=未改，不动 graph current edge。`setActiveReportsTo` / `supersedeReportsTo` 内部 trusted/active 语义不变。
- **broad refactor**：只动 hierarchy 写路径 + 错误传播。不顺势改 page.ts / graph.ts 内部。
