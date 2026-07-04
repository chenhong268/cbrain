# Fsck Repair Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deterministic repair-plan layer that turns fsck findings into privacy-safe repair guidance, with bounded execution for already-safe repairs.

**Architecture:** Add a pure core planner under `src/core/fsck/repair-plan.ts` that classifies existing `FsckFinding` objects into repair buckets. Wire it into `cbrain repair-plan` and `cbrain fsck --repair-plan` without changing fsck's default read-only behavior. Execution is deliberately narrow: Phase 1 can execute stale FTS cleanup through the existing #274 primitive, while all factual or projection repairs remain dry-run guidance.

**Tech Stack:** TypeScript, Commander, Bun test, existing `CBrainDB`, existing fsck probes and reports.

---

## File Structure

- Create `src/core/fsck/repair-plan.ts`: pure types, classifier, Markdown formatter, and stable JSON shape.
- Modify `src/cli/commands/fsck.ts`: expose `runRepairPlan`, add `cbrain repair-plan`, and add `fsck --repair-plan`.
- Modify `src/cli/program.ts`: no change expected if `repair-plan` is registered from `fsck.ts`.
- Modify `README.md` and generated `docs/usage.md`: document `repair-plan` and the existing `fsck --repair-stale-fts`.
- Create `tests/core/fsck/repair-plan.test.ts`: pure classification and privacy tests.
- Create `tests/cli/repair-plan.test.ts`: CLI dry-run/execute/verify tests with anonymous fixtures.
- Modify `tests/cli/fsck.blackbox.test.ts`: cover `fsck --repair-plan --json`.

## Task 1: Core Repair Plan Classifier

**Files:**
- Create: `src/core/fsck/repair-plan.ts`
- Test: `tests/core/fsck/repair-plan.test.ts`

- [ ] **Step 1: Write failing classifier tests**

Add `tests/core/fsck/repair-plan.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { FsckFinding, FsckReport } from "../../../src/core/fsck/types.js";
import { buildRepairPlan, formatRepairPlanMarkdown } from "../../../src/core/fsck/repair-plan.js";

function finding(partial: Partial<FsckFinding> & Pick<FsckFinding, "check">): FsckFinding {
	return {
		check: partial.check,
		layer: partial.layer ?? "fts",
		severity: partial.severity ?? "warning",
		count: partial.count ?? 1,
		sampleSlugs: partial.sampleSlugs ?? ["private/slug-a"],
		detail: partial.detail ?? "synthetic detail with private/slug-a",
		suggestedCommand: partial.suggestedCommand ?? "cbrain fsck --repair-stale-fts",
	};
}

function report(findings: FsckFinding[]): FsckReport {
	return {
		version: 1,
		timestamp: "2026-07-04T00:00:00.000Z",
		overallStatus: findings.length ? "warn" : "pass",
		counts: { critical: 0, error: 0, warning: findings.length, info: 0 },
		lanceState: "unchecked",
		findings,
	};
}

describe("buildRepairPlan (#278)", () => {
	test("classifies stale FTS as auto_repairable with explicit execute and verify commands", () => {
		const plan = buildRepairPlan(report([finding({ check: "fts.stale_rows", count: 7 })]));
		expect(plan.overallStatus).toBe("actionable");
		expect(plan.counts.auto_repairable).toBe(1);
		expect(plan.items[0]).toMatchObject({
			id: "repair_1",
			bucket: "auto_repairable",
			check: "fts.stale_rows",
			canExecute: true,
			executeCommand: "cbrain fsck --repair-stale-fts",
			verifyCommand: "cbrain fsck --json --layer fts",
		});
	});

	test("classifies missing chunks as auto_repairable but not directly executable in Phase 1", () => {
		const plan = buildRepairPlan(report([finding({ check: "sqlite.page_without_chunks", layer: "sqlite", count: 9 })]));
		expect(plan.items[0]).toMatchObject({
			bucket: "auto_repairable",
			canExecute: false,
			verifyCommand: "cbrain fsck --json --layer sqlite",
		});
		expect(plan.items[0].dryRunSummary).toContain("rebuild derived indexes");
	});

	test("classifies title collisions as needs_review", () => {
		const plan = buildRepairPlan(report([finding({ check: "sqlite.title_collision", layer: "sqlite", severity: "error" })]));
		expect(plan.items[0]).toMatchObject({
			bucket: "needs_review",
			canExecute: false,
		});
	});

	test("classifies fatal fsck reports as blocked", () => {
		const r = report([]);
		r.fatalError = "DB file not found";
		r.overallStatus = "fail";
		const plan = buildRepairPlan(r);
		expect(plan.overallStatus).toBe("blocked");
		expect(plan.items[0]).toMatchObject({
			bucket: "blocked",
			check: "fsck.fatal",
			canExecute: false,
		});
	});

	test("default JSON shape never exposes sample slugs or raw details", () => {
		const plan = buildRepairPlan(report([finding({ check: "fts.stale_rows" })]));
		const json = JSON.stringify(plan);
		expect(json).not.toContain("private/slug-a");
		expect(json).not.toContain("synthetic detail");
		expect(plan.items[0].samples).toEqual(["item_1"]);
	});

	test("Markdown is compact and privacy-safe", () => {
		const plan = buildRepairPlan(report([finding({ check: "fts.stale_rows", count: 3 })]));
		const md = formatRepairPlanMarkdown(plan);
		expect(md).toContain("State repair plan");
		expect(md).toContain("auto-repair");
		expect(md).not.toContain("private/slug-a");
		expect(md).not.toContain("synthetic detail");
	});
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
bun test tests/core/fsck/repair-plan.test.ts
```

