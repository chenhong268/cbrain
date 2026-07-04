# gate:consistency Release Guard (#279) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bun run gate:consistency` 单命令跑 storage consistency invariants（hard no-go vs warning），把 fsck + repair-plan 接进 release/每日巡检门禁。

**Architecture:** 加一个 fsck probe（hierarchy split-brain，layer="sqlite"）+ 一个纯 gate function（消费 FsckReport，hard/warning 分类，解释 lanceState）+ bin/ wrapper（import src，跑 fsck+repair-plan+gate，输出 JSON/markdown）+ package.json script + 接入 v2-preflight。前置修复 repair-plan.ts Lance 错 key。

**Tech Stack:** TypeScript (strict), Bun, bun:test, zod, CBrainDB (bun:sqlite)。

**Spec:** `docs/superpowers/specs/2026-07-04-gate-consistency-design.md`

**bin/ wrapper 设计决策**：spec 写"shell 源码 CLI"，实现改为 **import src 函数**（loadConfig + CBrainDB + runFsck + buildRepairPlan + evaluateConsistencyGate）。原因：(1) hasChunks（lanceState="missing" + 有 chunks → hard）要查 db，shell fsck 不含；(2) import 也是源码入口，不依赖 PATH installed cbrain，符合宏哥 spec 核心诉求；(3) 少一层子进程，更快。human 输出仍显示等价 `cbrain fsck --json` 命令。

---

## File Structure

- **Modify** `src/core/fsck/repair-plan.ts:79`（错 key `lance.coverage_gap` → `lance.vector_coverage_gap`，前置修复）。
- **Create** `src/core/fsck/hierarchy-probe.ts`（新 probe，`layer:"sqlite"`，复用 health.ts:868-914 逻辑）。
- **Modify** `src/cli/commands/fsck.ts:40`（runFsck sqlite branch 注册 probeHierarchy）。
- **Create** `src/core/fsck/consistency-gate.ts`（纯 gate function）。
- **Create** `bin/check-consistency-gate.ts`（wrapper，import src，输出 JSON）。
- **Modify** `package.json`（加 `gate:consistency`）。
- **Modify** `bin/check-v2-preflight.ts:57-100`（DEFAULT_PREFLIGHT_CHECKS 加 consistency）。
- **Create** `tests/core/fsck/hierarchy-probe.test.ts` + `tests/core/fsck/consistency-gate.test.ts` + `tests/cli/gate-consistency.test.ts`。
- **Modify** `tests/core/fsck/repair-plan.test.ts`（加 lance.vector_coverage_gap case）。
- **Modify** `docs/developer-reference.md`（gate:consistency 文档）。

---

## Task 1: 修 repair-plan.ts Lance 错 key（前置修复，TDD）

**Files:**
- Modify: `tests/core/fsck/repair-plan.test.ts`
- Modify: `src/core/fsck/repair-plan.ts:79`

- [ ] **Step 1: 写 RED test（验证 lance.vector_coverage_gap 经 rule 分类为 auto_repairable）**

在 `tests/core/fsck/repair-plan.test.ts` 末尾（最后一个 `});` 前）加：

```typescript
test("#279 lance.vector_coverage_gap is classified auto_repairable (rule key match)", () => {
  const report: FsckReport = {
    version: 1,
    timestamp: new Date().toISOString(),
    overallStatus: "warn",
    counts: { critical: 0, error: 1, warning: 0, info: 0 },
    lanceState: "ok",
    findings: [
      {
        check: "lance.vector_coverage_gap",
        layer: "lance",
        severity: "error",
        count: 3,
        sampleSlugs: ["item_1"],
        detail: "pages 有 chunks 但 LanceDB 无向量",
        suggestedCommand: "cbrain sync --reindex-vectors",
      },
    ],
  };
  const plan = buildRepairPlan(report);
  const item = plan.items.find((i) => i.check === "lance.vector_coverage_gap");
  expect(item).toBeDefined();
  expect(item!.bucket).toBe("auto_repairable");
});
```

