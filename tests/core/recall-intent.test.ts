import { describe, test, expect } from "bun:test";
import { detectTemporalIntent, shouldCompleteEvidence } from "../../src/core/recall-intent.js";

describe("detectTemporalIntent (#232)", () => {
  test("temporal markers: 之前/上次/最近/后来/变化/时间线", () => {
    for (const q of [
      "实体A 上次的活动",
      "实体B 最近的变化和进展",
      "主题C 后来怎么样了",
      "组织D 之前聊过什么",
      "实体E 什么时候的事",
      "实体F 的时间线",
    ]) {
      const i = detectTemporalIntent(q);
      expect(i.temporal, `${q} should be temporal`).toBe(true);
    }
  });

  test("history markers: 当时为什么这么定 / 怎么设计的 / 原来怎么说", () => {
    for (const q of [
      "之前方案B 当时为什么这么定",
      "当时怎么设计的",
      "原来怎么说这个方案",
      "为什么这么定这个方向",
    ]) {
      const i = detectTemporalIntent(q);
      expect(i.history, `${q} should be history`).toBe(true);
    }
  });

  test("former/current markers: 前任/现任/之前…现在", () => {
    for (const q of [
      "实体A 前任和现任",
      "实体C 之前和现在的关系",
    ]) {
      const i = detectTemporalIntent(q);
      expect(i.formerCurrent, `${q} should be formerCurrent`).toBe(true);
    }
  });

  test("plain entity lookup has no temporal/history intent", () => {
    for (const q of [
      "实体A 是谁",
      "组织B 的信息",
      "概念C 是什么",
    ]) {
      const i = detectTemporalIntent(q);
      expect(i.temporal || i.history || i.formerCurrent, `${q} should have no evidence intent`).toBe(false);
    }
  });
});

describe("shouldCompleteEvidence (#232)", () => {
  test("mode=off never completes", () => {
    expect(shouldCompleteEvidence("实体A 上次的活动", "off")).toBe(false);
    expect(shouldCompleteEvidence("实体A 是谁", "off")).toBe(false);
  });

  test("mode=on always completes", () => {
    expect(shouldCompleteEvidence("实体A 是谁", "on")).toBe(true);
    expect(shouldCompleteEvidence("实体A 上次的活动", "on")).toBe(true);
  });

  test("mode=auto completes only on temporal/history intent", () => {
    expect(shouldCompleteEvidence("实体A 上次的活动", "auto")).toBe(true);
    expect(shouldCompleteEvidence("之前方案B 当时为什么这么定", "auto")).toBe(true);
    expect(shouldCompleteEvidence("实体A 前任和现任", "auto")).toBe(true);
    // plain lookup → no completion (zero overhead on normal queries)
    expect(shouldCompleteEvidence("实体A 是谁", "auto")).toBe(false);
    expect(shouldCompleteEvidence("组织B 的信息", "auto")).toBe(false);
  });
});