Expected: fails because `src/core/fsck/repair-plan.ts` does not exist.

- [ ] **Step 3: Implement minimal classifier**

Create `src/core/fsck/repair-plan.ts`:

```ts
import type { FsckFinding, FsckReport, FsckSeverity } from "./types.js";
import { anonymizeSlugs } from "./report.js";

export type RepairBucket = "auto_repairable" | "needs_review" | "blocked" | "observe_only";
export type RepairPlanStatus = "clean" | "actionable" | "blocked";

export interface RepairPlanItem {
	id: string;
	bucket: RepairBucket;
	check: string;
	layer: string;
	severity: FsckSeverity;
	count: number;
	samples: string[];
	canExecute: boolean;
	prerequisite: string;
	dryRunSummary: string;
	suggestedCommand: string;
	executeCommand?: string;
	verifyCommand: string;
}

export interface RepairPlan {
	version: 1;
	timestamp: string;
	overallStatus: RepairPlanStatus;
	counts: Record<RepairBucket, number>;
	items: RepairPlanItem[];
}

interface Rule {
	bucket: RepairBucket;
	canExecute: boolean;
	prerequisite: string;
	dryRunSummary: string;
	executeCommand?: string;
	verifyCommand: string;
}

const DEFAULT_RULE: Rule = {
	bucket: "needs_review",
	canExecute: false,
	prerequisite: "review the finding before mutation",
	dryRunSummary: "Review the anonymized finding and choose a targeted repair.",
	verifyCommand: "cbrain fsck --json",
};

const RULES: Record<string, Rule> = {
	"fts.stale_rows": {
		bucket: "auto_repairable",
		canExecute: true,
		prerequisite: "no writer shutdown required; this deletes only FTS rows with no chunks",
		dryRunSummary: "Delete stale FTS rows, then verify the FTS layer.",
		suggestedCommand: "cbrain fsck --repair-stale-fts",
		executeCommand: "cbrain fsck --repair-stale-fts",
		verifyCommand: "cbrain fsck --json --layer fts",
	},
	"fts.coverage_gap": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "rebuild affected page indexes from current Markdown content",
		dryRunSummary: "Rebuild missing FTS rows from the authoritative page content.",
		verifyCommand: "cbrain fsck --json --layer fts",
	},
	"sqlite.page_without_chunks": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "rebuild derived indexes from current Markdown content",
		dryRunSummary: "Run targeted sync so missing chunks and FTS rows are rebuilt without changing facts.",
		verifyCommand: "cbrain fsck --json --layer sqlite",
	},
	"lance.coverage_gap": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "stop active writers before rebuilding vectors",
		dryRunSummary: "Rebuild missing vectors from SQLite chunks after writer shutdown.",
		verifyCommand: "cbrain fsck --json --layer lance",
	},
	"sqlite.title_collision": {
		bucket: "needs_review",
		canExecute: false,
		prerequisite: "human review required before renaming or merging content",
		dryRunSummary: "Inspect title collision candidates; do not auto-merge.",
		verifyCommand: "cbrain fsck --json --layer sqlite",
	},
	"vault.frontmatter_slug_mismatch": {
		bucket: "needs_review",
		canExecute: false,
		prerequisite: "human review required because vault frontmatter is user-owned",
		dryRunSummary: "Review the mismatch and decide whether the file or DB slug is authoritative.",
		verifyCommand: "cbrain fsck --json --layer vault",
	},
	"vault.file_exists_db_missing": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "sync Markdown file into SQLite and derived indexes",
		dryRunSummary: "Sync current Markdown files so missing DB rows are recreated.",
		verifyCommand: "cbrain fsck --json --layer vault",
	},
	"vault.db_exists_file_missing": {
		bucket: "needs_review",
		canExecute: false,
		prerequisite: "review required before deleting DB rows or restoring vault files",
		dryRunSummary: "Decide whether to restore the Markdown file or remove the DB row.",
		verifyCommand: "cbrain fsck --json --layer vault",
	},
	"sqlite.fk_orphan": {
		bucket: "auto_repairable",
		canExecute: false,
		prerequisite: "backup recommended before deleting orphan derived rows",
		dryRunSummary: "Run FK repair in dry-run first, then execute only after reviewing counts.",
		verifyCommand: "cbrain repair-fk",
	},
};

function ruleFor(finding: FsckFinding): Rule {
	if (finding.check.includes("quarantine")) {
		return {
			bucket: "observe_only",
			canExecute: false,
			prerequisite: "observe current quarantine state before manual release",
			dryRunSummary: "No storage repair is planned for this signal.",
			verifyCommand: "cbrain fsck --json",
		};
	}
	return RULES[finding.check] ?? DEFAULT_RULE;
}

function statusFor(items: RepairPlanItem[]): RepairPlanStatus {
	if (items.some((item) => item.bucket === "blocked")) return "blocked";
	if (items.length === 0) return "clean";
	return "actionable";
}

export function buildRepairPlan(report: FsckReport): RepairPlan {
	const items: RepairPlanItem[] = [];
	if (report.fatalError) {
		items.push({
			id: "repair_1",
			bucket: "blocked",
			check: "fsck.fatal",
			layer: "system",
			severity: "critical",
			count: 1,
			samples: [],
			canExecute: false,
			prerequisite: "fsck must run successfully before repair planning",
			dryRunSummary: "Resolve the fsck fatal error, then rerun repair-plan.",
			suggestedCommand: "cbrain fsck --json",
			verifyCommand: "cbrain fsck --json",
		});
	}

	for (const finding of report.findings) {
		const rule = ruleFor(finding);
		items.push({
			id: `repair_${items.length + 1}`,
			bucket: rule.bucket,
			check: finding.check,
			layer: finding.layer,
			severity: finding.severity,
			count: finding.count,
			samples: anonymizeSlugs(finding.sampleSlugs),
			canExecute: rule.canExecute,
			prerequisite: rule.prerequisite,
			dryRunSummary: rule.dryRunSummary,
			suggestedCommand: rule.executeCommand ?? finding.suggestedCommand ?? rule.verifyCommand,
			executeCommand: rule.executeCommand,
			verifyCommand: rule.verifyCommand,
		});
	}

	const counts: Record<RepairBucket, number> = {
		auto_repairable: 0,
		needs_review: 0,
		blocked: 0,
		observe_only: 0,
	};
	for (const item of items) counts[item.bucket]++;
	return {
		version: 1,
		timestamp: report.timestamp,
		overallStatus: statusFor(items),
		counts,
		items,
	};
}

const BUCKET_LABEL: Record<RepairBucket, string> = {
	auto_repairable: "auto-repair",
	needs_review: "needs review",
	blocked: "blocked",
	observe_only: "observe only",
};

export function formatRepairPlanMarkdown(plan: RepairPlan): string {
	const lines: string[] = [];
	lines.push("# State repair plan\n");
	lines.push(`- overall: **${plan.overallStatus}**`);
	lines.push(
		`- counts: auto=${plan.counts.auto_repairable} review=${plan.counts.needs_review} blocked=${plan.counts.blocked} observe=${plan.counts.observe_only}\n`,
	);
	if (plan.items.length === 0) {
		lines.push("No repair actions are needed.");
		return lines.join("\n");
	}
	for (const item of plan.items) {
		lines.push(`## ${item.id}: ${BUCKET_LABEL[item.bucket]} — ${item.check}`);
		lines.push(`- affected: ${item.count}`);
		if (item.samples.length) lines.push(`- sample: ${item.samples.join(", ")}`);
		lines.push(`- prerequisite: ${item.prerequisite}`);
		lines.push(`- dry-run: ${item.dryRunSummary}`);
		if (item.canExecute && item.executeCommand) lines.push(`- execute: \`${item.executeCommand}\``);
		else lines.push("- execute: not available in this phase");
		lines.push(`- verify: \`${item.verifyCommand}\`\n`);
	}
	return lines.join("\n");
}
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
bun test tests/core/fsck/repair-plan.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/fsck/repair-plan.ts tests/core/fsck/repair-plan.test.ts
git commit -m "feat(fsck): classify repair-plan findings (#278)"
```

## Task 2: CLI Dry-Run and fsck --repair-plan

**Files:**
- Modify: `src/cli/commands/fsck.ts`
- Test: `tests/cli/repair-plan.test.ts`
- Test: `tests/cli/fsck.blackbox.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Add `tests/cli/repair-plan.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

let dir = "";

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

async function runCli(args: string[], cfgPath: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", "run", "src/cli/index.ts", ...args],
		env: { ...process.env, CBRAIN_CONFIG: cfgPath },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout, stderr };
}

function writeCfg(dbPath: string): string {
	mkdirSync(join(dir, "vault"), { recursive: true });
	const cfgPath = join(dir, "cbrain.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({ vaultPath: join(dir, "vault"), dbPath, lancePath: join(dir, "lance") }),
	);
	return cfgPath;
}

function seedStaleFts(dbPath: string): void {
	const db = new CBrainDB(dbPath);
	db.ftsInsert("records/stale-a", "stale body");
	db.close();
}

test("repair-plan --json emits stable JSON and does not mutate by default", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-repair-plan-json-"));
	const dbPath = join(dir, "brain.sqlite");
	seedStaleFts(dbPath);
	const cfg = writeCfg(dbPath);

	const res = await runCli(["repair-plan", "--json"], cfg);
	expect(res.exitCode).toBe(1);
	const plan = JSON.parse(res.stdout);
	expect(plan.version).toBe(1);
	expect(plan.items[0]).toMatchObject({
		bucket: "auto_repairable",
		check: "fts.stale_rows",
		canExecute: true,
	});
	expect(JSON.stringify(plan)).not.toContain("records/stale-a");

	const verify = new CBrainDB(dbPath, { skipMigrate: true });
	try {
		expect(verify.getFtsContentsByPage("records/stale-a").length).toBeGreaterThan(0);
	} finally {
		verify.close();
	}
});

test("repair-plan default Markdown is privacy-safe", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-repair-plan-md-"));
	const dbPath = join(dir, "brain.sqlite");
	seedStaleFts(dbPath);
	const cfg = writeCfg(dbPath);

	const res = await runCli(["repair-plan"], cfg);
	expect(res.exitCode).toBe(1);
	expect(res.stdout).toContain("State repair plan");
	expect(res.stdout).toContain("auto-repair");
	expect(res.stdout).not.toContain("records/stale-a");
});

test("fsck --repair-plan --json emits the same plan shape", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-repair-plan-"));
	const dbPath = join(dir, "brain.sqlite");
	seedStaleFts(dbPath);
	const cfg = writeCfg(dbPath);

	const res = await runCli(["fsck", "--repair-plan", "--json"], cfg);
	expect(res.exitCode).toBe(1);
	const plan = JSON.parse(res.stdout);
	expect(plan.items[0].check).toBe("fts.stale_rows");
	expect(plan.items[0].executeCommand).toBe("cbrain fsck --repair-stale-fts");
});

test("repair-plan missing DB exits 2 without creating files", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-repair-plan-missing-"));
	const dbPath = join(dir, "missing", "brain.sqlite");
	const cfg = writeCfg(dbPath);

	const res = await runCli(["repair-plan", "--json"], cfg);
	expect(res.exitCode).toBe(2);
	const plan = JSON.parse(res.stdout);
	expect(plan.overallStatus).toBe("blocked");
	expect(existsSync(dbPath)).toBe(false);
	expect(existsSync(join(dir, "missing"))).toBe(false);
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
bun test tests/cli/repair-plan.test.ts
```

