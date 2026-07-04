# Atomic reports_to Writes via Compensation (#273) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `setHierarchy` / `removeHierarchy` 提供捕获旧值 → 改 → 失败补偿 → 补偿也失败抛 `RollbackIncompleteError` 的写路径；MCP/CLI 把失败转成匿名 error（不泄露 path/stack），不报 success。

**Architecture:** compensation（非 cross-store tx）—— setHierarchy 顺序不变（frontmatter → graph），失败时 restore frontmatter；removeHierarchy **翻转**为 frontmatter clear → graph supersede，失败时 restore frontmatter。复用 `RollbackIncompleteError`（#233, atomic-move.ts）。graph 层已原子（db tx），失败 = graph 未改，所以只补偿 frontmatter 那半。

**Tech Stack:** TypeScript (strict), Bun, bun:test, CBrainDB (bun:sqlite)。

**Spec:** `docs/superpowers/specs/2026-07-04-hierarchy-atomic-compensation-design.md`

**Crash-consistency 边界**（宏哥明确）：本方案只解决**同步异常失败**（两步之间 throw）。进程在两步之间崩溃（crash mid-flight）仍可能不一致——彻底 crash-safe 需 page 写入 journal/staging/outbox，超 #273 范围。

---

## File Structure

- **Modify** `src/core/graph/hierarchy.ts`：setHierarchy + removeHierarchy compensation（capture old via `getBySlugFresh` + try/catch graph + restore frontmatter + `RollbackIncompleteError`）。
- **Modify** `src/mcp/tools/hierarchy.ts`：import `RollbackIncompleteError` + try/catch `set_hierarchy` / `remove_hierarchy` + 匿名 error helper。
- **Modify** `src/cli/commands/maintenance.ts:930-942, 944-956`：try/catch core 调用 + stderr 匿名 message。
- **Create** `tests/core/hierarchy-rollback.test.ts`：6 fault-injection cases（Acceptance 1-6）。
- **Modify** `tests/mcp/hierarchy.test.ts`：加 set_hierarchy / remove_hierarchy rollback MCP cases（Acceptance 8-9）。
- **不改**：`atomic-move.ts`（只复用 `RollbackIncompleteError`）、`page.ts`、`graph.ts`、`sqlite.ts`、schema、`syncAffectedSlugs`。

---

## Task 1: RED — core rollback fault-injection tests

**Files:**
- Create: `tests/core/hierarchy-rollback.test.ts`

- [ ] **Step 1: 写测试文件（helpers + 6 cases）**

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { GraphManager } from "../../src/core/graph/graph.js";
import { PageManager } from "../../src/core/page.js";
import { Logger } from "../../src/core/logger.js";
import { setHierarchy, removeHierarchy } from "../../src/core/graph/hierarchy.js";
import { RollbackIncompleteError } from "../../src/core/safety/atomic-move.js";

// Anonymous sentinel slugs only.
const SEED = "entities/seed";
const MGR_A = "entities/mgr-a";
const MGR_B = "entities/mgr-b";