> 如果文件顶部没 import `FsckReport` / `buildRepairPlan`，照现有 case 的 import 补（`import { buildRepairPlan } from "../../../src/core/fsck/repair-plan.js"; import type { FsckReport } from "../../../src/core/fsck/types.js";`）。

- [ ] **Step 2: 跑 RED**

Run: `bun test tests/core/fsck/repair-plan.test.ts`
Expected: 新 case FAIL——当前 `RULES["lance.coverage_gap"]`（错 key，repair-plan.ts:79）不匹配 `lance.vector_coverage_gap`，finding 走 `DEFAULT_RULE`（`needs_review`）。`expect(item!.bucket).toBe("auto_repairable")` fail（收到 `needs_review`）。

- [ ] **Step 3: 修 repair-plan.ts:79 错 key**

把 `src/core/fsck/repair-plan.ts:79` 的 RULES key 从 `"lance.coverage_gap"` 改为 `"lance.vector_coverage_gap"`：

```typescript
	"lance.vector_coverage_gap": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "stop active writers before rebuilding vectors",
		dryRunSummary: "Rebuild missing vectors from SQLite chunks after writer shutdown.",
		verifyCommand: "cbrain fsck --json --layer lance",
	},
```

- [ ] **Step 4: 跑 GREEN**

Run: `bun test tests/core/fsck/repair-plan.test.ts`
Expected: 全 pass（含新 case）。

- [ ] **Step 5: commit**

```bash
git add tests/core/fsck/repair-plan.test.ts src/core/fsck/repair-plan.ts
git commit -m "fix(fsck): repair-plan lance rule key coverage_gap -> vector_coverage_gap (#279)"
```

---

## Task 2: 加 hierarchy fsck probe（TDD）

**Files:**
- Create: `tests/core/fsck/hierarchy-probe.test.ts`
- Create: `src/core/fsck/hierarchy-probe.ts`
- Modify: `src/cli/commands/fsck.ts:40`（runFsck 注册）

- [ ] **Step 1: 写 RED test**

`tests/core/fsck/hierarchy-probe.test.ts`（mirror sqlite-probe.test.ts 的 real-DB + vault fixture 模式）：

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBrainDB } from "../../../src/storage/sqlite.js";
import { probeHierarchy } from "../../../src/core/fsck/hierarchy-probe.js";

// Anonymous sentinel slugs only.
const SEED = "entities/seed";
const MGR = "entities/mgr";

