import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runFsckCli(args: string[], cfgPath: string): Promise<{ exitCode: number; stdout: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", "run", "src/cli/index.ts", "fsck", ...args],
		env: { ...process.env, CBRAIN_CONFIG: cfgPath },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { exitCode, stdout };
}

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
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

test("missing DB → exit 2 + no file/dir created (read-only contract)", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-missing-");
	const dbPath = join(dir, "missing-dir", "brain.sqlite"); // 父目录不存在
	const cfg = writeCfg(dir, dbPath);
	expect(existsSync(dbPath)).toBe(false);

	const res = await runFsckCli(["--json"], cfg);
	expect(res.exitCode).toBe(2);
	const report = JSON.parse(res.stdout);
	expect(report.overallStatus).toBe("fail");
	expect(report.fatalError).toMatch(/DB file not found/i);
	// 只读契约：fsck 不得创建 DB 文件或父目录
	expect(existsSync(dbPath)).toBe(false);
	expect(existsSync(join(dir, "missing-dir"))).toBe(false);
});

test("invalid --layer → exit 2 + fatalError lists allowed values", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-layer-");
	const dbPath = join(dir, "brain.sqlite");
	// 建真 DB 让 DB 预检通过，隔离 layer 校验
	const db = new CBrainDB(dbPath);
	db.close();
	const cfg = writeCfg(dir, dbPath);

	const res = await runFsckCli(["--layer", "nope", "--json"], cfg);
	expect(res.exitCode).toBe(2);
	const report = JSON.parse(res.stdout);
	expect(report.fatalError).toMatch(/Invalid --layer/);
	expect(report.fatalError).toMatch(/vault.*sqlite.*fts.*lance/);
});

test("--repair-stale-fts deletes only stale FTS rows and verifies fts layer", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-repair-");
	const dbPath = join(dir, "brain.sqlite");
	const db = new CBrainDB(dbPath);
	db.insertPage({
		slug: "test-valid-page",
		type: "record",
		title: "Valid",
		filePath: "valid.md",
		contentHash: "h-valid",
	});
	db.insertChunk("test-valid-page", 0, "valid body");
	db.ftsInsert("test-valid-page", "valid body");
	db.ftsInsert("test-stale-page", "stale body");
	db.close();
	const cfg = writeCfg(dir, dbPath);

	const res = await runFsckCli(["--repair-stale-fts", "--json"], cfg);
	expect(res.exitCode).toBe(0);
	const report = JSON.parse(res.stdout);
	expect(report.overallStatus).toBe("pass");
	expect(report.findings.find((f: { check: string }) => f.check === "fts.stale_rows")).toBeUndefined();

	const verify = new CBrainDB(dbPath, { skipMigrate: true });
	try {
		expect(verify.getFtsContentsByPage("test-valid-page")).toEqual(["valid body"]);
		expect(verify.getFtsContentsByPage("test-stale-page")).toEqual([]);
	} finally {
		verify.close();
	}
});

test("--repair-stale-fts rejects non-fts layer to avoid ambiguous repair", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-repair-layer-");
	const dbPath = join(dir, "brain.sqlite");
	const db = new CBrainDB(dbPath);
	db.close();
	const cfg = writeCfg(dir, dbPath);

	const res = await runFsckCli(["--repair-stale-fts", "--layer", "sqlite", "--json"], cfg);
	expect(res.exitCode).toBe(2);
	const report = JSON.parse(res.stdout);
	expect(report.fatalError).toContain("--repair-stale-fts");
});