describe("hierarchy rollback compensation (#273)", () => {
  const testDir = "/tmp/cbrain-test-hierarchy-rollback";
  const dbPath = join(testDir, "test.sqlite");
  const vaultPath = join(testDir, "vault");
  let db: CBrainDB;
  let graph: GraphManager;
  let pages: PageManager;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
    db = new CBrainDB(dbPath);
    graph = new GraphManager(db);
    const logger = new Logger(vaultPath);
    pages = new PageManager(db, vaultPath, logger, {
      connect: async () => {}, addChunks: async () => {}, search: async () => [],
      fullTextSearch: async () => [], deleteByPageSlug: async () => {}, close: async () => {},
    } as never);
    const seedPage = (slug: string, title: string) => {
      db.upsertPage({ slug, type: "entity/person", title, filePath: `${slug}.md`, contentHash: `h-${slug}` });
      mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(vaultPath, `${slug}.md`), `---\ntitle: "${title}"\ntype: entity/person\nslug: ${slug}\n---\n`);
    };
    seedPage(SEED, "Seed");
    seedPage(MGR_A, "Mgr A");
    seedPage(MGR_B, "Mgr B");
  });
  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  const deps = () => ({ pages, graph });

  const readReportsTo = (slug: string): string | null => {
    const p = pages.getBySlugFresh(slug);
    return (p?.frontmatter.reports_to as string | null) ?? null;
  };

  // Fault injection helper: make pages.update throw on the Nth call (1-indexed).
  function throwOnNthUpdate(n: number): () => void {
    const origUpdate = pages.update.bind(pages);
    let count = 0;
    (pages as unknown as { update: typeof pages.update }).update = (...args: Parameters<typeof pages.update>) => {
      count++;
      if (count === n) throw new Error(`injected pages.update failure #${count}`);
      return origUpdate(...args);
    };
    return () => { (pages as unknown as { update: typeof pages.update }).update = origUpdate; };
  }

  test("setHierarchy: graph throws after frontmatter write → frontmatter restored to old value", () => {
    setHierarchy(SEED, MGR_A, deps()); // establish old reports_to = MGR_A
    (graph as unknown as { setActiveReportsTo: () => void }).setActiveReportsTo = () => {
      throw new Error("injected graph failure");
    };
    expect(() => setHierarchy(SEED, MGR_B, deps())).toThrow();
    expect(readReportsTo(SEED)).toBe(MGR_A); // restored
  });

  test("setHierarchy: no old reports_to + graph throws → frontmatter cleared afterward", () => {
    (graph as unknown as { setActiveReportsTo: () => void }).setActiveReportsTo = () => {
      throw new Error("injected graph failure");
    };
    expect(() => setHierarchy(SEED, MGR_A, deps())).toThrow();
    expect(readReportsTo(SEED)).toBeNull(); // no reports_to key afterward (deleted, not null/empty)
  });

  test("setHierarchy: graph throws + restore throws → RollbackIncompleteError", () => {
    setHierarchy(SEED, MGR_A, deps()); // old = MGR_A
    (graph as unknown as { setActiveReportsTo: () => void }).setActiveReportsTo = () => {
      throw new Error("injected graph failure");
    };
    const restore = throwOnNthUpdate(2); // 1st=frontmatter write, 2nd=restore
    expect(() => setHierarchy(SEED, MGR_B, deps())).toThrow(RollbackIncompleteError);
    restore();
  });

  test("removeHierarchy: frontmatter clear throws → graph current edge remains active", () => {
    setHierarchy(SEED, MGR_A, deps()); // active edge SEED → MGR_A
    const restore = throwOnNthUpdate(1); // 1st update = frontmatter clear
    expect(() => removeHierarchy(SEED, deps())).toThrow();
    restore();
    // graph untouched: active reports_to edge to MGR_A still current
    const links = db.getCurrentReportsToLinks(SEED, "outgoing");
    expect(links.some((l) => l.to_slug === MGR_A)).toBe(true);
  });

  test("removeHierarchy: graph supersede throws after frontmatter clear → frontmatter restored", () => {
    setHierarchy(SEED, MGR_A, deps()); // old = MGR_A
    (graph as unknown as { supersedeReportsTo: () => void }).supersedeReportsTo = () => {
      throw new Error("injected graph supersede failure");
    };
    expect(() => removeHierarchy(SEED, deps())).toThrow();
    expect(readReportsTo(SEED)).toBe(MGR_A); // restored
  });

  test("removeHierarchy: graph supersede throws + restore throws → RollbackIncompleteError", () => {
    setHierarchy(SEED, MGR_A, deps()); // old = MGR_A
    (graph as unknown as { supersedeReportsTo: () => void }).supersedeReportsTo = () => {
      throw new Error("injected graph supersede failure");
    };
    const restore = throwOnNthUpdate(2); // 1st=clear, 2nd=restore
    expect(() => removeHierarchy(SEED, deps())).toThrow(RollbackIncompleteError);
    restore();
  });
});
```

- [ ] **Step 2: 跑 RED，确认全 fail（功能未实现）**

Run: `bun test tests/core/hierarchy-rollback.test.ts`
Expected: 6 fail（当前 setHierarchy/removeHierarchy 无 compensation：要么不 restore、要么不翻顺序、要么不抛 RollbackIncompleteError）。具体：
- test 1: frontmatter 未 restore（还指向 MGR_B）→ `expect(readReportsTo(SEED)).toBe(MGR_A)` fail。
- test 2: frontmatter 还指向 MGR_A（未 clear）→ `.toBeNull()` fail。
- test 3/6: 抛普通 Error 而非 RollbackIncompleteError → `.toThrow(RollbackIncompleteError)` fail。
- test 4: removeHierarchy 当前顺序 graph 先（graph 已 supersede 才 frontmatter clear throw）→ graph 不再 active → `.toBe(true)` fail。
- test 5: removeHierarchy 当前 frontmatter 在 graph 后，graph throw 时 frontmatter 还没 clear（仍 MGR_A）→ `.toBe(MGR_A)` 可能 pass（巧合）——记录实际，GREEN 后锁死。

---

## Task 2: GREEN — hierarchy.ts compensation

**Files:**
- Modify: `src/core/graph/hierarchy.ts`

- [ ] **Step 1: import RollbackIncompleteError + getBySlugFresh**

把 `hierarchy.ts:1-2` 的 import 区改为（加 `RollbackIncompleteError`）：

```typescript
import type { PageManager } from "../page.js";
import type { GraphManager } from "./graph.js";
import { RollbackIncompleteError } from "../safety/atomic-move.js";
```

- [ ] **Step 2: 重写 setHierarchy（capture old + compensation）**

替换 `setHierarchy`（`hierarchy.ts:50-75`）为：

```typescript
/**
 * Set the direct manager (reports_to) for an entity.
 * Writes frontmatter + graph link with compensation (#273): if the graph write
 * fails after frontmatter is written, the old frontmatter value is restored;
 * if restore also fails, throws RollbackIncompleteError. NOT crash-safe
 * (mid-flight process crash can still split the two stores) — only synchronous
 * throw failures are compensated.
 */
