import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createHash } from "node:crypto";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runCli(command: string, args: string[], cfgPath: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["bun", "run", "src/cli/index.ts", command, ...args],
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

async function runFsckCli(args: string[], cfgPath: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	return runCli("fsck", args, cfgPath);
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

function candidateSnapshot(dir: string): string {
	return readdirSync(dir).filter((name) => name === "records 2" || name === "anonymous-empty.md").sort().map((name) => {
		const stats = statSync(join(dir, name));
		return `${name}:${stats.size}:${stats.mtimeMs}`;
	}).join("|");
}

function fileHash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
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

test("--local-details rejects every incompatible shape before opening the DB", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-local-invalid-");
	const dbPath = join(dir, "missing", "brain.sqlite");
	const cfg = writeCfg(dir, dbPath);
	const cases = [
		["--local-details"],
		["--local-details", "--layer", "sqlite"],
		["--local-details", "--layer", "vault", "--json"],
		["--local-details", "--layer", "vault", "--repair-plan"],
		["--local-details", "--layer", "vault", "--repair-stale-fts"],
	];

	for (const args of cases) {
		const res = await runFsckCli(args, cfg);
		expect(res.exitCode).toBe(2);
		expect(`${res.stdout}${res.stderr}`).toContain("--local-details");
		expect(`${res.stdout}${res.stderr}`).not.toContain("DB file not found");
		expect(existsSync(dbPath)).toBe(false);
	}
});

test("default fsck is aggregate-only while local details are escaped, relative, and one-line", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-local-output-");
	const dbPath = join(dir, "brain.sqlite");
	const db = new CBrainDB(dbPath);
	db.rawDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	db.close();
	const cfg = writeCfg(dir, dbPath);
	mkdirSync(join(dir, ".obsidian"));
	const candidate = "anonymous\\n\\u202E.md".replace("\\n", "\n").replace("\\u202E", "\u202E");
	writeFileSync(join(dir, candidate), "");
	writeFileSync(join(dir, "review.md"), "synthetic-private-body-marker");
	const beforeDb = fileHash(dbPath);
	const beforeCandidateMtime = statSync(join(dir, candidate)).mtimeMs;

	const aggregate = await runFsckCli(["--layer", "vault", "--json"], cfg);
	expect(aggregate.exitCode).toBe(1);
	expect(aggregate.stdout).not.toContain("anonymous");
	expect(aggregate.stdout).not.toContain(dir);
	expect(aggregate.stdout).not.toContain("synthetic-private-body-marker");
	expect(JSON.parse(aggregate.stdout).findings).toContainEqual(expect.objectContaining({
		check: "vault.misplaced_zero_byte_markdown",
		count: 1,
	}));

	const local = await runFsckCli(["--layer", "vault", "--local-details"], cfg);
	expect(local.exitCode).toBe(1);
	expect(local.stdout).toContain("zero_byte_markdown");
	expect(local.stdout).toContain('"anonymous\\n\\u202E.md"');
	expect(local.stdout).not.toContain(dir);
	expect(local.stdout).not.toContain("synthetic-private-body-marker");
	expect(local.stdout.split("\n").filter((line) => line.startsWith("zero_byte_markdown "))).toHaveLength(1);
	expect(local.stdout.split("\n").filter((line) => line.startsWith("review_required "))).toHaveLength(1);
	expect(fileHash(dbPath)).toBe(beforeDb);
	expect(statSync(join(dir, candidate)).mtimeMs).toBe(beforeCandidateMtime);
});

test("repair-plan --execute can repair stale FTS without changing misplaced candidates", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-repair-candidate-");
	const dbPath = join(dir, "brain.sqlite");
	const db = new CBrainDB(dbPath);
	db.ftsInsert("anonymous-stale", "anonymous stale body");
	db.close();
	const cfg = writeCfg(dir, dbPath);
	mkdirSync(join(dir, ".obsidian"));
	mkdirSync(join(dir, "records 2"));
	writeFileSync(join(dir, "anonymous-empty.md"), "");
	const before = candidateSnapshot(dir);

	const result = await runCli("repair-plan", ["--execute", "--json"], cfg);
	expect(result.exitCode).toBe(1);
	expect(JSON.parse(result.stdout).execution.executed).toContain("fts.stale_rows");
	expect(candidateSnapshot(dir)).toBe(before);
});
