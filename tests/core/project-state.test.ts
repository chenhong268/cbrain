import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  getProjectStatePath,
  readProjectState,
  renderProjectStateEnvelope,
  writeProjectState,
} from "../../src/core/project-state.js";

const tmp = "/tmp/cbrain-test-project-state-core";

describe("project-state core (#266)", () => {
  test("missing state renders a graceful compact empty envelope", () => {
    const envelope = renderProjectStateEnvelope(null);

    expect(envelope.summary.status).toBe("empty");
    expect(envelope.summary.count).toBe(0);
    expect(envelope.display).toContain("暂无项目状态");
    expect(envelope.result_summary).toContain("暂无项目状态");
  });

  test("renders active work, decisions, and blockers under budget", () => {
    const envelope = renderProjectStateEnvelope({
      updated_at: "2026-07-02T00:00:00.000Z",
      active_work: ["#1 修复主题A", "#2 审核主题B"],
      decisions: ["保持确定性写入", "不做自动 prompt 注入"],
      blockers: ["等待 #3 合并"],
      release: "v2.x 当前稳定",
    }, { maxChars: 500 });

    expect(envelope.summary.status).toBe("ok");
    expect(envelope.summary.count).toBe(5);
    expect(envelope.display).toContain("当前工作");
    expect(envelope.display).toContain("近期决策");
    expect(envelope.display).toContain("阻塞/关注");
    expect(envelope.display.length).toBeLessThanOrEqual(500);
  });

  test("truncates oversized state deterministically", () => {
    const envelope = renderProjectStateEnvelope({
      active_work: Array.from({ length: 20 }, (_, i) => `任务${i} ${"内容".repeat(20)}`),
      decisions: [],
      blockers: [],
    }, { maxChars: 240 });

    expect(envelope.summary.truncated).toBe(true);
    expect(envelope.display.length).toBeLessThanOrEqual(240);
    expect(envelope.display).toContain("已截断");
  });

  test("display redacts local paths and credentials", () => {
    const envelope = renderProjectStateEnvelope({
      active_work: ["/Users/example/private/file.md sk-abcdef1234567890"],
      decisions: [],
      blockers: [],
    });

    expect(envelope.display).not.toContain("/Users/example");
    expect(envelope.display).not.toContain("sk-abcdef");
    expect(envelope.display).toContain("[path]");
    expect(envelope.display).toContain("[secret]");
  });

  test("read/write stores artifact under runtime project-state directory", () => {
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });

    const state = { active_work: ["任务A"], decisions: ["决策B"], blockers: [] };
    writeProjectState(tmp, state);

    expect(existsSync(getProjectStatePath(tmp))).toBe(true);
    expect(readProjectState(tmp)).toEqual(expect.objectContaining({
      active_work: ["任务A"],
      decisions: ["决策B"],
    }));

    rmSync(tmp, { recursive: true, force: true });
  });

  test("corrupt state fails open with a repair hint", () => {
    rmSync(tmp, { recursive: true, force: true });
    const path = getProjectStatePath(tmp);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json", "utf-8");

    const envelope = renderProjectStateEnvelope(readProjectState(tmp));

    expect(envelope.summary.status).toBe("ok");
    expect(envelope.display).toContain("无法读取");
    expect(envelope.display).toContain("project-state --set");

    rmSync(tmp, { recursive: true, force: true });
  });
});