export function setHierarchy(
  slug: string,
  reportsToSlug: string,
  deps: HierarchyDeps,
): void {
  const { pages, graph } = deps;

  if (slug === reportsToSlug) {
    throw new Error("不能将自己设为上级");
  }

  const page = pages.getBySlugFresh(slug);
  if (!page) throw new Error(`实体不存在: ${slug}`);

  const manager = pages.getBySlug(reportsToSlug);
  if (!manager) throw new Error(`上级实体不存在: ${reportsToSlug}`);

  // #273: capture old frontmatter value (fresh read) for compensation.
  const oldReportsTo = (page.frontmatter.reports_to as string | null) ?? null;

  // (A) frontmatter write — failure here means graph untouched; throw as-is.
  pages.update(slug, { extra: { reports_to: reportsToSlug } });

  // (B) graph write — on failure, compensate by restoring frontmatter.
  // Phase 1 #233: setActiveReportsTo supersedes stale active edges + upserts
  // the new target as trusted+active in one DB transaction (graph layer atomic).
  try {
    graph.setActiveReportsTo(slug, reportsToSlug, "agent", 0.95, { source_page_slug: slug });
  } catch (graphError) {
    try {
      // oldReportsTo === null → delete key (undefined, NOT null/empty string);
      // else restore old value.
      pages.update(slug, { extra: { reports_to: oldReportsTo ?? undefined } });
    } catch {
      // Anonymous message (slug-only) — no path/stack leak (#273 review).
      throw new RollbackIncompleteError(
        new Error(`reports_to graph write failed for slug=${slug}`),
        new Error(`reports_to frontmatter restore failed for slug=${slug}`),
      );
    }
    throw graphError;
  }
}
```

- [ ] **Step 3: 重写 removeHierarchy（翻转顺序 + compensation）**

替换 `removeHierarchy`（`hierarchy.ts:81-105`）为：

```typescript
/**
 * Remove the reports_to hierarchy for an entity.
 * Returns the old reports_to slug, or null if none was set.
 * #273: flipped order to frontmatter-clear → graph-supersede so a frontmatter
 * failure leaves graph untouched; on graph failure after clear, restores
 * frontmatter. RollbackIncompleteError if restore also fails. NOT crash-safe.
 */