describe("probeHierarchy (#279 split-brain)", () => {
	const testDir = "/tmp/cbrain-test-hierarchy-probe";
	const dbPath = join(testDir, "test.sqlite");
	const vaultPath = join(testDir, "vault");
	let db: CBrainDB;

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(vaultPath, { recursive: true });
		db = new CBrainDB(dbPath);
	});
	afterEach(() => {
		db.close();
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	const seedPageWithReportsTo = (slug: string, reportsTo: string) => {
		db.upsertPage({ slug, type: "entity/person", title: slug, filePath: `${slug}.md`, contentHash: `h-${slug}` });
		mkdirSync(join(vaultPath, ...slug.split("/").slice(0, -1)), { recursive: true });
		writeFileSync(join(vaultPath, `${slug}.md`), `---\ntitle: "${slug}"\ntype: entity/person\nslug: ${slug}\nreports_to: ${reportsTo}\n---\n`);
	};

	test("frontmatter reports_to + no graph edge → mismatch finding (layer=sqlite)", () => {
		seedPageWithReportsTo(SEED, MGR);
		// MGR page 不需要存在；关键是 SEED frontmatter 有 reports_to 但 links 表无 active edge
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(1);
		expect(findings[0].check).toBe("hierarchy.frontmatter_graph_mismatch");
		expect(findings[0].layer).toBe("sqlite");
		expect(findings[0].severity).toBe("error");
		expect(findings[0].count).toBe(1);
		expect(findings[0].sampleSlugs).not.toContain(SEED); // anonymized
	});

	test("frontmatter reports_to + active graph edge → no finding", () => {
		seedPageWithReportsTo(SEED, MGR);
		db.upsertActiveReportsTo(SEED, MGR, "agent", 0.95); // current/active edge
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(0);
	});

	test("superseded edge (non-current) → still mismatch finding (#233 current-fact)", () => {
		seedPageWithReportsTo(SEED, MGR);
		db.upsertActiveReportsTo(SEED, MGR, "agent", 0.95);
		db.supersedeReportsTo(SEED); // edge becomes superseded — no longer current
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(1); // superseded 不算 current → mismatch
	});

	test("no reports_to frontmatter → no finding", () => {
		db.upsertPage({ slug: SEED, type: "entity/person", title: SEED, filePath: `${SEED}.md`, contentHash: `h-${SEED}` });
		mkdirSync(join(vaultPath, ...SEED.split("/").slice(0, -1)), { recursive: true });
		writeFileSync(join(vaultPath, `${SEED}.md`), `---\ntitle: "${SEED}"\ntype: entity/person\nslug: ${SEED}\n---\n`);
		const findings = probeHierarchy(vaultPath, db);
		expect(findings).toHaveLength(0);
	});
});
```

- [ ] **Step 2: 跑 RED**

Run: `bun test tests/core/fsck/hierarchy-probe.test.ts`
Expected: FAIL（`probeHierarchy` 不存在 / 未 import）。

- [ ] **Step 3: 实现 probeHierarchy**

`src/core/fsck/hierarchy-probe.ts`：

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding } from "./types.js";
import { anonymizeSlugs } from "./report.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";

/**
 * #279 hierarchy split-brain probe: pages whose `reports_to` frontmatter has no
 * matching current/active graph edge. Reuses the health.ts:899-914 SQL
 * (#233 current-fact semantics — superseded/rejected/candidate edges do NOT
 * satisfy the frontmatter's current reports_to). layer="sqlite" because the
 * finding queries the `links` table + page frontmatter consistency; the
 * FsckLayerSchema has no `graph` value.
 */
export function probeHierarchy(vaultPath: string, db: CBrainDB): FsckFinding[] {
	const findings: FsckFinding[] = [];
	const pages = db.listPages({ limit: 10000, offset: 0 });
	const mismatched: string[] = [];

	for (const page of pages) {
		if (!page.file_path) continue;
		const filePath = join(vaultPath, page.file_path);
		if (!existsSync(filePath)) continue;

		let reportsTo: string | null = null;
		try {
			const raw = readFileSync(filePath, "utf-8");
			const parsed = parseFrontmatter(raw);
			const fm = parsed.frontmatter as Record<string, unknown>;
			const rt = fm.reports_to;
			reportsTo = typeof rt === "string" && rt ? rt : null;
		} catch {
			continue;
		}
		if (!reportsTo) continue;

		const hasEdge = db.rawDb
			.prepare(
				"SELECT 1 FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to' AND (trust_state IS NULL OR trust_state IN ('trusted','user_thought')) LIMIT 1",
			)
			.get(page.slug, reportsTo);

		if (!hasEdge) mismatched.push(page.slug);
	}

	if (mismatched.length > 0) {
		findings.push({
			check: "hierarchy.frontmatter_graph_mismatch",
			layer: "sqlite",
			severity: "error",
			count: mismatched.length,
			sampleSlugs: anonymizeSlugs(mismatched),
			detail:
				"page 的 reports_to frontmatter 缺少对应 current graph edge（#233 current-fact 语义；#273 compensation 已保证新写不产生，历史残留需人工）",
			suggestedCommand: "cbrain hierarchy <slug>",
		});
	}
	return findings;
}
```

- [ ] **Step 4: 注册到 runFsck（fsck.ts:40 sqlite branch）**

在 `src/cli/commands/fsck.ts` 顶部 import 区（line 7-10 附近）加：

```typescript
import { probeHierarchy } from "../../core/fsck/hierarchy-probe.js";
```

把 `fsck.ts:40` 的 sqlite branch：
```typescript
		if (layers.includes("sqlite")) findings.push(...probeSqlite(input.db));
```
改为：
```typescript
		if (layers.includes("sqlite")) {
			findings.push(...probeSqlite(input.db));
			findings.push(...probeHierarchy(input.vaultPath, input.db));
		}
```

