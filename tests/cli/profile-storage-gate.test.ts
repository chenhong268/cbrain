import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";

// #379 + #384 review: bin/check-profile-storage-gate.ts is the OPERATOR
// profile-health gate. It must:
//   (P1-1) require an EXPLICIT target (CBRAIN_CONFIG or --config <path>);
//          auto-discovery is disabled — a decoy cbrain.json in cwd must not
//          be adopted.
//   (P1-2) open the live DB READ-ONLY via the snapshot path; live DB bytes
//          and WAL/SHM must not change.
//   (P1-3) require dbPath, vaultPath, AND lancePath as non-empty strings.
//
// Public report schema uses a distinct stable id `profile-storage-consistency`
// so consumers can distinguish it from the repository `consistency` gate.

const SANDBOX_PREFIX = "cbrain-profile-sandbox-";

describe("bin/check-profile-storage-gate.ts operator profile gate (#379, #384)", () => {
	let testDir: string;
	let configPath: string;
	let dbPath: string;
	let vaultPath: string;
	let lancePath: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
		configPath = join(testDir, "cbrain.json");
		dbPath = join(testDir, "test.sqlite");
		vaultPath = join(testDir, "vault");
		lancePath = join(testDir, "lance");
		mkdirSync(vaultPath, { recursive: true });
	});
	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	async function hashFile(p: string): Promise<string> {
		const buf = await readFile(p);
		return createHash("sha256").update(buf).digest("hex");
	}

	async function runGate(env?: Record<string, string>, args: readonly string[] = []): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string; stderr: string }> {
		const binPath = join(process.cwd(), "bin/check-profile-storage-gate.ts");
		const proc = Bun.spawn(["bun", binPath, ...args], {
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
		let json: Record<string, unknown> = {};
		try {
			json = JSON.parse(stdout);
		} catch {
			json = { _raw: stdout };
		}
		return { exitCode, json, stdout, stderr };
	}

	test("(P1-1) no explicit target → profile_target_missing, exit 2", async () => {
		// Drop a decoy cbrain.json in cwd. Auto-discovery MUST NOT pick it up.
		writeFileSync(
			join(testDir, "cbrain.json"),
			JSON.stringify({ dbPath, vaultPath, lancePath }),
		);
		const { exitCode, json, stdout } = await runGate({ CBRAIN_CONFIG: "" });
		expect(exitCode).toBe(2);
		expect(json.gate).toBe("profile-storage-consistency");
		expect(json.passed).toBe(false);
		expect(json.status).toBe("profile_target_missing");
		expect(typeof json.next_action).toBe("string");
		expect(stdout).not.toContain(testDir);
	});

	test("(P1-1) --config <path> is honored as an explicit target", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		const db = new CBrainDB(dbPath);
		db.close();
		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: "" }, ["--config", configPath]);
		expect(exitCode).toBe(0);
		expect(json.status).toBe("profile_checked");
		expect(json.passed).toBe(true);
	});

	test("malformed JSON → profile_target_invalid, exit 2, no path/JSON leak", async () => {
		writeFileSync(configPath, "{ not valid json");
		const { exitCode, json, stdout } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(2);
		expect(json.status).toBe("profile_target_invalid");
		expect(json.passed).toBe(false);
		expect(stdout).not.toContain(configPath);
		expect(stdout).not.toContain("JSON");
	});

	test("(P1-3) missing vaultPath → profile_target_invalid", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, lancePath }));
		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(2);
		expect(json.status).toBe("profile_target_invalid");
	});

	test("(P1-3) missing lancePath → profile_target_invalid", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath }));
		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(2);
		expect(json.status).toBe("profile_target_invalid");
	});

	test("(P1-3) blank-string vaultPath → profile_target_invalid", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath: "", lancePath }));
		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(2);
		expect(json.status).toBe("profile_target_invalid");
	});

	test("configured DB not present → profile_db_missing, exit 2, no path leak", async () => {
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		const { exitCode, json, stdout } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(2);
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
		expect(json.gate).not.toBe("consistency");
	});

	test("(P1-2) live DB + WAL + SHM are unchanged after the gate runs", async () => {
		// Seed a real profile with a page so the snapshot path actually has
		// to copy WAL contents, not just an empty DB. Do NOT seed chunks —
		// this gate runs the full fsck including fts + lance layers, and a
		// chunk without matching FTS/Lance entries would itself be a hard
		// finding unrelated to the read-only invariant under test.
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		const db = new CBrainDB(dbPath);
		mkdirSync(join(vaultPath, "entities"), { recursive: true });
		const md = "---\nslug: entities/anon\ntitle: Anon\ntype: entity/person\n---\nbody\n";
		writeFileSync(join(vaultPath, "entities", "anon.md"), md);
		db.upsertPage({
			slug: "entities/anon",
			type: "entity/person",
			title: "Anon",
			filePath: "entities/anon.md",
			contentHash: createHash("sha256").update(md).digest("hex"),
		});
		db.checkpoint(); // flush WAL into main DB so the live state is stable
		db.close();

		async function snapshotLive(): Promise<string> {
			const parts: string[] = [];
			for (const suffix of ["", "-wal", "-shm"]) {
				const p = `${dbPath}${suffix}`;
				if (existsSync(p)) parts.push(`${suffix}:${await hashFile(p)}`);
			}
			return parts.join("|");
		}

		const before = await snapshotLive();
		// The gate MAY surface warnings; the invariant under test is that the
		// live bytes are unchanged — not that the profile is release-clean.
		const { exitCode, stdout } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).not.toBe(2); // not fatal
		const after = await snapshotLive();
		expect(after).toBe(before);
		expect(stdout).not.toContain(dbPath);
	});

	test("inconsistent profile DB (page without chunks) → passed:false, exit 1, hard finding", async () => {
		// page_without_chunks is a fsck WARNING by default; the operator
		// gate still routes it into hard[] via evaluateConsistencyGate, so
		// the gate reports passed:false, exit 1.
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		const db = new CBrainDB(dbPath);
		mkdirSync(join(vaultPath, "entities"), { recursive: true });
		writeFileSync(
			join(vaultPath, "entities/anon.md"),
			`---\nslug: entities/anon\ntitle: Anon\ntype: entity/person\n---\nbody\n`,
		);
		db.upsertPage({
			slug: "entities/anon",
			type: "entity/person",
			title: "Anon",
			filePath: "entities/anon.md",
			contentHash: "h-anon",
		});
		db.close();
		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: configPath });
		expect(exitCode).toBe(1);
		expect(json.passed).toBe(false);
		const hard = json.hard as Array<{ check: string }>;
		expect(hard.some((h) => h.check === "sqlite.page_without_chunks")).toBe(true);
		expect(JSON.stringify(json)).not.toContain("entities/anon");
	});

	test("(P1-3) trusted vault boundary is constructed and passed into fsck", async () => {
		// Build a profile whose configRoot is an Obsidian vault (has
		// .obsidian/ as a real dir) so resolveTrustedVaultBoundary returns a
		// boundary. Drop a misplaced artifact at configRoot and verify the
		// vault layer actually ran (we can see a vault.* finding). If the
		// boundary were skipped, no vault finding would appear.
		const obsidianDir = join(testDir, ".obsidian");
		mkdirSync(obsidianDir, { recursive: true });
		writeFileSync(join(testDir, "stray-anon.md"), "");
		writeFileSync(configPath, JSON.stringify({ dbPath, vaultPath, lancePath }));
		const db = new CBrainDB(dbPath);
		db.close();

		const { exitCode, json } = await runGate({ CBRAIN_CONFIG: configPath });
		const checks = [
			...((json.hard as Array<{ check: string }>) ?? []),
			...((json.warnings as Array<{ check: string }>) ?? []),
		].map((c) => c.check);
		expect(
			checks.some((c) => c.startsWith("vault.")),
			`expected a vault.* finding (hard or warning); got ${JSON.stringify(checks)}`,
		).toBe(true);
		expect(json.gate).toBe("profile-storage-consistency");
		expect(json.mode).toBe("operator-profile");
		expect(exitCode).not.toBe(2);
	});
});