export function removeHierarchy(
  slug: string,
  deps: HierarchyDeps,
): string | null {
  const { pages, graph } = deps;

  const page = pages.getBySlugFresh(slug);
  if (!page) throw new Error(`实体不存在: ${slug}`);

  // #273: capture old value (fresh read) for compensation.
  const oldReportsTo = (page.frontmatter.reports_to as string | null) ?? null;
  if (!oldReportsTo) return null;

  // (A) frontmatter clear — failure here means graph untouched; throw as-is.
  pages.update(slug, {
    body: page.body ?? "",
    extra: { reports_to: undefined },
  });

  // (B) graph supersede — on failure, compensate by restoring frontmatter.
  try {
    graph.supersedeReportsTo(slug);
  } catch (graphError) {
    try {
      pages.update(slug, { extra: { reports_to: oldReportsTo } });
    } catch {
      throw new RollbackIncompleteError(
        new Error(`reports_to graph supersede failed for slug=${slug}`),
        new Error(`reports_to frontmatter restore failed for slug=${slug}`),
      );
    }
    throw graphError;
  }

  return oldReportsTo;
}
```

- [ ] **Step 4: 跑 core rollback + lifecycle happy path**

Run: `bun test tests/core/hierarchy-rollback.test.ts tests/core/hierarchy-lifecycle.test.ts`
Expected: rollback 6 pass + lifecycle 7 pass（happy path 不依赖内部顺序，翻转 removeHierarchy 顺序不破最终态）= 13 pass / 0 fail。

---

## Task 3: MCP catch + 匿名 error + MCP rollback test

**Files:**
- Modify: `src/mcp/tools/hierarchy.ts`
- Modify: `tests/mcp/hierarchy.test.ts`

- [ ] **Step 1: import RollbackIncompleteError + 加匿名 error helper**

在 `src/mcp/tools/hierarchy.ts` 顶部 import 区加：

```typescript
import { RollbackIncompleteError } from "../../core/safety/atomic-move.js";
```

在 `registerHierarchyTools` 函数体之前（或 `exactResolve` 前），加 helper：

```typescript
/** #273: shape a hierarchy write failure into an anonymous MCP error (slug-only, no path/stack). */
function hierarchyErrorResponse(e: unknown, slug: string, op: "set" | "remove") {
  if (e instanceof RollbackIncompleteError) {
    return {
      isError: true as const,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: `reports_to ${op} 失败且回滚未完成，状态可能不一致，需人工核查`,
          rollback_incomplete: true,
          slug,
        }),
      }],
    };
  }
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: `reports_to ${op} 失败，已回滚至原状态`,
        slug,
      }),
    }],
  };
}
```

- [ ] **Step 2: set_hierarchy / remove_hierarchy 包 try/catch**

把 `set_hierarchy` handler 内 `setHierarchy(...)` 调用（`hierarchy.ts:22`）改为：

```typescript
    try {
      setHierarchy(slug, reports_to, { pages: ctx.pages, graph: ctx.graph });
    } catch (e) {
      return hierarchyErrorResponse(e, slug, "set");
    }
