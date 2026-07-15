import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

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
	const lines: string[] = [];
	const walk = (path: string, relativePath: string): void => {
		const stats = lstatSync(path);
		if (stats.isDirectory()) {
			lines.push(`${relativePath}:directory:${stats.size}:${stats.mtimeMs}`);
			for (const name of readdirSync(path).sort()) walk(join(path, name), `${relativePath}/${name}`);
			return;
		}
		const kind = stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "special";
		const contentHash = stats.isFile() ? fileHash(path) : "not-opened";
		lines.push(`${relativePath}:${kind}:${stats.size}:${stats.mtimeMs}:${contentHash}`);
	};
	for (const name of ["anonymous-empty.md", "records 2"]) {
		walk(join(dir, name), name);
	}
	return lines.sort().join("|");
}

function fileHash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function convertToDeleteMode(dbPath: string): void {
	const writable = new CBrainDB(dbPath);
	writable.checkpoint();
	writable.rawDb.exec("PRAGMA journal_mode = DELETE");
	writable.close();
}

function createWalHeaderWithoutSidecars(dbPath: string): void {
	const writable = new CBrainDB(dbPath);
	writable.checkpoint();
	writable.close();
	rmSync(`${dbPath}-wal`, { force: true });
	rmSync(`${dbPath}-shm`, { force: true });
	expect(readFileSync(dbPath)[18]).toBe(2);
}

function journalMode(dbPath: string): string {
	const native = new Database(dbPath, { readonly: true });
	try {
		return (native.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
	} finally {
		native.close();
	}
}

function sidecarSnapshot(dbPath: string): string {
	return ["-wal", "-shm", "-journal"].map((suffix) => {
		const path = `${dbPath}${suffix}`;
		if (!existsSync(path)) return `${suffix}:missing`;
		const stats = statSync(path);
		return `${suffix}:${stats.size}:${stats.mtimeMs}:${fileHash(path)}`;
	}).join("|");
}

function readSnapshotTempDirs(): string[] {
	return readdirSync(tmpdir()).filter((name) => name.startsWith("cbrain-read-snapshot-")).sort();
}

const readOnlyScenarios = [
	{ name: "fsck default", command: "fsck", args: [] },
	{ name: "fsck json", command: "fsck", args: ["--json"] },
	{ name: "fsck local details", command: "fsck", args: ["--layer", "vault", "--local-details"] },
	{ name: "repair-plan dry-run", command: "repair-plan", args: ["--json"] },
	{ name: "repair-plan verify", command: "repair-plan", args: ["--verify", "--json"] },
	{ name: "repair-plan verify precedence", command: "repair-plan", args: ["--verify", "--execute", "--json"] },
] as const;

for (const mode of ["delete", "wal-header-cleaned"] as const) {
	for (const scenario of readOnlyScenarios) {
	test(`${scenario.name} preserves ${mode} DB bytes and sidecars`, async () => {
		const dir = makeTempDir("cbrain-fsck-bb-delete-mode-");
		const dbPath = join(dir, "brain.sqlite");
		if (mode === "delete") convertToDeleteMode(dbPath);
		else createWalHeaderWithoutSidecars(dbPath);
		const cfg = writeCfg(dir, dbPath);
		mkdirSync(join(dir, ".obsidian"));
		writeFileSync(join(dir, "anonymous-empty.md"), "");
		mkdirSync(join(dir, "records 2", "nested"), { recursive: true });
		writeFileSync(join(dir, "records 2", "nested", "anonymous-content.md"), "anonymous candidate body");
		mkdirSync(join(dir, "vault", "records"), { recursive: true });
		const canonicalPath = join(dir, "vault", "records", "anonymous-canonical.md");
		writeFileSync(canonicalPath, "anonymous canonical body without frontmatter");
		const beforeHash = fileHash(dbPath);
		const beforeSidecars = sidecarSnapshot(dbPath);
		const beforeCandidates = candidateSnapshot(dir);
		const beforeCanonicalMtime = statSync(canonicalPath).mtimeMs;
		const beforeTempDirs = readSnapshotTempDirs();
		if (mode === "delete") expect(journalMode(dbPath)).toBe("delete");
		else expect(readFileSync(dbPath)[18]).toBe(2);

		const result = await runCli(scenario.command, [...scenario.args], cfg);
		expect(result.exitCode).not.toBe(2);
		if (mode === "delete") expect(journalMode(dbPath)).toBe("delete");
		else expect(readFileSync(dbPath)[18]).toBe(2);
		expect(fileHash(dbPath)).toBe(beforeHash);
		expect(sidecarSnapshot(dbPath)).toBe(beforeSidecars);
		expect(candidateSnapshot(dir)).toBe(beforeCandidates);
		expect(statSync(canonicalPath).mtimeMs).toBe(beforeCanonicalMtime);
		expect(readSnapshotTempDirs()).toEqual(beforeTempDirs);
	});
	}
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
	db.insertPage({
		slug: "records/anonymous-canonical",
		type: "record",
		title: "Anonymous canonical",
		filePath: "records/anonymous-canonical.md",
		contentHash: "anonymous-hash",
	});
	db.insertChunk("records/anonymous-canonical", 0, "anonymous canonical body");
	db.ftsInsert("records/anonymous-canonical", "anonymous canonical body");
	db.ftsInsert("anonymous-stale", "anonymous stale body");
	db.close();
	const cfg = writeCfg(dir, dbPath);
	mkdirSync(join(dir, ".obsidian"));
	mkdirSync(join(dir, "records 2", "nested"), { recursive: true });
	writeFileSync(join(dir, "records 2", "nested", "anonymous-content.md"), "anonymous candidate body");
	writeFileSync(join(dir, "anonymous-empty.md"), "");
	mkdirSync(join(dir, "vault", "records"), { recursive: true });
	const canonicalPath = join(dir, "vault", "records", "anonymous-canonical.md");
	writeFileSync(
		canonicalPath,
		"---\nslug: records/anonymous-canonical\ntitle: Anonymous canonical\ntype: record\n---\n\nanonymous canonical body\n",
	);
	const before = candidateSnapshot(dir);
	const canonicalMtime = statSync(canonicalPath).mtimeMs;

	const result = await runCli("repair-plan", ["--execute", "--json"], cfg);
	expect(result.exitCode).toBe(1);
	expect(JSON.parse(result.stdout).execution.executed).toContain("fts.stale_rows");
	expect(candidateSnapshot(dir)).toBe(before);
	expect(statSync(canonicalPath).mtimeMs).toBe(canonicalMtime);
});