- [ ] **Step 5: 跑 GREEN**

Run: `bun test tests/core/fsck/hierarchy-probe.test.ts`
Expected: 4 pass。

Run: `bun test tests/core/fsck/`（全 fsck tests）
Expected: 全 pass（新 probe 不破现有）。

- [ ] **Step 6: commit**

```bash
git add tests/core/fsck/hierarchy-probe.test.ts src/core/fsck/hierarchy-probe.ts src/cli/commands/fsck.ts
git commit -m "feat(fsck): hierarchy split-brain probe (layer=sqlite) (#279)"
```

---

## Task 3: 加 consistency-gate 纯函数（TDD）

**Files:**
- Create: `tests/core/fsck/consistency-gate.test.ts`
- Create: `src/core/fsck/consistency-gate.ts`

- [ ] **Step 1: 写 RED test**

`tests/core/fsck/consistency-gate.test.ts`（直接调 function，fixture FsckReport，不 spawn 子进程）：

```typescript
import { describe, test, expect } from "bun:test";
import { evaluateConsistencyGate } from "../../../src/core/fsck/consistency-gate.js";
import type { FsckReport } from "../../../src/core/fsck/types.js";

const baseReport = (overrides: Partial<FsckReport> = {}): FsckReport => ({
	version: 1,
	timestamp: "2026-07-04T00:00:00.000Z",
	overallStatus: "pass",
	counts: { critical: 0, error: 0, warning: 0, info: 0 },
	lanceState: "ok",
	findings: [],
	...overrides,
});

const finding = (check: string, layer: string, severity: "error" | "warning" | "info" = "error") => ({
	check,
	layer,
	severity,
	count: 1,
	sampleSlugs: ["item_1"],
	detail: "test",
	suggestedCommand: "cbrain test",
});

describe("evaluateConsistencyGate (#279)", () => {
	test("clean report → passed:true", () => {
		const r = evaluateConsistencyGate(baseReport(), false);
		expect(r.passed).toBe(true);
		expect(r.hard).toHaveLength(0);
	});

	test("sqlite.page_without_chunks → hard, passed:false", () => {
		const r = evaluateConsistencyGate(baseReport({ findings: [finding("sqlite.page_without_chunks", "sqlite")] }), true);
		expect(r.passed).toBe(false);
		expect(r.hard[0].check).toBe("sqlite.page_without_chunks");
	});

	test("fts.stale_rows / fts.coverage_gap / hierarchy.frontmatter_graph_mismatch / lance.vector_coverage_gap → hard", () => {
		for (const check of ["fts.stale_rows", "fts.coverage_gap", "hierarchy.frontmatter_graph_mismatch", "lance.vector_coverage_gap"]) {
			const r = evaluateConsistencyGate(baseReport({ findings: [finding(check, "sqlite")] }), true);
			expect(r.passed).toBe(false);
			expect(r.hard[0].check).toBe(check);
		}
	});

	test("sqlite.orphan_chunks (dangling FK) → hard", () => {
		const r = evaluateConsistencyGate(baseReport({ findings: [finding("sqlite.orphan_chunks", "sqlite")] }), true);
		expect(r.passed).toBe(false);
	});

	test("lanceState corrupt → hard even with no findings", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "corrupt" }), true);
		expect(r.passed).toBe(false);
		expect(r.lanceState).toBe("corrupt");
	});

	test("lanceState missing + hasChunks → hard", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "missing" }), true);
		expect(r.passed).toBe(false);
	});

	test("lanceState missing + empty DB (no chunks) → warning, passed:true", () => {
		const r = evaluateConsistencyGate(baseReport({ lanceState: "missing" }), false);
		expect(r.passed).toBe(true);
		expect(r.warnings.length).toBeGreaterThan(0);
	});

	test("sqlite.title_collision → warning, passed:true", () => {
		const r = evaluateConsistencyGate(baseReport({ findings: [finding("sqlite.title_collision", "sqlite", "warning")] }), true);
		expect(r.passed).toBe(true);
		expect(r.warnings[0].check).toBe("sqlite.title_collision");
	});

	test("fatalError → passed:false", () => {
		const r = evaluateConsistencyGate(baseReport({ fatalError: "fsck probe failed: boom" }), true);
		expect(r.passed).toBe(false);
	});
});
```