```

把 `remove_hierarchy` handler 内 `removeHierarchy(...)` 调用（`hierarchy.ts:68`）改为：

```typescript
    let removed: string | null;
    try {
      removed = removeHierarchy(slug, { pages: ctx.pages, graph: ctx.graph });
    } catch (e) {
      return hierarchyErrorResponse(e, slug, "remove");
    }
    if (!removed) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: `${slug} 未设置 reports_to` }),
        }],
        isError: true,
      };
    }
```

（后续 `syncAffectedSlugs` + success 返回不变。）

- [ ] **Step 3: 加 MCP rollback tests**

在 `tests/mcp/hierarchy.test.ts` 末尾（现有 describe 内或新 describe）加（复用其 `callTool` helper + mock server setup；如该文件 setup 不同，按其模式构造一个 set_hierarchy graph-failure case）：

```typescript
test("#273 set_hierarchy: graph failure → isError + rollback message, no success", async () => {
  // Build server with a graph whose setActiveReportsTo throws.
  // (Adapt to this file's existing createServer/mock pattern — the key assertion
  // is the error shape, not the mock wiring.)
  // ... construct deps with graph.setActiveReportsTo = () => { throw ... } ...
  const result = await callTool("set_hierarchy", { slug: "entities/seed", reports_to: "entities/mgr-a" });
  expect(result.isError).toBe(true);
  const data = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  expect(data.success).toBeUndefined();
  expect(data.slug).toBe("entities/seed");
  // Message is anonymous — no file path / stack leak.
  expect(JSON.stringify(data)).not.toMatch(/\/tmp\/|\/Users\/|\.md/i);
});
```

> 注：MCP test 的 mock server wiring 因 `tests/mcp/hierarchy.test.ts` 现有 setup 而异（它目前只测 `get_org_tree`）。执行时按该文件的 `createServer(deps)` 模式注入一个 throw-on-setActiveReportsTo 的 GraphManager。如果该文件不便注入 fault，最小可行：直接在 unit 级别测 `hierarchyErrorResponse(new RollbackIncompleteError(...), slug, "set")` 的输出形状（匿名 + rollback_incomplete flag + 无 path）。

- [ ] **Step 4: 跑 MCP tests**

Run: `bun test tests/mcp/hierarchy.test.ts`
Expected: 现有 get_org_tree cases + 新 set_hierarchy rollback case 全 pass。

---

## Task 4: CLI catch + 全量 check + commit

**Files:**
- Modify: `src/cli/commands/maintenance.ts:930-942, 944-956`

- [ ] **Step 1: import RollbackIncompleteError + try/catch CLI hierarchy**

在 `maintenance.ts` 顶部 import 区加（如果还没有）：

```typescript
import { RollbackIncompleteError } from "../../core/safety/atomic-move.js";
```

把 set path（`maintenance.ts:944-956` 附近的 `setHierarchy(...)` 调用）包成：

```typescript
    try {
      setHierarchy(slug, opts.reportsTo, { pages, graph });
    } catch (e) {
      if (e instanceof RollbackIncompleteError) {
        console.error(`reports_to 写入失败且回滚未完成，状态可能不一致，需人工核查: ${slug}`);
      } else {
        console.error(`reports_to 写入失败，已回滚至原状态: ${slug}`);
      }
      process.exit(1);
    }
```

把 remove path（`maintenance.ts:930-942` 附近的 `removeHierarchy(...)` 调用）同样包（用 "移除" 措辞）：

```typescript
    let removed: string | null;
    try {
      removed = removeHierarchy(slug, { pages, graph });
    } catch (e) {
      if (e instanceof RollbackIncompleteError) {
        console.error(`reports_to 移除失败且回滚未完成，状态可能不一致，需人工核查: ${slug}`);
      } else {
        console.error(`reports_to 移除失败，已回滚至原状态: ${slug}`);
      }
      process.exit(1);
    }
    if (!removed) {
      console.log(`${slug} 未设置 reports_to`);
      return;
    }
