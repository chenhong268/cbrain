import { describe, test, expect } from "bun:test";
import { readdirSync, rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #379 e2e: bin/check-consistency-gate.ts is a REPOSITORY release gate — it
// must run from a clean checkout with NO operator cbrain.json and use an
// anonymous in-process fixture DB. It must NOT discover or read operator
// vault/SQLite/LanceDB or credential-bearing config.
//
// After #384 review:
// - the gate exercises a HEALTHY non-empty fixture AND a negative canary
//   whose expected hard finding is verified (otherwise the gate reports
//   negative_canary_regression);
// - fixture cleanup is asserted against tmpdir (the process.exit bug that
//   skipped the finally is gone).

const SANDBOX_PREFIX = "cbrain-sandbox-repo-gate-";
const FIXTURE_PREFIX = "cbrain-consistency-";

describe("bin/check-consistency-gate.ts repository fixture gate (#379, #384)", () => {
	function makeSandbox(): string {
		return mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
	}
	function cleanup(dir: string): void {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
	function listFixtureDirs(): string[] {
		return readdirSync(tmpdir()).filter((n) => n.startsWith(FIXTURE_PREFIX)).sort();
	}

	async function runGate(cwd: string): Promise<{ exitCode: number; json: Record<string, unknown>; stdout: string; stderr: string }> {
		const binPath = join(process.cwd(), "bin/check-consistency-gate.ts");
		const proc = Bun.spawn(["bun", binPath], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CBRAIN_CONFIG: "" },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, json: JSON.parse(stdout), stdout, stderr };
	}

	test("clean checkout (no cbrain.json) → passed:true, exit 0, negative canary detected", async () => {
		const sandbox = makeSandbox();
		try {
			const { exitCode, json } = await runGate(sandbox);
			expect(exitCode).toBe(0);
			expect(json.gate).toBe("consistency");
			expect(json.mode).toBe("repository-fixture");
			expect(json.passed).toBe(true);
			expect(json.status).toBe("negative_canary_detected");
			expect(Array.isArray(json.hard)).toBe(true);
			expect(Array.isArray(json.warnings)).toBe(true);
			expect(typeof json.lanceState).toBe("string");
			expect(typeof json.next_action).toBe("string");
			expect(json.fatalError).toBeUndefined();
			const canary = json.canary as { expected_hard_check: string; detected: boolean };
			expect(canary.expected_hard_check).toBe("sqlite.page_without_chunks");
			expect(canary.detected).toBe(true);
			// Privacy: no sandbox path leak
			expect(JSON.stringify(json)).not.toContain(sandbox);
		} finally {
			cleanup(sandbox);
		}
	});

	test("does not read operator cbrain.json even when CBRAIN_CONFIG points at one", async () => {
		const sandbox = makeSandbox();
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
			// Decoy dbPath was never opened (otherwise gate would exit 2 on missing DB).
			expect(existsSync(bogusDb)).toBe(false);
		} finally {
			cleanup(sandbox);
		}
	});

	test("removes its own fixture artifacts across success and repeated runs (no tmpdir leak)", async () => {
		// Snapshot tmpdir BEFORE running. The old process.exit() version
		// leaked a cbrain-consistency-* dir on every run; this assertion
		// catches that regression deterministically.
		const before = listFixtureDirs();
		const sandboxes: string[] = [];
		try {
			for (let i = 0; i < 3; i++) {
				const s = makeSandbox();
				sandboxes.push(s);
				await runGate(s);
			}
		} finally {
			for (const s of sandboxes) cleanup(s);
		}
		expect(listFixtureDirs()).toEqual(before);
	});
});