- [ ] **Step 2: 跑 RED**

Run: `bun test tests/core/fsck/consistency-gate.test.ts`
Expected: FAIL（`evaluateConsistencyGate` 不存在）。

- [ ] **Step 3: 实现 evaluateConsistencyGate**

`src/core/fsck/consistency-gate.ts`：

```typescript
import type { FsckLanceState, FsckReport } from "./types.js";
import type { RepairPlanStatus } from "./repair-plan.js";

export interface GateFinding {
	check: string;
	layer: string;
	count: number;
	samples: string[];
}

export interface ConsistencyGateResult {
	passed: boolean;
	hard: GateFinding[];
	warnings: GateFinding[];
	lanceState: FsckLanceState;
	repairPlanStatus: RepairPlanStatus | null;
	nextAction: string;
}

/**
 * Hard no-go checks (gate fail). Independent of fsck severity — fsck marks
 * page_without_chunks etc. as `warning` (diagnostic), but the release gate
 * treats them as release-blocking (physical inconsistency).
 */
const HARD_CHECKS = new Set<string>([
	"sqlite.page_without_chunks",
	"fts.stale_rows",
	"fts.coverage_gap",
	"hierarchy.frontmatter_graph_mismatch",
	"lance.vector_coverage_gap",
	"vault.file_exists_db_missing",
	"vault.db_exists_file_missing",
	"vault.frontmatter_slug_mismatch",
]);

function isHard(check: string): boolean {
	return HARD_CHECKS.has(check) || check.startsWith("sqlite.orphan_");
}

/**
 * Evaluate a fsck report into a go/no-go gate result. Pure function — no DB,
 * no shell. `hasChunks` is required because probeLance emits no finding when
 * LanceDB is missing/corrupt (only sets lanceState); the gate must decide
 * whether `missing` is hard (DB has chunks → recall lost) or warning (empty
 * DB → nothing to index).
 */
export function evaluateConsistencyGate(
	report: FsckReport,
	hasChunks: boolean,
	repairPlanStatus?: RepairPlanStatus,
): ConsistencyGateResult {
	const hard: GateFinding[] = [];
	const warnings: GateFinding[] = [];

	for (const f of report.findings) {
		const item: GateFinding = { check: f.check, layer: f.layer, count: f.count, samples: f.sampleSlugs };
		if (isHard(f.check)) hard.push(item);
		else warnings.push(item);
	}

	// LanceDB lanceState — probeLance may emit NO finding on missing/corrupt;
	// gate must interpret lanceState independently.
	let lanceHard = false;
	if (report.lanceState === "corrupt") lanceHard = true;
	if (report.lanceState === "missing" && hasChunks) lanceHard = true;
	if (report.lanceState === "missing" && !hasChunks) {
		warnings.push({ check: "lance.missing_empty_db", layer: "lance", count: 0, samples: [] });
	}

	const fatalError = report.fatalError;
	const passed = !fatalError && hard.length === 0 && !lanceHard;

	let nextAction: string;
	if (fatalError) nextAction = `fsck fatal: ${fatalError}`;
	else if (!passed) nextAction = "Fix hard no-go failures (see hard[]), then rerun `bun run gate:consistency`.";
	else if (warnings.length > 0) nextAction = "Optional: review warnings[].";
	else nextAction = "All consistency checks passed.";

	return {
		passed,
		hard,
		warnings,
		lanceState: report.lanceState,
		repairPlanStatus: repairPlanStatus ?? null,
		nextAction,
	};
}
```

- [ ] **Step 4: 跑 GREEN**

Run: `bun test tests/core/fsck/consistency-gate.test.ts`
Expected: 9 pass。

- [ ] **Step 5: commit**

```bash
git add tests/core/fsck/consistency-gate.test.ts src/core/fsck/consistency-gate.ts
git commit -m "feat(fsck): consistency-gate pure function (hard/warning + lanceState) (#279)"
```

