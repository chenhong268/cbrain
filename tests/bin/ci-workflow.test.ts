import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WORKFLOW_PATH = join(import.meta.dir, "..", "..", ".github", "workflows", "ci.yml");
const WORKFLOW = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, "utf-8") : "";
const CHECKLIST_PATH = join(import.meta.dir, "..", "..", "docs", "product", "v2-rc-release-checklist.md");
const CHECKLIST = existsSync(CHECKLIST_PATH) ? readFileSync(CHECKLIST_PATH, "utf-8") : "";

/** Extract one bullet block from `text`: from `startMarker` up to (excluding) `nextMarker`. */
function extractBullet(text: string, startMarker: string, nextMarker: string): string {
  const start = text.indexOf(startMarker);
  if (start < 0) return "";
  const end = text.indexOf(nextMarker, start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

describe(".github/workflows/ci.yml contract", () => {
  test("file exists", () => {
    expect(existsSync(WORKFLOW_PATH)).toBe(true);
  });

  test("triggers on pull_request", () => {
    expect(WORKFLOW).toMatch(/pull_request:/);
  });

  test("triggers on push to main", () => {
    expect(WORKFLOW).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
  });

  test("uses oven-sh/setup-bun@v2", () => {
    expect(WORKFLOW).toContain("oven-sh/setup-bun@v2");
  });

  test("installs with frozen lockfile", () => {
    expect(WORKFLOW).toContain("bun install --frozen-lockfile");
  });

  test("runs the ci script", () => {
    expect(WORKFLOW).toContain("bun run check:ci");
  });

  test("declares least-privilege contents:read permission", () => {
    expect(WORKFLOW).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  test("does not require secrets", () => {
    expect(WORKFLOW).not.toContain("secrets.");
  });

  test("does not reference private/local paths", () => {
    expect(WORKFLOW).not.toMatch(/\/Users\/|\/Volumes\/|\\Users\\/);
  });

  test("does not depend on Hermes / LLM / provider env vars", () => {
    // Matches env-var-style identifiers (FOO_KEY, BAR_TOKEN), not prose mentions.
    expect(WORKFLOW).not.toMatch(/\b(HERMES|LLM|OPENAI|DEEPSEEK|ZHIPU|ANTHROPIC)_[A-Z]/);
  });

  // ── #380 Stage 4: dependency advisory gate wiring ──

  test("check:ci and gate:dependencies are each a complete single-line YAML run step", () => {
    // Strict whole-line match: the command occupies the entire YAML line, so
    // `; true`, `|| true`, multiline `run: |`, and line-continuation all fail.
    expect(WORKFLOW).toMatch(/^\s+run: bun run check:ci\s*$/m);
    expect(WORKFLOW).toMatch(/^\s+run: bun run gate:dependencies\s*$/m);
  });

  test("line-anchored run match rejects fail-open mutations on the gate step", () => {
    const evil = [
      "      run: bun run gate:dependencies; true",
      "      run: bun run gate:dependencies || true",
      "      run: |\n        bun run gate:dependencies\n        true",
    ];
    for (const e of evil) {
      expect(e).not.toMatch(/^\s+run: bun run gate:dependencies\s*$/m);
    }
  });

  test("dependency advisory gate runs exactly once, after frozen install", () => {
    const matches = WORKFLOW.match(/run: bun run gate:dependencies/g) ?? [];
    expect(matches.length).toBe(1);
    const installIdx = WORKFLOW.indexOf("bun install --frozen-lockfile");
    const gateIdx = WORKFLOW.indexOf("run: bun run gate:dependencies");
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(gateIdx).toBeGreaterThan(installIdx);
  });

  test("workflow has no continue-on-error or || true fail-open", () => {
    expect(WORKFLOW).not.toMatch(/continue-on-error/);
    expect(WORKFLOW).not.toMatch(/\|\|\s*true/);
  });
});

describe("v2-rc-release-checklist.md contract (#380)", () => {
  test("dependency gate is described as network-backed", () => {
    expect(CHECKLIST).toMatch(/network-backed/);
  });
  test("dependency gate is explicitly NOT one of the eight offline preflight gates", () => {
    expect(CHECKLIST).toMatch(/NOT one of the eight offline preflight/);
  });
  test("documents exit 0 / 1 / 2 semantics", () => {
    expect(CHECKLIST).toMatch(/exit 0/);
    expect(CHECKLIST).toMatch(/exit 1/);
    expect(CHECKLIST).toMatch(/exit 2/);
  });
  test("exit 1 bullet (scoped) blocks the RC with full lifecycle causes", () => {
    const exit1 = extractBullet(CHECKLIST, "- **exit 1 / outcome=no-go**", "- **exit 2 / outcome=fatal**");
    expect(exit1.length).toBeGreaterThan(0);
    expect(exit1).toMatch(/blocks the RC/);
    expect(exit1).toMatch(/untriaged/);
    expect(exit1).toMatch(/expired/);
    expect(exit1).toMatch(/stale version or path/);
    expect(exit1).toMatch(/obsolete/);
    expect(exit1).toMatch(/unnecessary/);
  });

  test("exit 2 bullet (scoped) blocks the RC independently", () => {
    const exit2 = extractBullet(CHECKLIST, "- **exit 2 / outcome=fatal**", "\n## ");
    expect(exit2.length).toBeGreaterThan(0);
    expect(exit2).toMatch(/blocks the RC/);
  });

  test("exit 1 block assertion does not pass via exit 2 text (mutation guard)", () => {
    const mutated = CHECKLIST.replace(/(exit 1 \/ outcome=no-go\*\* — )blocks the RC/, "$1");
    const exit1 = extractBullet(mutated, "- **exit 1 / outcome=no-go**", "- **exit 2 / outcome=fatal**");
    expect(exit1).not.toMatch(/blocks the RC/);
  });
  test("states what the gate proves and does NOT prove", () => {
    expect(CHECKLIST).toMatch(/What it proves/);
    expect(CHECKLIST).toMatch(/What it does NOT prove/);
  });
  test("privacy line keeps dependency_path but forbids local fs/credentials/raw audit", () => {
    expect(CHECKLIST).toMatch(/canonical dependency paths/);
    expect(CHECKLIST).toMatch(/no local filesystem paths, credentials, advisory titles, registry URLs, or raw audit text/);
  });

  test("#380 obsolete cause covers advisory-gone AND installed-but-no-longer-vulnerable (docs contract)", () => {
    const exit1 = extractBullet(CHECKLIST, "- **exit 1 / outcome=no-go**", "- **exit 2 / outcome=fatal**");
    expect(exit1.length).toBeGreaterThan(0);
    expect(exit1).toMatch(/obsolete/);
    expect(exit1).toMatch(/no longer vulnerable/);
  });
});

// ── #381: PR-test ratchet — check:ci covers deterministic core/storage/mcp/http ──

describe("check:ci PR-test ratchet (#381)", () => {
  const PKG = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  };
  const CHECK_CI = PKG.scripts["check:ci"] ?? "";
  const CHECK = PKG.scripts["check"] ?? "";

  // The five dirs are the source of truth: every *.test.ts under them MUST run
  // in PR CI. Directory-form args (not per-file whitelists) let bun auto-discover
  // new test files, so a newly added tests/mcp/foo.test.ts can never silently
  // stay outside the gate.
  const EXPECTED_DIRS = ["tests/bin/", "tests/core/", "tests/storage/", "tests/mcp/", "tests/http/"];

  /** Parse check:ci as a simple `&&` chain. NOT a general shell parser — any
   *  control grammar beyond `&&` (|| ; | # newline), or env prefixes / quotes /
   *  variable expansion, fails closed. A segment counts as the Bun test command
   *  ONLY if it STARTS with `bun test` (so an `echo bun test …` argument can
   *  never be mistaken for the command). Requires exactly one bun test segment. */
  function parseCheckCiChain(script: string): { segments: string[]; bunTestArgs: string[] | null } {
    if (/[|;#\n]/.test(script)) return { segments: [], bunTestArgs: null };
    const segments = script.split("&&").map((s) => s.trim()).filter((s) => s.length > 0);
    const bunTestSegs = segments.filter((s) => /^bun\s+test(?:\s|$)/.test(s));
    if (bunTestSegs.length !== 1) return { segments, bunTestArgs: null };
    return { segments, bunTestArgs: bunTestSegs[0].split(/\s+/).slice(2) };
  }

  test("check:ci is exactly: lint && check:docs && gate:recall-quality && bun test <five dirs>", () => {
    const parsed = parseCheckCiChain(CHECK_CI);
    expect(parsed.bunTestArgs).not.toBeNull();
    expect(parsed.segments).toEqual([
      "bun run lint",
      "bun run check:docs",
      "bun run gate:recall-quality",
      `bun test ${EXPECTED_DIRS.join(" ")}`,
    ]);
    expect([...parsed.bunTestArgs ?? []].sort()).toEqual([...EXPECTED_DIRS].sort());
  });

  test("check:ci rejects non-&& grammar, displaced/multiple/missing bun test, and bypass args (mutation guards)", () => {
    const good = ["bun run lint", "bun run check:docs", "bun run gate:recall-quality", `bun test ${EXPECTED_DIRS.join(" ")}`] as const;
    const isGoodChain = (script: string): boolean => {
      const parsed = parseCheckCiChain(script);
      return parsed.bunTestArgs !== null
        && JSON.stringify(parsed.segments) === JSON.stringify(good)
        && JSON.stringify([...parsed.bunTestArgs].sort()) === JSON.stringify([...EXPECTED_DIRS].sort());
    };
    const evil: Array<{ name: string; script: string }> = [
      { name: "echo bun test before real bun test (Codex bypass)", script: "echo bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ && bun test tests/bin/ci-workflow.test.ts" },
      { name: "printf bun test displacement", script: "printf bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ && bun test tests/bin/ci-workflow.test.ts" },
      { name: "two real bun test segments", script: "bun run lint && bun test tests/bin/ tests/core/ && bun test tests/storage/ tests/mcp/ tests/http/" },
      { name: "||true fail-open", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/||true" },
      { name: "||   true (spaces)", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ ||   true" },
      { name: ";true", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ ;true" },
      { name: "; exit 0", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ ; exit 0" },
      { name: "single pipe", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ | cat" },
      { name: "comment", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ # note" },
      { name: "newline", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/\nbun run lint" },
      { name: "missing one dir", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/" },
      { name: "fake= option value", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ fake=tests/core/ tests/storage/ tests/mcp/ tests/http/" },
      { name: "diluting flag appended", script: "bun run lint && bun run check:docs && bun run gate:recall-quality && bun test tests/bin/ tests/core/ tests/storage/ tests/mcp/ tests/http/ --pass-with-no-tests" },
    ];
    for (const e of evil) {
      expect(isGoodChain(e.script), `${e.name}`).toBe(false);
    }
    // the real check:ci must remain a good chain
    expect(isGoodChain(CHECK_CI)).toBe(true);
  });

  test("check:ci uses directory form, not a per-file whitelist (new tests auto-discovered)", () => {
    // No individual .test.ts path enumerated under a target dir — that would be
    // a per-file whitelist and silently drop new files.
    const perFile = CHECK_CI.match(/tests\/(?:bin|core|storage|mcp|http)\/\S+\.test\.ts/g);
    expect(perFile ?? []).toEqual([]);
  });

  test("ci.yml declares a bounded job timeout", () => {
    expect(WORKFLOW).toMatch(/timeout-minutes:\s*\d+/);
  });

  test("bun run check (full/release gate) is not weakened — still runs the whole suite", () => {
    expect(CHECK).toContain("bun run lint");
    expect(CHECK).toContain("bun test");
    // `check` runs the whole suite (no dir filter); it must not be narrowed.
    expect(CHECK).not.toMatch(/bun test[^\n]*tests\//);
  });

  test("gate:dependencies stays a separate network-backed step, not absorbed into check:ci", () => {
    expect(PKG.scripts["gate:dependencies"]).toBeTruthy();
    expect(CHECK_CI).not.toContain("gate:dependencies");
  });

  test("bun recursively discovers new *.test.ts under a directory arg (auto-entry proof)", () => {
    // Proves bun directory recursion: drop a sentinel in an isolated tmp dir,
    // run `bun test <tmpdir>`, assert it is found and run. Combined with the
    // directory-form check:ci above, a new tests/mcp/*.test.ts cannot stay
    // outside CI. The tmp dir keeps the checkout clean.
    const tmp = mkdtempSync(join(tmpdir(), "cbrain-ratchet-sentinel-"));
    try {
      writeFileSync(
        join(tmp, "sentinel.test.ts"),
        'import { test, expect } from "bun:test";\n' +
          'test("ratchet sentinel", () => { expect(1 + 1).toBe(2); });\n',
      );
      // argv form (no shell): process.execPath is the bun binary, "test" + tmp
      // are real args, so a TMPDIR with spaces or shell metacharacters cannot
      // alter what runs. bun writes the per-test summary to stderr, so merge streams.
      const res = spawnSync(process.execPath, ["test", tmp], { encoding: "utf-8", env: process.env });
      const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      expect(res.status).toBe(0);
      expect(out).toMatch(/1 pass/);
      expect(out).toMatch(/Ran 1 test/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