Expected: fails because `repair-plan` command is not registered.

- [ ] **Step 3: Implement CLI dry-run and fsck flag**

In `src/cli/commands/fsck.ts`:

- import `buildRepairPlan` and `formatRepairPlanMarkdown`.
- add `runRepairPlan(input: FsckInput)`.
- add `--repair-plan` to `fsck`; when set, output repair plan instead of raw fsck report.
- register `.command("repair-plan")` with `--json`, `--limit`, `--verify`, `--execute`.
- for Task 2, `--execute` should be parsed but return a fatal report saying execution is implemented in Task 3.

Use the same DB existence preflight as `fsck` so dry-run never creates a DB.

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
bun test tests/cli/repair-plan.test.ts tests/cli/fsck.blackbox.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/fsck.ts tests/cli/repair-plan.test.ts tests/cli/fsck.blackbox.test.ts
git commit -m "feat(cli): add repair-plan dry-run surface (#278)"
```

## Task 3: Bounded Execute for Stale FTS Only

**Files:**
- Modify: `src/core/fsck/repair-plan.ts`
- Modify: `src/cli/commands/fsck.ts`
- Test: `tests/cli/repair-plan.test.ts`

- [ ] **Step 1: Write failing execute tests**

Append to `tests/cli/repair-plan.test.ts`:

```ts
test("repair-plan --execute repairs stale FTS rows only and verifies clean plan", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-repair-plan-execute-"));
	const dbPath = join(dir, "brain.sqlite");
	const db = new CBrainDB(dbPath);
	db.insertPage({
		slug: "records/valid-a",
		type: "record",
		title: "Valid A",
		filePath: "valid-a.md",
		contentHash: "hash-a",
	});
	db.insertChunk("records/valid-a", 0, "valid body");
	db.ftsInsert("records/valid-a", "valid body");
	db.ftsInsert("records/stale-a", "stale body");
	db.close();
	const cfg = writeCfg(dbPath);

	const res = await runCli(["repair-plan", "--execute", "--json"], cfg);
	expect(res.exitCode).toBe(0);
	const plan = JSON.parse(res.stdout);
	expect(plan.execution.executed).toEqual(["fts.stale_rows"]);
	expect(JSON.stringify(plan)).not.toContain("records/stale-a");

	const verify = new CBrainDB(dbPath, { skipMigrate: true });
	try {
		expect(verify.getFtsContentsByPage("records/valid-a")).toEqual(["valid body"]);
		expect(verify.getFtsContentsByPage("records/stale-a")).toEqual([]);
	} finally {
		verify.close();
	}
});