```

（后续 `syncAffectedSlugs` + 成功打印不变。）

- [ ] **Step 2: 跑全量 check**

Run: `bun run check`
Expected: 全量 pass（含 hierarchy-rollback 6 + lifecycle 7 + MCP hierarchy + 现有 page-move fault-injection 等），0 fail。lint（tsc src + biome）过。

- [ ] **Step 3: commit**

```bash
git add src/core/graph/hierarchy.ts src/mcp/tools/hierarchy.ts src/cli/commands/maintenance.ts tests/core/hierarchy-rollback.test.ts tests/mcp/hierarchy.test.ts
git commit -m "fix(hierarchy): compensate reports_to frontmatter/graph dual-write (#273)

setHierarchy captures the old frontmatter reports_to (fresh read) and
restores it if graph.setActiveReportsTo throws. removeHierarchy flips the
order to frontmatter-clear -> graph-supersede so a frontmatter failure
leaves graph untouched, and restores frontmatter on graph failure. Both
throw RollbackIncompleteError (#233 reuse) when restore also fails. NOT
crash-safe (only synchronous throws compensated). MCP set_hierarchy /
remove_hierarchy and cbrain hierarchy CLI catch it into anonymous
slug-only errors (no path/stack leak), never report success on failure.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 4: 确认 commit**

Run: `git log --oneline -1`

---

## Self-Review (执行前已做)

**Spec coverage:**
- Acceptance 1 (set graph fail → restore old) → Task 1 test 1 ✓
- Acceptance 2 (set no-old + graph fail → cleared) → Task 1 test 2 ✓（锁死"删除非 null/空串"——`oldReportsTo ?? undefined` → undefined 删 key）
- Acceptance 3 (set graph fail + restore fail → RollbackIncompleteError) → Task 1 test 3 ✓
- Acceptance 4 (remove frontmatter fail → graph active unchanged) → Task 1 test 4 ✓
- Acceptance 5 (remove graph fail → restore frontmatter) → Task 1 test 5 ✓
- Acceptance 6 (remove graph fail + restore fail → RollbackIncompleteError) → Task 1 test 6 ✓
- Acceptance 7 (happy path 仍过) → Task 2 Step 4 lifecycle ✓
- Acceptance 8/9 (MCP failure → isError) → Task 3 ✓
- Acceptance 10/11 (test/typecheck/lint) → Task 4 Step 2 ✓
- Acceptance 12 对抗审查 → 交付前 workflow（执行后做）
- 宏哥 3 条细节：restore 删 undefined（Task 2 `?? undefined`）✓；RollbackIncompleteError 匿名 message（Task 2 抛时传 slug-only Error）✓；测试覆盖 restore 失败（Task 1 test 3/6）✓

**Placeholder scan:** Task 3 Step 3 MCP test 注了"按现有 setup 适配"——这是因 `tests/mcp/hierarchy.test.ts` 现有 mock 模式未读全。执行时先读该文件 setup 再适配（或 fallback 到 unit 测 `hierarchyErrorResponse` 形状）。其余 step 全含完整代码。

**Type consistency:** `RollbackIncompleteError` 构造器 `(primaryError: Error, rollbackError: Error)`（atomic-move.ts:14）—— Task 2 传 `new Error(\`...slug=${slug}\`)`（Error 类型）✓；`HierarchyDeps { pages, graph }` 不变；`pages.getBySlugFresh` 签名 `(slug) => Page | null`（page.ts:249-252）✓；`hierarchyErrorResponse` 返回 `{ isError, content }` 与 MCP 现有 error shape 一致 ✓。

**风险:** Task 3 Step 3 是唯一带适配不确定性的步骤（MCP test wiring）——执行时读 `tests/mcp/hierarchy.test.ts` 全文确认 mock 注入方式，或退到 `hierarchyErrorResponse` unit 测。
