import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFLIGHT_CHECKS } from "../../bin/check-v2-preflight.js";

// #379 + #384 contract: gate:v2-preflight is a REPOSITORY release gate. It
// must be runnable from a clean checkout with no operator cbrain.json. The
// `storage-consistency` sub-gate must NOT consume operator config — neither
// CBRAIN_CONFIG nor an auto-discovered cbrain.json.
//
// We exercise storage-consistency in isolation so the full preflight (which
// is slow and runs many sub-gates) stays out of the focused suite.

const SANDBOX_PREFIX = "cbrain-preflight-decouple-";

describe("gate:v2-preflight storage-consistency decoupling (#379, #384)", () => {
	let sandbox: string;

	beforeEach(() => {
		sandbox = mkdtempSync(join(tmpdir(), SANDBOX_PREFIX));
	});
	afterEach(() => {
		if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
	});

	async function runStorageGate(env?: Record<string, string>): Promise<{
		exitCode: number;
		json: Record<string, unknown>;
		stdout: string;
		stderr: string;
	}> {
		const storage = DEFAULT_PREFLIGHT_CHECKS.find((c) => c.id === "storage-consistency");
		if (!storage) throw new Error("storage-consistency not registered");
		// Run from the repository root (same cwd the v2-preflight aggregator
		// uses), so `bun run gate:consistency` resolves the package script.
		const proc = Bun.spawn([...storage.command], {
			cwd: process.cwd(),
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

	test("storage-consistency sub-gate is registered and still required", () => {
		const storage = DEFAULT_PREFLIGHT_CHECKS.find((c) => c.id === "storage-consistency");
		expect(storage, "storage-consistency must remain registered").toBeDefined();
		expect(storage?.required).toBe(true);
		expect(storage?.command).toEqual(["bun", "run", "gate:consistency"]);
	});

	test("storage-consistency sub-gate runs cleanly with no operator cbrain.json", async () => {
		const { exitCode, json, stderr } = await runStorageGate({ CBRAIN_CONFIG: "" });
		expect(exitCode, `stderr=${stderr}`).toBe(0);
		expect(json.mode).toBe("repository-fixture");
		expect(json.passed).toBe(true);
		expect(json.status).toBe("negative_canary_detected");
	});

	test("v2-preflight contains no sub-gate whose command references gate:profile-storage", () => {
		const offenders = DEFAULT_PREFLIGHT_CHECKS.filter((c) =>
			c.command.some((arg) => typeof arg === "string" && arg.includes("gate:profile-storage")),
		);
		expect(offenders, "profile-storage must not be a preflight sub-gate").toEqual([]);
	});

	test("storage-consistency sub-gate ignores a decoy operator cbrain.json", async () => {
		// Drop a decoy cbrain.json + point CBRAIN_CONFIG at it. The repository
		// gate must NOT consult it and must still produce the fixture result.
		writeFileSync(
			join(sandbox, "cbrain.json"),
			JSON.stringify({
				dbPath: join(sandbox, "decoy-does-not-exist.sqlite"),
				vaultPath: sandbox,
				lancePath: sandbox,
			}),
		);
		const { exitCode, json } = await runStorageGate({
			CBRAIN_CONFIG: join(sandbox, "cbrain.json"),
		});
		expect(exitCode).toBe(0);
		expect(json.mode).toBe("repository-fixture");
		expect(json.passed).toBe(true);
		expect(existsSync(join(sandbox, "decoy-does-not-exist.sqlite"))).toBe(false);
	});
});
