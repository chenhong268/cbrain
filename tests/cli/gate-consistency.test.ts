import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

// #279 e2e: spawn bin/check-consistency-gate.ts against a fixture config + DB.
// Locks the gate JSON schema, exit codes, and privacy (no raw path leak).

describe("bin/check-consistency-gate.ts e2e (#279)", () => {
	let testDir: string;
	let configPath: string;
	let dbPath: string;
	let vaultPath: string;
	let lancePath: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "cbrain-gate-e2e-"));
		configPath = join(testDir, "cbrain.json");
		dbPath = join(testDir, "test.sqlite");
		vaultPath = join(testDir, "vault");
		lancePath = join(testDir, "lance");
		mkdirSync(vaultPath, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
	});
	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	async function runGate(): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string }> {
		const proc = Bun.spawn(["bun", "bin/check-consistency-gate.ts"], {
			cwd: process.cwd(),
			env: { ...process.env, CBRAIN_CONFIG: configPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			proc.exited,
		]);
		return { exitCode, json: JSON.parse(stdout), stdout };
	}

	test("clean DB → passed:true, exit 0, schema locked", async () => {
		const db = new CBrainDB(dbPath);
		db.close();
		const { exitCode, json } = await runGate();
		expect(exitCode).toBe(0);
		expect(json.gate).toBe("consistency");
		expect(json.passed).toBe(true);
		expect(Array.isArray(json.hard)).toBe(true);
		expect(Array.isArray(json.warnings)).toBe(true);
		expect(typeof json.lanceState).toBe("string");
		expect(typeof json.next_action).toBe("string");
		expect(json.fatalError).toBeUndefined(); // raw fatalError NOT emitted (privacy)
		// privacy: no local path leak
		expect(JSON.stringify(json)).not.toContain(testDir);
	});

	test("page_without_chunks → passed:false, exit 1, hard lists it", async () => {
		const db = new CBrainDB(dbPath);
		mkdirSync(join(vaultPath, "entities"), { recursive: true });
		writeFileSync(join(vaultPath, "entities/a.md"), `---\ntitle: "A"\ntype: entity/person\nslug: entities/a\n---\nbody\n`);
		db.upsertPage({ slug: "entities/a", type: "entity/person", title: "A", filePath: "entities/a.md", contentHash: "h-a" });
		// no chunks seeded → page_without_chunks finding
		db.close();
		const { exitCode, json } = await runGate();
		expect(exitCode).toBe(1);
		expect(json.passed).toBe(false);
		const hard = json.hard as Array<{ check: string }>;
		expect(hard.some((h) => h.check === "sqlite.page_without_chunks")).toBe(true);
		// privacy: slug anonymized (item_N), raw slug not in output
		expect(JSON.stringify(json)).not.toContain("entities/a");
	});

	test("missing DB → exit 2, fatal next_action, no raw path leak", async () => {
		// Do NOT create the DB file — bin/ should exit 2 with a fixed-string next_action.
		const { exitCode, json } = await runGate();
		expect(exitCode).toBe(2);
		expect(json.passed).toBe(false);
		expect(typeof json.next_action).toBe("string");
		// next_action must not interpolate the raw dbPath
		expect(JSON.stringify(json.next_action)).not.toContain(dbPath);
	});
});
