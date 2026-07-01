import { describe, test, expect } from "bun:test";
import { classifyPersonalTag } from "../../src/core/personal-tag-classifier.js";

describe("classifyPersonalTag — positive signals", () => {
  // Possessive preference / habit (first-person)
  test("possessive preference (CN) → true", () => {
    expect(classifyPersonalTag({ content: "我的偏好 是 偏好X" })).toBe(true);
  });
  test("habit (CN) → true", () => {
    expect(classifyPersonalTag({ content: "我习惯 每天 偏好X" })).toBe(true);
  });
  test("I prefer (EN) → true", () => {
    expect(classifyPersonalTag({ content: "I prefer 偏好X" })).toBe(true);
  });
  test("my habit (EN) → true", () => {
    expect(classifyPersonalTag({ content: "my habit is 偏好X" })).toBe(true);
  });

  // Life signals (first-person NOT required)
  test("health signal → true", () => {
    expect(classifyPersonalTag({ content: "最近 失眠" })).toBe(true);
  });
  test("family signal → true", () => {
    expect(classifyPersonalTag({ content: "妈妈 来看 我" })).toBe(true);
  });
  test("hobby reading → true", () => {
    expect(classifyPersonalTag({ content: "周末 读书" })).toBe(true);
  });
  test("reflection → true", () => {
    expect(classifyPersonalTag({ content: "反思 这周 的 生活" })).toBe(true);
  });
});

describe("classifyPersonalTag — fail closed", () => {
  test("neutral content → false", () => {
    expect(classifyPersonalTag({ content: "中性 内容" })).toBe(false);
  });
  test("empty → false", () => {
    expect(classifyPersonalTag({ content: "" })).toBe(false);
  });
});

describe("classifyPersonalTag — guardrail vetoes (conflict wins)", () => {
  // Positive word present but vetoed by a guardrail term
  test("system health → false (health vetoed by system)", () => {
    expect(classifyPersonalTag({ content: "check system health" })).toBe(false);
  });
  test("系统健康检查 → false", () => {
    expect(classifyPersonalTag({ content: "系统健康检查" })).toBe(false);
  });
  test("团队健康度 → false (team vetoes health)", () => {
    expect(classifyPersonalTag({ content: "团队健康度" })).toBe(false);
  });
  test("日常运维 → false (运维 vetoes 日常)", () => {
    expect(classifyPersonalTag({ content: "日常运维" })).toBe(false);
  });
  test("巡检流程 → false", () => {
    expect(classifyPersonalTag({ content: "巡检流程" })).toBe(false);
  });
  test("阅读论文 → false (论文 vetoes reading)", () => {
    expect(classifyPersonalTag({ content: "阅读论文" })).toBe(false);
  });
  test("行业阅读 → false (行业 vetoes reading)", () => {
    expect(classifyPersonalTag({ content: "行业阅读" })).toBe(false);
  });
  test("pure project/architecture text → false", () => {
    expect(classifyPersonalTag({ content: "项目Y 的 架构 设计" })).toBe(false);
  });
  test("issue/PR text → false", () => {
    expect(classifyPersonalTag({ content: "项目Y 的 issue 和 PR" })).toBe(false);
  });
  test("first-person + guardrail → false (guardrail wins)", () => {
    expect(classifyPersonalTag({ content: "我喜欢 项目Y 的 设计" })).toBe(false);
  });
  test("maintenance routine → false", () => {
    expect(classifyPersonalTag({ content: "maintenance routine for 系统" })).toBe(false);
  });
});

describe("classifyPersonalTag — routing markers + bare 'personal' + mixed", () => {
  // Gate 0: routing/control markers in tags → false (defensive)
  test("tags with agent_profile → false", () => {
    expect(classifyPersonalTag({ content: "我偏好 偏好X", tags: ["agent_profile"] })).toBe(false);
  });
  test("tags with action_loop → false", () => {
    expect(classifyPersonalTag({ content: "我偏好 偏好X", tags: ["action_loop"] })).toBe(false);
  });
  test("tags with no_store → false", () => {
    expect(classifyPersonalTag({ content: "我偏好 偏好X", tags: ["no_store"] })).toBe(false);
  });

  // Bare "个人" / "personal" is NOT positive on its own
  test("个人 OKR → false (个人 not positive; OKR guardrail)", () => {
    expect(classifyPersonalTag({ content: "个人 OKR 目标" })).toBe(false);
  });
  test("personal contribution to a project → false", () => {
    expect(classifyPersonalTag({ content: "personal contribution to 项目Y" })).toBe(false);
  });

  // Mixed work + life → false (guardrail wins)
  test("mixed project + insomnia → false", () => {
    expect(classifyPersonalTag({ content: "项目Y 让 我 失眠" })).toBe(false);
  });
});