---

## Task 4: bin wrapper + package script

**Files:**
- Create: `bin/check-consistency-gate.ts`
- Modify: `package.json`

- [ ] **Step 1: 实现 bin/check-consistency-gate.ts**

```typescript
#!/usr/bin/env bun
// check-consistency-gate.ts — storage consistency release gate (#279)
//
// Imports src functions (no shell, no PATH cbrain dependency). Runs fsck +
// repair-plan + consistency-gate, emits one stable JSON report, exits 0/1.

import { existsSync } from "node:fs";
import { loadConfig } from "../src/cli/context.js";
import { CBrainDB } from "../src/storage/sqlite.js";
import { runFsck } from "../src/cli/commands/fsck.js";
import { buildRepairPlan } from "../src/core/fsck/repair-plan.js";
import { evaluateConsistencyGate } from "../src/core/fsck/consistency-gate.js";

interface ConsistencyGateReport {
	gate: "consistency";
	version: string;
	timestamp: string;
	passed: boolean;
	hard: ReturnType<typeof evaluateConsistencyGate>["hard"];
	warnings: ReturnType<typeof evaluateConsistencyGate>["warnings"];
	lanceState: string;
	repairPlanStatus: string | null;
	fatalError: string | undefined;
	next_action: string;
	duration_ms: number;
}

async function main(): Promise<void> {
	const started = performance.now();
	const config = loadConfig();

	if (!existsSync(config.dbPath)) {
		const report: ConsistencyGateReport = {
			gate: "consistency",
			version: "1",
			timestamp: new Date().toISOString(),
			passed: false,
			hard: [],
			warnings: [],
			lanceState: "unchecked",
			repairPlanStatus: null,
			fatalError: `DB file not found at ${config.dbPath}`,
			next_action: "Initialize the vault/DB before running the consistency gate.",
			duration_ms: Math.round(performance.now() - started),
		};
		console.log(JSON.stringify(report, null, 2));
		process.exit(2);
	}

	const db = new CBrainDB(config.dbPath, { skipMigrate: true });
	try {
		const { report: fsckReport } = await runFsck({
			vaultPath: config.vaultPath,
			lancePath: config.lancePath,
			db,
		});
		const plan = buildRepairPlan(fsckReport);
		const hasChunks = !!db.rawDb.prepare("SELECT 1 FROM chunks LIMIT 1").get();
		const result = evaluateConsistencyGate(fsckReport, hasChunks, plan.overallStatus);

		const gateReport: ConsistencyGateReport = {
			gate: "consistency",
			version: "1",
			timestamp: new Date().toISOString(),
			passed: result.passed,
			hard: result.hard,
			warnings: result.warnings,
			lanceState: result.lanceState,
			repairPlanStatus: result.repairPlanStatus,
			fatalError: fsckReport.fatalError,
			next_action: result.nextAction,
			duration_ms: Math.round(performance.now() - started),
		};
		console.log(JSON.stringify(gateReport, null, 2));
		process.exit(result.passed ? 0 : 1);
	} finally {
		db.close();
	}
}

await main();
```

- [ ] **Step 2: package.json 加 gate:consistency**

把 `package.json:34` 的 `"check:docs": "bun bin/check-docs-consistency.ts"` 行后（`scripts` 内）加：

```json
    "gate:consistency": "bun bin/check-consistency-gate.ts",
```

- [ ] **Step 3: 跑 bin/（手测 smoke）**

Run: `bun run gate:consistency`
Expected: 输出 JSON `{gate:"consistency", passed:true|false, ...}`，exit 0（clean）或 1（有 hard finding）。本仓库当前 fsck 状态决定 passed。

- [ ] **Step 4: 写 bin/ 端到端 test**

`tests/cli/gate-consistency.test.ts`（spawn 子进程跑 bin/ with fixture env；如 fixture env 难注入，fallback 到只测 `evaluateConsistencyGate` function 已在 Task 3 覆盖，此处只 smoke 测 bin/ 能加载 + 输出 JSON shape）：