test("fsck reads a page committed only in active WAL without changing live main/wal/shm", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-active-wal-");
	const dbPath = join(dir, "brain.sqlite");
	const seed = new CBrainDB(dbPath);
	seed.checkpoint();
	seed.close();
	const writer = new Database(dbPath);
	writer.exec("PRAGMA wal_autocheckpoint=0");
	writer.prepare(
		"INSERT INTO pages (slug, type, title, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
	).run("records/anonymous-wal-only", "record", "Anonymous WAL only", "records/anonymous-wal-only.md", "anonymous-hash");
	const cfg = writeCfg(dir, dbPath);
	mkdirSync(join(dir, ".obsidian"));
	const beforeMain = fileHash(dbPath);
	const beforeSidecars = sidecarSnapshot(dbPath);
	expect(existsSync(`${dbPath}-wal`)).toBe(true);
	expect(existsSync(`${dbPath}-shm`)).toBe(true);

	try {
		const result = await runFsckCli(["--layer", "vault", "--json"], cfg);
		expect(result.exitCode).toBe(1);
		const report = JSON.parse(result.stdout);
		expect(report.findings).toContainEqual(expect.objectContaining({
			check: "vault.db_exists_file_missing",
			count: 1,
		}));
		expect(fileHash(dbPath)).toBe(beforeMain);
		expect(sidecarSnapshot(dbPath)).toBe(beforeSidecars);
	} finally {
		writer.close();
	}
});

test("unstable or invalid snapshot source fails closed with a fixed path-free CLI error", async () => {
	const dir = makeTempDir("cbrain-fsck-bb-snapshot-fail-closed-");
	const dbPath = join(dir, "brain.sqlite");
	convertToDeleteMode(dbPath);
	const cfg = writeCfg(dir, dbPath);
	mkdirSync(`${dbPath}-wal`);
	writeFileSync(join(`${dbPath}-wal`, "invalid"), "not a WAL file");

	const result = await runFsckCli(["--json"], cfg);
	expect(result.exitCode).toBe(2);
	const report = JSON.parse(result.stdout);
	expect(report.overallStatus).toBe("fail");
	expect(report.fatalError).toBe("Unable to open a stable read snapshot");
	expect(result.stdout).not.toContain(dir);
	expect(result.stdout).not.toContain("not a WAL file");
});