test("repair-plan --execute --limit 0 executes nothing", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-repair-plan-limit-zero-"));
	const dbPath = join(dir, "brain.sqlite");
	seedStaleFts(dbPath);
	const cfg = writeCfg(dbPath);

	const res = await runCli(["repair-plan", "--execute", "--limit", "0", "--json"], cfg);
	expect(res.exitCode).toBe(1);
	const plan = JSON.parse(res.stdout);
	expect(plan.execution.executed).toEqual([]);

	const verify = new CBrainDB(dbPath, { skipMigrate: true });
	try {
		expect(verify.getFtsContentsByPage("records/stale-a").length).toBeGreaterThan(0);
	} finally {
		verify.close();
	}
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
bun test tests/cli/repair-plan.test.ts
```

Expected: execute tests fail because execution is not implemented.

- [ ] **Step 3: Implement execution envelope**

Extend `RepairPlan` with optional:

```ts
execution?: {
	mode: "dry_run" | "execute" | "verify";
	executed: string[];
	skipped: string[];
	verificationCommand: string;
};
```

In CLI execution:

- build initial plan from fsck;
- when `--execute`, execute only executable items up to `--limit`;
- implement only `fts.stale_rows` by calling `db.cleanupStaleFtsRows()`;
- rerun fsck and output a fresh repair plan with `execution` metadata;
- if remaining items exist, exit 1; if clean, exit 0; fatal remains exit 2.

- [ ] **Step 4: Run tests and confirm GREEN**

Run:

```bash
bun test tests/cli/repair-plan.test.ts tests/cli/fsck.blackbox.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/fsck/repair-plan.ts src/cli/commands/fsck.ts tests/cli/repair-plan.test.ts
git commit -m "feat(fsck): execute bounded stale-fts repair plan (#278)"
```

## Task 4: Verify Mode, Docs, and Consistency Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/usage.md`
- Modify: `src/cli/commands/fsck.ts`
- Test: `tests/cli/repair-plan.test.ts`

- [ ] **Step 1: Write failing verify and docs tests**

Append to `tests/cli/repair-plan.test.ts`:

```ts
test("repair-plan --verify returns clean when no findings remain", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-repair-plan-verify-clean-"));
	const dbPath = join(dir, "brain.sqlite");
	const db = new CBrainDB(dbPath);
	db.close();
	const cfg = writeCfg(dbPath);

	const res = await runCli(["repair-plan", "--verify", "--json"], cfg);
	expect(res.exitCode).toBe(0);
	const plan = JSON.parse(res.stdout);
	expect(plan.overallStatus).toBe("clean");
	expect(plan.execution.mode).toBe("verify");
});

test("repair-plan --verify exits 1 when findings remain", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-repair-plan-verify-dirty-"));
	const dbPath = join(dir, "brain.sqlite");
	seedStaleFts(dbPath);
	const cfg = writeCfg(dbPath);

	const res = await runCli(["repair-plan", "--verify", "--json"], cfg);
	expect(res.exitCode).toBe(1);
	const plan = JSON.parse(res.stdout);
	expect(plan.overallStatus).toBe("actionable");
	expect(plan.execution.mode).toBe("verify");
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
bun test tests/cli/repair-plan.test.ts
```

Expected: verify metadata assertions fail.

- [ ] **Step 3: Implement verify metadata and docs**

Implement `--verify` as read-only:

- no repair calls;
- attach `execution.mode = "verify"`;
- exit 0 only if plan is clean, exit 1 if actionable/blocked, exit 2 on fatal.

Update `README.md` maintenance command table:

```md
| `cbrain repair-plan` | 将 fsck 结果转成安全修复计划；默认 dry-run |
| `cbrain repair-plan --execute --limit 50` | 只执行已声明安全的派生层修复 |
```

Then run:

```bash
bun bin/check-docs-consistency.ts --update
```

- [ ] **Step 4: Run tests and docs gate**

Run:

```bash
bun test tests/cli/repair-plan.test.ts
bun run check:docs
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/usage.md src/cli/commands/fsck.ts tests/cli/repair-plan.test.ts
git commit -m "docs(fsck): document repair-plan workflow (#278)"
```

## Task 5: Full Verification and Adversarial Review

**Files:**
- No new source files expected.

- [ ] **Step 1: Run focused tests**

```bash
bun test tests/core/fsck/repair-plan.test.ts tests/cli/repair-plan.test.ts tests/cli/fsck.blackbox.test.ts tests/cli/fsck.readonly.test.ts tests/cli/fsck.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run full checks**

```bash
bun run check:docs
bun run typecheck
bun run lint
```

Expected: all pass.

- [ ] **Step 3: Run full test suite if time allows**

```bash
bun run check
```

Expected: all pass. If release gate fails due to missing `node_modules` in a worktree, link the main checkout `node_modules` as verification setup and rerun the failed gate subset before rerunning full check.

- [ ] **Step 4: Adversarial review checklist**

Verify these by code inspection and tests:

1. `cbrain fsck` without repair flags remains read-only.
2. `repair-plan` JSON and Markdown never expose raw slugs, titles, paths, or finding detail text by default.
3. `--execute` only executes `fts.stale_rows`; all other buckets remain guidance.
4. `--limit` can prevent execution.
5. fatal fsck results become blocked plans and never create DB files.

- [ ] **Step 5: Commit if any final fixes were required**

```bash
git status --short
git diff --check
```

If fixes were needed:

```bash
git add <fixed-files>
git commit -m "test(fsck): harden repair-plan workflow (#278)"
```

---

## Self-Review

- Spec coverage: The plan covers deterministic finding-to-plan classification, default dry-run, JSON and Markdown output, bounded execution, verification commands, privacy-safe samples, and read-only default fsck behavior.
- Scope control: Phase 1 only executes stale FTS cleanup because #274 already owns that primitive. Missing chunks, vectors, projection drift, FK repair, and factual conflicts remain guidance.
- Placeholder scan: No TBD/TODO/fill-later placeholders remain. Future projector work is explicitly out of execute scope.
- Type consistency: `RepairPlan`, `RepairPlanItem`, and `execution` names are defined before CLI use and are reused consistently.
