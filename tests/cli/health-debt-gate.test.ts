import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

const cleanBaseline = () => ({
	gate: "consistency",
	version: "1",
	timestamp: "2026-07-05T00:00:00.000Z",
	passed: true,
	hard: [],
	warnings: [],
	lanceState: "ok",
	repairPlanStatus: "clean",
	next_action: "ok",
	duration_ms: 1,
});

describe("bin/check-health-debt-gate.ts e2e (#295)", () => {
	let testDir: string;
	let configPath: string;
	let dbPath: string;
	let vaultPath: string;
	let lancePath: string;
	let baselinePath: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "cbrain-debt-gate-e2e-"));
		configPath = join(testDir, "cbrain.json");
		dbPath = join(testDir, "test.sqlite");
		vaultPath = join(testDir, "vault");
		lancePath = join(testDir, "lance");
		baselinePath = join(testDir, "baseline.json");
		mkdirSync(vaultPath, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		writeFileSync(baselinePath, JSON.stringify(cleanBaseline()));
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	async function runGate(args: string[] = ["--baseline", baselinePath]): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["bun", "bin/check-health-debt-gate.ts", ...args], {
			cwd: process.cwd(),
			env: { ...process.env, CBRAIN_CONFIG: configPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, json: JSON.parse(stdout), stdout, stderr };
	}

	test("clean DB + clean baseline exits 0 with pass status", async () => {
		const db = new CBrainDB(dbPath);
		db.close();
		const { exitCode, json } = await runGate();
		expect(exitCode).toBe(0);
		expect(json.gate).toBe("health-debt-delta");
		expect(json.passed).toBe(true);
		expect(json.status).toBe("pass");
		expect(json.new_hard).toEqual([]);
	});

	test("page_without_chunks compared with clean baseline exits 1 and lists new hard debt", async () => {
		const db = new CBrainDB(dbPath);
		mkdirSync(join(vaultPath, "entities"), { recursive: true });
		writeFileSync(join(vaultPath, "entities/a.md"), `---\ntitle: "A"\ntype: entity/person\nslug: entities/a\n---\nbody\n`);
		db.upsertPage({ slug: "entities/a", type: "entity/person", title: "A", filePath: "entities/a.md", contentHash: "h-a" });
		db.close();

		const { exitCode, json } = await runGate();
		expect(exitCode).toBe(1);
		expect(json.passed).toBe(false);
		const newHard = json.new_hard as Array<{ check: string }>;
		expect(newHard.some((h) => h.check === "sqlite.page_without_chunks")).toBe(true);
		expect(JSON.stringify(json)).not.toContain("entities/a");
		expect(JSON.stringify(json)).not.toContain(testDir);
	});

	test("missing baseline exits 2 with fixed privacy-safe diagnostic", async () => {
		const db = new CBrainDB(dbPath);
		db.close();
		const missing = join(testDir, "missing-baseline.json");
		const { exitCode, json } = await runGate(["--baseline", missing]);
		expect(exitCode).toBe(2);
		expect(json.passed).toBe(false);
		expect(json.status).toBe("fail");
		expect(String(json.next_action)).toContain("baseline");
		expect(JSON.stringify(json)).not.toContain(missing);
		expect(JSON.stringify(json)).not.toContain(testDir);
	});

	test("invalid baseline exits 2 with fixed privacy-safe diagnostic", async () => {
		const db = new CBrainDB(dbPath);
		db.close();
		writeFileSync(baselinePath, "{not json");
		const { exitCode, json } = await runGate();
		expect(exitCode).toBe(2);
		expect(json.passed).toBe(false);
		expect(json.status).toBe("fail");
		expect(String(json.next_action)).toContain("baseline");
		expect(JSON.stringify(json)).not.toContain(baselinePath);
		expect(JSON.stringify(json)).not.toContain(testDir);
	});

	test("malformed baseline findings exit 2 instead of producing partial output", async () => {
		const db = new CBrainDB(dbPath);
		db.close();
		writeFileSync(
			baselinePath,
			JSON.stringify({
				...cleanBaseline(),
				hard: [{ check: "sqlite.page_without_chunks", layer: "sqlite", count: "1", samples: ["item_1"] }],
			}),
		);
		const { exitCode, json, stderr } = await runGate();
		expect(exitCode).toBe(2);
		expect(stderr).toBe("");
		expect(json.passed).toBe(false);
		expect(json.status).toBe("fail");
		expect(String(json.next_action)).toContain("baseline");
		expect(JSON.stringify(json)).not.toContain(baselinePath);
		expect(JSON.stringify(json)).not.toContain(testDir);
	});
});
