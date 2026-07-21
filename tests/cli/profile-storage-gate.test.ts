import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

// #379: bin/check-profile-storage-gate.ts is the OPERATOR profile-health
// gate, separated from the repository release gate. It requires an explicit
// configuration target (cbrain.json or CBRAIN_CONFIG) and fails closed with
// a sanitized error when absent/invalid/malformed.
//
// Public report schema uses a distinct stable id `profile-storage-consistency`
// so consumers can distinguish it from the repository `consistency` gate.

describe("bin/check-profile-storage-gate.ts operator profile gate (#379)", () => {
	let testDir: string;
	let configPath: string;
	let dbPath: string;
	let vaultPath: string;
	let lancePath: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "cbrain-profile-gate-"));
		configPath = join(testDir, "cbrain.json");
		dbPath = join(testDir, "test.sqlite");
		vaultPath = join(testDir, "vault");
		lancePath = join(testDir, "lance");
		mkdirSync(vaultPath, { recursive: true });
	});
	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	async function runGate(env?: Record<string, string>): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string; stderr: string }> {
		const binPath = join(process.cwd(), "bin/check-profile-storage-gate.ts");
		const proc = Bun.spawn(["bun", binPath], {
			cwd: testDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// The gate may emit a fixed string on fatal errors (no JSON); guard parse.
		let json: Record<string, unknown> = {};
		try {
			json = JSON.parse(stdout);
		} catch {
			json = { _raw: stdout };
		}
		return { exitCode, json, stdout, stderr };
	}

	test("missing configuration → fail closed, exit 2, sanitized reason", async () => {
		// No cbrain.json in cwd, no CBRAIN_CONFIG. Must fail closed with a
		// stable reason code and MUST NOT echo operator paths.
		const { exitCode, json, stdout } = await runGate({ CBRAIN_CONFIG: "" });
		expect(exitCode).toBe(2);
		expect(json.gate).toBe("profile-storage-consistency");
		expect(json.passed).toBe(false);
		expect(json.status).toBe("profile_target_missing");
		expect(typeof json.next_action).toBe("string");
		// Privacy: no raw cwd leak
		expect(stdout).not.toContain(testDir);
	});

	test("malformed configuration → fail closed, exit 2, sanitized reason", async () => {
		writeFileSync(configPath, "{ not valid json");
		const { exitCode, json, stdout } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(2);
		expect(json.gate).toBe("profile-storage-consistency");
		expect(json.status).toBe("profile_target_invalid");
		expect(json.passed).toBe(false);
		// Privacy: must not echo the raw config path or parse error
		expect(stdout).not.toContain(configPath);
		expect(stdout).not.toContain("JSON");
	});

	test("configured DB not present → fail closed, exit 2, sanitized reason", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		// Do NOT create dbPath — gate must report missing target, not crash.
		const { exitCode, json, stdout } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(2);
		expect(json.gate).toBe("profile-storage-consistency");
		expect(json.status).toBe("profile_db_missing");
		expect(json.passed).toBe(false);
		expect(stdout).not.toContain(dbPath);
	});

	test("clean profile DB → passed:true, exit 0, distinct gate id", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		const db = new CBrainDB(dbPath);
		db.close();
		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(0);
		expect(json.gate).toBe("profile-storage-consistency");
		expect(json.mode).toBe("operator-profile");
		expect(json.passed).toBe(true);
		expect(Array.isArray(json.hard)).toBe(true);
		// Distinct stable id vs repository gate (which is "consistency")
		expect(json.gate).not.toBe("consistency");
	});

	test("inconsistent profile DB (page without chunks) → passed:false, exit 1, hard finding", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		const db = new CBrainDB(dbPath);
		mkdirSync(join(vaultPath, "entities"), { recursive: true });
		writeFileSync(
			join(vaultPath, "entities/a.md"),
			`---\ntitle: "A"\ntype: entity/person\nslug: entities/a\n---\nbody\n`,
		);
		db.upsertPage({
			slug: "entities/a",
			type: "entity/person",
			title: "A",
			filePath: "entities/a.md",
			contentHash: "h-a",
		});
		db.close();
		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(1);
		expect(json.passed).toBe(false);
		const hard = json.hard as Array<{ check: string }>;
		expect(hard.some((h) => h.check === "sqlite.page_without_chunks")).toBe(true);
		// Privacy: slug anonymized
		expect(JSON.stringify(json)).not.toContain("entities/a");
	});
});
