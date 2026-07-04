import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

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

function withTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function writeCfg(dir: string, dbPath: string): string {
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
	const dir = withTempDir("cbrain-repair-plan-json-");
	const dbPath = join(dir, "brain.sqlite");
	try {
		seedStaleFts(dbPath);
		const cfg = writeCfg(dir, dbPath);

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
	} finally {
		cleanupDir(dir);
	}
});

test("repair-plan default Markdown is privacy-safe", async () => {
	const dir = withTempDir("cbrain-repair-plan-md-");
	const dbPath = join(dir, "brain.sqlite");
	try {
		seedStaleFts(dbPath);
		const cfg = writeCfg(dir, dbPath);

		const res = await runCli(["repair-plan"], cfg);
		expect(res.exitCode).toBe(1);
		expect(res.stdout).toContain("State repair plan");
		expect(res.stdout).toContain("auto-repair");
		expect(res.stdout).not.toContain("records/stale-a");
	} finally {
		cleanupDir(dir);
	}
});

test("fsck --repair-plan --json emits the same plan shape", async () => {
	const dir = withTempDir("cbrain-fsck-repair-plan-");
	const dbPath = join(dir, "brain.sqlite");
	try {
		seedStaleFts(dbPath);
		const cfg = writeCfg(dir, dbPath);

		const res = await runCli(["fsck", "--repair-plan", "--json"], cfg);
		expect(res.exitCode).toBe(1);
		const plan = JSON.parse(res.stdout);
		expect(plan.items[0].check).toBe("fts.stale_rows");
		expect(plan.items[0].executeCommand).toBe("cbrain fsck --repair-stale-fts");
	} finally {
		cleanupDir(dir);
	}
});

test("repair-plan missing DB exits 2 without creating files", async () => {
	const dir = withTempDir("cbrain-repair-plan-missing-");
	const dbPath = join(dir, "missing", "brain.sqlite");
	try {
		const cfg = writeCfg(dir, dbPath);

		const res = await runCli(["repair-plan", "--json"], cfg);
		expect(res.exitCode).toBe(2);
		const plan = JSON.parse(res.stdout);
		expect(plan.overallStatus).toBe("blocked");
		expect(existsSync(dbPath)).toBe(false);
		expect(existsSync(join(dir, "missing"))).toBe(false);
	} finally {
		cleanupDir(dir);
	}
});

test("repair-plan --execute repairs stale FTS rows only and verifies clean plan", async () => {
	const dir = withTempDir("cbrain-repair-plan-execute-");
	const dbPath = join(dir, "brain.sqlite");
	try {
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
		const cfg = writeCfg(dir, dbPath);
		writeFileSync(
			join(dir, "vault", "valid-a.md"),
			"---\nslug: records/valid-a\ntitle: Valid A\ntype: record\n---\n\nvalid body\n",
		);

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
	} finally {
		cleanupDir(dir);
	}
});

test("repair-plan --execute --limit 0 executes nothing", async () => {
	const dir = withTempDir("cbrain-repair-plan-limit-zero-");
	const dbPath = join(dir, "brain.sqlite");
	try {
		seedStaleFts(dbPath);
		const cfg = writeCfg(dir, dbPath);

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
	} finally {
		cleanupDir(dir);
	}
});

test("repair-plan --verify returns clean when no findings remain", async () => {
	const dir = withTempDir("cbrain-repair-plan-verify-clean-");
	const dbPath = join(dir, "brain.sqlite");
	try {
		const db = new CBrainDB(dbPath);
		db.close();
		const cfg = writeCfg(dir, dbPath);

		const res = await runCli(["repair-plan", "--verify", "--json"], cfg);
		expect(res.exitCode).toBe(0);
		const plan = JSON.parse(res.stdout);
		expect(plan.overallStatus).toBe("clean");
		expect(plan.execution.mode).toBe("verify");
	} finally {
		cleanupDir(dir);
	}
});

test("repair-plan --verify exits 1 when findings remain", async () => {
	const dir = withTempDir("cbrain-repair-plan-verify-dirty-");
	const dbPath = join(dir, "brain.sqlite");
	try {
		seedStaleFts(dbPath);
		const cfg = writeCfg(dir, dbPath);

		const res = await runCli(["repair-plan", "--verify", "--json"], cfg);
		expect(res.exitCode).toBe(1);
		const plan = JSON.parse(res.stdout);
		expect(plan.overallStatus).toBe("actionable");
		expect(plan.execution.mode).toBe("verify");
	} finally {
		cleanupDir(dir);
	}
});
