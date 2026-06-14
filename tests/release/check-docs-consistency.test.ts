import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "url";
import { expect, test } from "bun:test";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(PROJECT_DIR, "bin/check-docs-consistency.ts");

interface RunResult {
  stdout: string;
  code: number;
}

function runCheck(env: Record<string, string> = {}, args: string[] = []): RunResult {
  try {
    const stdout = execSync(`bun "${SCRIPT}" ${args.join(" ")}`, {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    return { stdout, code: 0 };
  } catch (e: unknown) {
    const err = e as { stdout?: string | Buffer; status?: number };
    return { stdout: (err.stdout ?? "").toString(), code: err.status ?? 1 };
  }
}

function withTmpDocs(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-docs-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
}

test("real docs pass the consistency gate", () => {
  const { stdout, code } = runCheck();
  expect(code).toBe(0);
  expect(stdout).toContain("Verdict: PASS");
});

test("fails when a doc claims a stale tool count", () => {
  withTmpDocs(
    {
      "mcp-tools.md": "> 999 个 MCP 工具\n",
      "usage.md": "no commands here\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("tool count");
      expect(stdout).toContain("999");
    },
  );
});

test("fails on non-existent commands in both inline code and fenced blocks", () => {
  withTmpDocs(
    {
      "usage.md": "Run `cbrain bogus-command` inline.\n\n```bash\ncbrain watch\n```\n",
      "mcp-tools.md": "no tools here\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("bogus-command");
      expect(stdout).toContain("watch");
    },
  );
});

test("fails when a doc uses bare `cbrain sync --reindex` without --slug", () => {
  withTmpDocs(
    {
      "usage.md": "Recover with `cbrain sync --reindex` now.\n",
      "mcp-tools.md": "no tools here\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("sync recovery");
      expect(stdout).toContain("--slug");
    },
  );
});

test("passes the three valid sync recovery scopes on one line", () => {
  withTmpDocs(
    {
      "usage.md":
        "Recover: `cbrain sync --slug x --reindex`; `cbrain sync --reindex-quarantined`; `cbrain sync --reindex-vectors`.\n",
      "mcp-tools.md": "no tools here\n",
    },
    (dir) => {
      const { stdout } = runCheck({ DOCS_DIR: dir });
      expect(stdout).toContain("sync recovery combos");
      expect(stdout).not.toMatch(/sync recovery @.*FAILED/);
    },
  );
});

test("--update is idempotent and never touches the real checkout", () => {
  const realMcpBefore = readFileSync(join(PROJECT_DIR, "docs/mcp-tools.md"), "utf-8");
  const realUsageBefore = readFileSync(join(PROJECT_DIR, "docs/usage.md"), "utf-8");

  withTmpDocs(
    {
      "mcp-tools.md": "<!-- cbrain:auto-gen mcp-tools:start -->\nOLD\n<!-- cbrain:auto-gen mcp-tools:end -->\n",
      "usage.md": "<!-- cbrain:auto-gen cli-commands:start -->\nOLD\n<!-- cbrain:auto-gen cli-commands:end -->\n",
    },
    (dir) => {
      runCheck({ DOCS_DIR: dir }, ["--update"]);
      const first = readFileSync(join(dir, "mcp-tools.md"), "utf-8");
      // OLD placeholder was replaced with the real generated inventory
      expect(first).not.toContain("\nOLD\n");
      expect(first).toContain("共");

      // Second --update in the same tmp dir changes nothing (idempotent)
      runCheck({ DOCS_DIR: dir }, ["--update"]);
      const second = readFileSync(join(dir, "mcp-tools.md"), "utf-8");
      expect(second).toBe(first);
    },
  );

  // The real checkout is byte-for-byte untouched
  expect(readFileSync(join(PROJECT_DIR, "docs/mcp-tools.md"), "utf-8")).toBe(realMcpBefore);
  expect(readFileSync(join(PROJECT_DIR, "docs/usage.md"), "utf-8")).toBe(realUsageBefore);
});

test("fails when a doc pins a stale version tag", () => {
  withTmpDocs(
    {
      "mcp-tools.md": "> Requires #v0.1.0 — very old release.\n",
      "usage.md": "no commands here\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("version");
      expect(stdout).toContain("0.1.0");
    },
  );
});

test("fails when a doc claims an unsupported install method", () => {
  withTmpDocs(
    {
      "mcp-tools.md": "Install via `brew install cbrain` today!\n",
      "usage.md": "no commands here\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("install claim");
      expect(stdout).toContain("brew install cbrain");
    },
  );
});

test("fails when a doc references a non-existent MCP tool", () => {
  withTmpDocs(
    {
      "mcp-tools.md": "## Tools\n\n| Tool | Description |\n|------|------|\n| `put_raw_data` | phantom tool |\n",
      "usage.md": "no commands here\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("tool ref");
      expect(stdout).toContain("put_raw_data");
    },
  );
});

test("fails when a CLI command masquerades as an MCP tool", () => {
  withTmpDocs(
    {
      "mcp-tools.md": "## Tools\n\n| Tool | Description |\n|------|------|\n| `backup` | not a tool |\n",
      "usage.md": "no commands here\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({ DOCS_DIR: dir });
      expect(code).toBe(1);
      expect(stdout).toContain("tool ref");
      expect(stdout).toContain("backup");
    },
  );
});

test("fails when a skill index references a phantom MCP tool on a 工具 line", () => {
  withTmpDocs(
    {
      "usage.md": "no commands here\n",
      "mcp-tools.md": "no tools here\n",
      "feature-index.md":
        "### 1. 反馈\n- **工具**：`submit_feedback(type, content)` — phantom\n",
    },
    (dir) => {
      const { stdout, code } = runCheck({
        DOCS_DIR: dir,
        SKILLS_INDEX: join(dir, "feature-index.md"),
      });
      expect(code).toBe(1);
      expect(stdout).toContain("skill tool ref");
      expect(stdout).toContain("submit_feedback");
    },
  );
});
