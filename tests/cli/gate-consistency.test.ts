import { describe, test, expect } from "bun:test";
import { rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #379 e2e: bin/check-consistency-gate.ts is a REPOSITORY release gate — it
// must run from a clean checkout with NO operator cbrain.json and use an
// anonymous in-process fixture DB. It must NOT discover or read operator
// vault/SQLite/LanceDB or credential-bearing config.
//
// Locks: clean-checkout runnability, JSON schema, fixture mode marker, and
// privacy (no local path leak).

describe("bin/check-consistency-gate.ts repository fixture gate (#379)", () => {
	// A single sandbox per test keeps the test hermetic; the gate creates its
	// OWN fixture DB inside, so we only need an empty cwd with no cbrain.json.
	let sandbox: string;
	function makeSandbox(): string {
		const dir = mkdtempSync(join(tmpdir(), "cbrain-consistency-repo-"));
		// Intentionally NO cbrain.json — proves release gate is checkout-clean.
		return dir;
	}
	function cleanup(dir: string): void {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}

	async function runGate(cwd: string): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string; stderr: string }> {
		const binPath = join(process.cwd(), "bin/check-consistency-gate.ts");
		const proc = Bun.spawn(["bun", binPath], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CBRAIN_CONFIG: "" }, // explicit: no operator config
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, json: JSON.parse(stdout), stdout, stderr };
	}

	test("clean checkout (no cbrain.json) → passed:true, exit 0, mode=repository-fixture", async () => {
		sandbox = makeSandbox();
		try {
			const { exitCode, json } = await runGate(sandbox);
			expect(exitCode).toBe(0);
			expect(json.gate).toBe("consistency");
			expect(json.mode).toBe("repository-fixture");
			expect(json.passed).toBe(true);
			expect(Array.isArray(json.hard)).toBe(true);
			expect(Array.isArray(json.warnings)).toBe(true);
			expect(typeof json.lanceState).toBe("string");
			expect(typeof json.next_action).toBe("string");
			expect(json.fatalError).toBeUndefined();
			// Privacy: no local sandbox path leak
			expect(JSON.stringify(json)).not.toContain(sandbox);
		} finally {
			cleanup(sandbox);
		}
	});

	test("does not read operator cbrain.json even when one exists in cwd", async () => {
		// Drop a DECOY cbrain.json in cwd pointing at a bogus path. A
		// repository-owned release gate must ignore it and still produce the
		// clean-fixture result, proving it does not consume operator config.
		sandbox = makeSandbox();
		const bogusDb = join(sandbox, "does-not-exist.sqlite");
		writeFileSync(
			join(sandbox, "cbrain.json"),
			JSON.stringify({ dbPath: bogusDb, vaultPath: sandbox, lancePath: sandbox }),
		);
		try {
			const { exitCode, json } = await runGate(sandbox);
			expect(exitCode).toBe(0);
			expect(json.mode).toBe("repository-fixture");
			expect(json.passed).toBe(true);
			// Decoy dbPath was never opened (otherwise gate would exit 2 on missing DB)
			expect(existsSync(bogusDb)).toBe(false);
		} finally {
			cleanup(sandbox);
		}
	});

	test("removes its own fixture artifacts (no DB/vault/lance files leaked into cwd)", async () => {
		sandbox = makeSandbox();
		try {
			const before = [...(await readDirShallow(sandbox)).keys()].sort();
			await runGate(sandbox);
			const after = [...(await readDirShallow(sandbox)).keys()].sort();
			expect(after.sort()).toEqual(before.sort());
		} finally {
			cleanup(sandbox);
		}
	});
});

async function readDirShallow(dir: string): Promise<Set<string>> {
	const { readdirSync } = await import("node:fs");
	try {
		return new Set(readdirSync(dir));
	} catch {
		return new Set();
	}
}