```typescript
import { describe, test, expect } from "bun:test";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("bin/check-consistency-gate.ts (#279 smoke)", () => {
	// Smoke: bin/ loads, imports resolve, outputs JSON with gate:"consistency".
	// Full e2e (fixture DB) is heavy; the gate function logic is covered in
	// consistency-gate.test.ts. Here we only confirm the script is wired.
	test.todo("e2e with fixture DB — covered by consistency-gate.test.ts function tests");
});
```

> 如果要真 e2e：在 beforeEach 用 fixture vault+DB env（`CBRAIN_CONFIG_PATH` 或临时 config）spawn `bun bin/check-consistency-gate.ts`，assert exit + JSON `passed`。但 gate function 已纯测覆盖，e2e 边际价值低，plan 用 todo 占位（执行时按需补）。

- [ ] **Step 5: commit**

```bash
git add bin/check-consistency-gate.ts package.json tests/cli/gate-consistency.test.ts
git commit -m "feat(gate): gate:consistency bin wrapper + package script (#279)"
```

---

## Task 5: 接入 v2-preflight

**Files:**
- Modify: `bin/check-v2-preflight.ts:57-100`

- [ ] **Step 1: DEFAULT_PREFLIGHT_CHECKS 加 consistency**

在 `bin/check-v2-preflight.ts` 的 `DEFAULT_PREFLIGHT_CHECKS` 数组末尾（line 100 的 `];` 前，resolver-pilot 后）加：

```typescript
  {
    id: "storage-consistency",
    label: "Storage consistency gate (fsck + repair-plan)",
    command: ["bun", "run", "gate:consistency"],
    required: true,
    timeoutMs: 180_000,
  },
```

- [ ] **Step 2: 跑 preflight 确认 sub-gate 注册**

Run: `bun bin/check-v2-preflight.ts 2>&1 | grep -c storage-consistency || true`
Expected: ≥1（sub-gate 在 checks list）。或读 `bin/check-v2-preflight.ts` 确认 DEFAULT_PREFLIGHT_CHECKS 含 consistency。

> 注意：完整 v2-preflight 跑全 sub-gates（offline/rc/hermes/perf 慢）。验证 consistency 注册用 grep / 读代码，不跑全 preflight。

- [ ] **Step 3: commit**

```bash
git add bin/check-v2-preflight.ts
git commit -m "feat(gate): wire gate:consistency into v2-preflight (#279)"
```

---

## Task 6: sync skip regression + docs + 对抗审查 + 全量 check

**Files:**
- Modify: `tests/core/maintenance/sync.test.ts`（或新 gate test）
- Modify: `docs/developer-reference.md`

- [ ] **Step 1: sync skip regression test（锁死 #274 hasCompletePageIndexes）**

在 `tests/core/maintenance/sync.test.ts`（如存在；否则在最近 sync test 文件）加 case，或在 `tests/core/fsck/consistency-gate.test.ts` 加一个 sync 行为 test。匿名 fixture：

```typescript
test("#279 sync skip regression: hash-match + missing chunks → does NOT skip (rebuilds)", async () => {
	// Seed page with matching content_hash but NO chunks → sync must rebuild.
	// (#274 hasCompletePageIndexes behavior — gate depends on this not regressing.)
	// ... mirror existing sync.test.ts fixture pattern: seed page + file,
	// delete chunks, run syncPage, assert chunks rebuilt ...
});
```

> 执行时读 `tests/core/maintenance/sync.test.ts` 现有 fixture 模式（hash-match + chunks）补全。关键断言：`syncPage` 后 `db.rawDb.prepare("SELECT COUNT(*) FROM chunks WHERE page_slug=?").get()` > 0。

- [ ] **Step 2: 文档**

在 `docs/developer-reference.md`（或 README release 段）加 gate:consistency 说明：

```markdown
### gate:consistency — storage consistency release gate

`bun run gate:consistency` runs fsck + repair-plan and classifies findings into
hard no-go (gate fails, exit 1) vs warning (gate passes). Hard: missing chunks,
stale FTS rows, FTS coverage gaps, hierarchy split-brain, dangling FK rows,
LanceDB corrupt/missing-with-chunks. Warning: title collisions, quarantine
context, empty-DB LanceDB missing. The gate interprets `lanceState` independently
of findings (probeLance may emit no finding on missing/corrupt). Wired into
`gate:v2-preflight` (daily-patrol / release). Output: stable JSON for Agent use.
```

