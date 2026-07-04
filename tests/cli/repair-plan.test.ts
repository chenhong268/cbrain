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
