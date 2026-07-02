import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

let dir: string;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
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

function writeCfg(dbPath: string): string {
	mkdirSync(join(dir, "vault"), { recursive: true });
	const cfgPath = join(dir, "cbrain.json");
	writeFileSync(
		cfgPath,
		JSON.stringify({ vaultPath: join(dir, "vault"), dbPath, lancePath: join(dir, "lance") }),
	);
	return cfgPath;
}

test("missing DB → exit 2 + no file/dir created (read-only contract)", async () => {
	dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-bb-missing-"));
	const dbPath = join(dir, "missing-dir", "brain.sqlite"); // 父目录不存在
	const cfg = writeCfg(dbPath);
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
	dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-bb-layer-"));
	const dbPath = join(dir, "brain.sqlite");
	// 建真 DB 让 DB 预检通过，隔离 layer 校验
	const db = new CBrainDB(dbPath);
	db.close();
	const cfg = writeCfg(dbPath);

	const res = await runFsckCli(["--layer", "nope", "--json"], cfg);
	expect(res.exitCode).toBe(2);
	const report = JSON.parse(res.stdout);
	expect(report.fatalError).toMatch(/Invalid --layer/);
	expect(report.fatalError).toMatch(/vault.*sqlite.*fts.*lance/);
});