- [ ] **Step 3: 全量 check**

Run: `bun run check`
Expected: 全量 pass（含新 probe/gate/bin tests + 现有 fsck/repair-plan/v2-preflight），0 fail。lint（tsc src + biome）过。

- [ ] **Step 4: 对抗审查（workflow）**

运行 5 维度对抗审查 workflow（同 #270/#272/#273 模式）：(1) hard/warning 分类完整（无 hard check 漏分类为 warning，反之亦然）；(2) lanceState 解释正确（corrupt/missing+chunks hard，missing+空库 warning）；(3) gate output 匿名（无真实 slug/path）；(4) probeHierarchy current-fact 语义（superseded 不算 current）+ layer="sqlite" 不破 FsckLayerSchema；(5) scope（不顺势改 fsck 现有 probes/sync/sqlite schema，只加 probe + gate + bin + 接入 + repair-plan key fix）。修 finding（如有）。

- [ ] **Step 5: 最终 commit + 交付**

```bash
git add tests/core/maintenance/sync.test.ts docs/developer-reference.md
git commit -m "test(gate): sync skip regression + docs for gate:consistency (#279)"
```

交付宏哥审核 → 二审 approve → ff merge main + main check + push/close #279（同 #270/#272/#273）。

---

## Self-Review (执行前已做)

**Spec coverage:**
- Acceptance 1（单命令 gate:consistency）→ Task 4 ✓
- Acceptance 2（匿名 fixture）→ 全 test 匿名（entities/seed 等）✓
- Acceptance 3（fail on missing chunks/stale FTS/coverage gap/dangling）→ Task 3 HARD_CHECKS ✓
- Acceptance 4（LanceDB hard + lanceState）→ Task 3 lanceState 逻辑 + test ✓
- Acceptance 5（sync skip regression）→ Task 6 Step 1 ✓
- Acceptance 6（hierarchy split-brain probe）→ Task 2 ✓
- Acceptance 7（projection drift skip #280）→ Non-goals ✓
- Acceptance 8（hard/warning 分层）→ Task 3 ✓
- Acceptance 9（documented）→ Task 6 Step 2 ✓
- Acceptance 10（v2-preflight 接入）→ Task 5 ✓
- Acceptance 11（repair-plan key fix）→ Task 1 ✓
- Acceptance 12（gate 源码入口）→ Task 4 import src（不 shell，更干净 + hasChunks 可查；spec 的"shell 源码 CLI"改为 import，符合"不依赖 PATH cbrain"核心）✓

**Placeholder scan:** Task 6 Step 1 sync regression test 用了 `... mirror existing ...`（执行时读 sync.test.ts 模式补全）—— 这是唯一带执行时确认的步骤，因 sync.test.ts 现有 fixture 模式未读全。其余 step 全含完整代码。Task 4 Step 4 bin/ e2e test 用 `test.todo`（gate function 已纯测覆盖，e2e 边际价值低，执行时按需补）。

**Type consistency:** `evaluateConsistencyGate(report, hasChunks, repairPlanStatus?)` 签名在 Task 3 定义 + Task 4 bin/ 调用一致；`ConsistencyGateResult` 字段（passed/hard/warnings/lanceState/repairPlanStatus/nextAction）一致；`probeHierarchy(vaultPath, db)` Task 2 定义 + fsck.ts 调用一致；`hierarchy.frontmatter_graph_mismatch` / `lance.vector_coverage_gap` check name 全文统一。

**风险:** Task 6 Step 1 sync regression test 需读 sync.test.ts 现有 fixture 模式（执行时补）；Task 4 bin/ 用 `performance.now()` + `new Date()`（源码可用，非 workflow script）；bin/ import 路径（`../src/cli/context.js` 等）基于 maintenance.ts/fsck.ts 现有 import 推断，执行时确认相对路径正确。
