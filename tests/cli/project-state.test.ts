import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildProgram } from "../../src/cli/program.js";

const tmp = "/tmp/cbrain-test-project-state-cli";

function captureLog(fn: () => void): string {
  const orig = console.log;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += args.map(String).join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

function writeConfig(root: string): string {
  const vaultPath = join(root, "vault");
  const runtimePath = join(root, "runtime");
  mkdirSync(vaultPath, { recursive: true });
  const configPath = join(root, "cbrain.json");
  writeFileSync(configPath, JSON.stringify({
    vaultPath,
    dbPath: join(root, "brain.sqlite"),
    lancePath: join(root, "lancedb"),
    runtimePath,
    embedding: { provider: "deterministic" },
    ner: { enabled: false },
  }));
  return configPath;
}

describe("cbrain project-state CLI (#266)", () => {
  beforeEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.CBRAIN_CONFIG;
  });

  test("missing state returns graceful empty JSON", () => {
    process.env.CBRAIN_CONFIG = writeConfig(tmp);

    const out = captureLog(() => buildProgram().parse(["project-state", "--json"], { from: "user" }));
    const parsed = JSON.parse(out);

    expect(parsed.summary.status).toBe("empty");
    expect(parsed.display).toContain("暂无项目状态");
  });

  test("--set writes explicit state then default output renders compact display", () => {
    process.env.CBRAIN_CONFIG = writeConfig(tmp);
    const statePath = join(tmp, "state.json");
    writeFileSync(statePath, JSON.stringify({
      active_work: ["#1 处理主题A"],
      decisions: ["不做自动 prompt 注入"],
      blockers: ["等待主题B"],
    }));

    captureLog(() => buildProgram().parse(["project-state", "--set", statePath], { from: "user" }));
    const out = captureLog(() => buildProgram().parse(["project-state"], { from: "user" }));

    expect(out).toContain("当前工作");
    expect(out).toContain("近期决策");
    expect(out).toContain("阻塞/关注");
    expect(existsSync(join(tmp, "runtime", "project-state", "state.json"))).toBe(true);
  });

  test("--set rejects invalid JSON without writing artifact", () => {
    process.env.CBRAIN_CONFIG = writeConfig(tmp);
    const statePath = join(tmp, "bad.json");
    writeFileSync(statePath, "{not-json");

    expect(() => {
      captureLog(() => buildProgram().parse(["project-state", "--set", statePath], { from: "user" }));
    }).toThrow();

    expect(existsSync(join(tmp, "runtime", "project-state", "state.json"))).toBe(false);
  });

  test("--json output contains no surrounding prose", () => {
    process.env.CBRAIN_CONFIG = writeConfig(tmp);
    const statePath = join(tmp, "state.json");
    writeFileSync(statePath, JSON.stringify({ active_work: ["任务A"], decisions: [], blockers: [] }));
    captureLog(() => buildProgram().parse(["project-state", "--set", statePath], { from: "user" }));

    const out = captureLog(() => buildProgram().parse(["project-state", "--json"], { from: "user" }));
    const parsed = JSON.parse(out);

    expect(out.trim()[0]).toBe("{");
    expect(out.trim().at(-1)).toBe("}");
    expect(parsed.summary.status).toBe("ok");
    expect(readFileSync(join(tmp, "runtime", "project-state", "state.json"), "utf-8")).toContain("任务A");
  });
});
