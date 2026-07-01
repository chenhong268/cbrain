import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "../..");
const WRAPPER = join(PROJECT_DIR, "bin", "cbrain-maintenance.sh");
const PATROL = join(PROJECT_DIR, "bin", "daily-patrol.sh");

/** Bind to port 0, release it, return the now-free (dead) port. */
function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
    s.on("error", reject);
  });
}

function runWrapper(url: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("bash", [WRAPPER, "dream"], {
      env: { ...process.env, CBRAIN_MCP_URL: url },
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    return {
      code: err.status ?? 1,
      stdout: (err.stdout ?? "").toString(),
      stderr: (err.stderr ?? "").toString(),
    };
  }
}

describe("bin/cbrain-maintenance.sh — single-writer wrapper (#212, #234)", () => {
  test("shell syntax is clean (bash -n)", () => {
    const code = execFileSync("bash", ["-n", WRAPPER], { encoding: "utf-8" });
    expect(code).toBe("");
  });

  test("daily-patrol.sh shell syntax is clean (bash -n)", () => {
    const code = execFileSync("bash", ["-n", PATROL], { encoding: "utf-8" });
    expect(code).toBe("");
  });

  test("fails fast (exit 1) when the service is unavailable — bails at health, never spawns a writer", async () => {
    const port = await deadPort();
    const { code, stderr } = runWrapper(`http://127.0.0.1:${port}/mcp`);
    expect(code).toBe(1);
    // The wrapper distinguishes service-down from protocol failure: a dead port
    // trips the /health probe first and reports "未运行", so it never reaches
    // MCP initialize or tools/call. The wrapper is curl-only by construction
    // (it never execs a CBrain process), so it cannot spawn a competing writer.
    expect(stderr).toContain("未运行");
  });

  test("wrapper is curl-only — never invokes a CBrain CLI process", () => {
    const src = readFileSync(WRAPPER, "utf-8");
    // No non-comment line execs `cbrain ...` (the only runtime interaction is curl).
    const offenders = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => /^\s*[a-z]*\s*cbrain\s+(compact|dream|enrich|dedup|discover|sync)\b/.test(l));
    expect(offenders).toEqual([]);
  });

  test("declares X-CBrain-Tool-Profile: maintenance on every MCP request (#260)", () => {
    const src = readFileSync(WRAPPER, "utf-8");
    // Three MCP curl calls: initialize, notifications/initialized, tools/call.
    // Each must carry the profile header so the per-session runtime assigns maintenance.
    const profileHeaders = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .filter((l) => l.includes("X-CBrain-Tool-Profile: maintenance"));
    // initialize + notifications/initialized + tools/call = 3
    expect(profileHeaders.length).toBe(3);
  });
});
