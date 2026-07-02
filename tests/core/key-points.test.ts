import { describe, expect, it } from "bun:test";
import { extractKeyPoints, buildMemorySkeleton } from "../../src/core/retrieval/key-points.js";

describe("extractKeyPoints", () => {
  // ── Strategy 1: Frontmatter (entity pages) ──

  describe("frontmatter extraction", () => {
    it("extracts person_card.summary and ask_for", () => {
      const frontmatter = {
        person_card: {
          summary: "Person A是Company X全国数字化转型负责人",
          ask_for: ["AI组织设计", "数据治理", "System A架构"],
        },
      };
      const points = extractKeyPoints(null, frontmatter);
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(points[0]).toContain("Person A");
      expect(points[1]).toContain("AI组织设计");
    });

    it("extracts organization and title fields", () => {
      const frontmatter = {
        organization: "Company X",
        current_title: "全国数字化转型总监",
        reports_to: "CTO",
      };
      const points = extractKeyPoints(null, frontmatter);
      expect(points).toContain("组织：Company X");
      expect(points).toContain("职位：全国数字化转型总监");
      expect(points).toContain("汇报给：CTO");
    });

    it("returns empty when no frontmatter and no body", () => {
      expect(extractKeyPoints(null, null)).toEqual([]);
      expect(extractKeyPoints(undefined, undefined)).toEqual([]);
    });

    it("falls back to frontmatter when body is empty", () => {
      const frontmatter = { organization: "Organization Y" };
      expect(extractKeyPoints("", frontmatter)).toEqual(["组织：Organization Y"]);
      expect(extractKeyPoints("   ", frontmatter)).toEqual(["组织：Organization Y"]);
    });

    it("uses frontmatter when it has >= 3 points even with body", () => {
      const body = "## Some heading\n\nSome content here";
      const frontmatter = {
        person_card: { summary: "Test summary" },
        organization: "Org A",
        current_title: "Title B",
        reports_to: "Boss C",
      };
      const points = extractKeyPoints(body, frontmatter);
      expect(points.length).toBeGreaterThanOrEqual(3);
      expect(points[0]).toContain("Test summary");
    });
  });

  // ── Strategy 2: Heading + first-line context ──

  describe("heading extraction", () => {
    it("extracts headings with context lines", () => {
      const body = [
        "## 三层协作架构",
        "",
        "Company X内部数据安全区、Organization Y AI分析中台、外部CSO分布式节点",
        "",
        "## 组织架构与虚拟经理",
        "",
        "全国总监下属3个虚拟经理，4个大区经理各下属3个虚拟经理",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(points.some((p) => p.includes("三层协作架构"))).toBe(true);
      expect(points.some((p) => p.includes("虚拟经理"))).toBe(true);
    });

    it("skips noise headings", () => {
      const body = [
        "## 关联",
        "Some link content",
        "## 下一步",
        "Action items here",
        "## 核心设计",
        "The actual content",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.some((p) => p.includes("关联"))).toBe(false);
      expect(points.some((p) => p.includes("下一步"))).toBe(false);
      expect(points.some((p) => p.includes("核心设计"))).toBe(true);
    });

    it("skips Chinese number-only headings", () => {
      const body = [
        "## 一、",
        "First section content",
        "## 二、",
        "Second section",
        "## Real Heading",
        "Actual content",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.some((p) => p.includes("一、"))).toBe(false);
      expect(points.some((p) => p.includes("二、"))).toBe(false);
    });

    it("handles headings without context lines", () => {
      const body = [
        "## Heading One",
        "",
        "",
        "## Heading Two",
        "",
        "",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBe(2);
      expect(points[0]).toBe("Heading One");
      expect(points[1]).toBe("Heading Two");
    });

    it("stops at next heading when looking for context", () => {
      const body = [
        "## Heading A",
        "## Heading B",
        "Context for B",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBe(2);
      expect(points[0]).toBe("Heading A");
      expect(points[1]).toContain("Context for B");
    });

    it("stops at table rows when looking for context", () => {
      const body = [
        "## Heading A",
        "| col1 | col2 |",
        "|------|------|",
        "Some real context",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points[0]).toBe("Heading A");
    });

    it("stops at code blocks when looking for context", () => {
      const body = [
        "## Config",
        "```json",
        '{"key": "value"}',
        "```",
        "Some real context",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points[0]).toBe("Config");
    });

    it("respects maxPoints limit", () => {
      const body = Array.from(
        { length: 20 },
        (_, i) => `## Heading ${i}\n\nContent ${i}`,
      ).join("\n");
      const points = extractKeyPoints(body, null, { maxPoints: 4 });
      expect(points.length).toBe(4);
    });
  });

  // ── Strategy 3: Bold-prefixed list items ──

  describe("bold list extraction", () => {
    it("extracts bold key-value list items", () => {
      const body = [
        "- **数据安全红线**：Company X原始导出绝不能存",
        "- **边界原则**：AI做分析人做判断",
        "- **投入预算**：首月5000-8000元",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(points.some((p) => p.includes("数据安全红线"))).toBe(true);
      expect(points.some((p) => p.includes("边界原则"))).toBe(true);
    });

    it("handles both Chinese and English colons", () => {
      const body = [
        "- **Key A**: Value with English colon",
        "- **Key B**：Value with Chinese colon",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBe(2);
    });
  });

  // ── Strategy 4: Bullet points ──

  describe("bullet point extraction", () => {
    it("extracts plain bullet points as fallback", () => {
      const body = [
        "Some intro text without any headings",
        "",
        "- First important point about the design",
        "- Second key consideration for the project",
        "- Third detail about implementation",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(points.some((p) => p.includes("First important"))).toBe(true);
    });

    it("skips very short bullets", () => {
      const body = [
        "- ok",
        "- no",
        "- This is a sufficiently long bullet point with real content",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBe(1);
      expect(points[0]).toContain("sufficiently long");
    });

    it("skips table rows that look like bullets", () => {
      const body = [
        "- | col1 | col2 |",
        "- Real content here for extraction purposes",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.length).toBe(1);
      expect(points[0]).toContain("Real content");
    });
  });

  // ── Dossier stripping ──

  describe("dossier block stripping", () => {
    it("strips dossier block from body", () => {
      const body = [
        "## Real Heading",
        "Real content",
        "",
        "<!-- cbrain-dossier -->",
        "# LLM generated content that should be ignored",
        "More LLM stuff",
        "<!-- /cbrain-dossier -->",
        "",
        "## Another Heading",
        "More real content",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points.some((p) => p.includes("Real Heading"))).toBe(true);
      expect(points.some((p) => p.includes("Another Heading"))).toBe(true);
      expect(points.some((p) => p.includes("LLM generated"))).toBe(false);
    });

    it("handles body that is only dossier", () => {
      const body = [
        "<!-- cbrain-dossier -->",
        "LLM content only",
        "<!-- /cbrain-dossier -->",
      ].join("\n");
      expect(extractKeyPoints(body)).toEqual([]);
    });
  });

  // ── Markdown stripping ──

  describe("markdown stripping", () => {
    it("strips wiki links with display text", () => {
      const body = [
        "## Design",
        "Connects to [[person-a|Person A]] for collaboration",
      ].join("\n");
      const points = extractKeyPoints(body);
      expect(points[0]).toContain("Person A");
      expect(points[0]).not.toContain("[[");
    });

    it("strips wiki links without display text", () => {
      const body = "## Topic\nRelated to [[Organization Y]] directly";
      const points = extractKeyPoints(body);
      expect(points[0]).toContain("Organization Y");
      expect(points[0]).not.toContain("[[");
    });

    it("strips bold markers", () => {
      const body = "## Section\nThe **important** part of the design";
      const points = extractKeyPoints(body);
      expect(points[0]).toContain("important");
      expect(points[0]).not.toContain("**");
    });

    it("strips inline code", () => {
      const body = "## Config\nUse `extractKeyPoints()` function";
      const points = extractKeyPoints(body);
      expect(points[0]).toContain("extractKeyPoints()");
      expect(points[0]).not.toContain("`");
    });

    it("strips markdown links", () => {
      const body = "## Reference\nSee [the docs](https://example.com)";
      const points = extractKeyPoints(body);
      expect(points[0]).toContain("the docs");
      expect(points[0]).not.toContain("](");
    });
  });

  // ── Truncation ──

  describe("truncation", () => {
    it("truncates at Chinese period when possible", () => {
      const longText = "A".repeat(60) + "。" + "B".repeat(80);
      const body = `## Heading\n${longText}`;
      const points = extractKeyPoints(body, null, { maxLenPerPoint: 80 });
      expect(points[0]!.length).toBeLessThanOrEqual(80);
    });

    it("truncates at Chinese comma as fallback", () => {
      const longText = "A".repeat(60) + "，" + "B".repeat(80);
      const body = `## Heading\n${longText}`;
      const points = extractKeyPoints(body, null, { maxLenPerPoint: 80 });
      expect(points[0]!.length).toBeLessThanOrEqual(80);
    });

    it("hard truncates with ellipsis when no sentence boundary", () => {
      const longText = "A".repeat(200);
      const body = `## Heading\n${longText}`;
      const points = extractKeyPoints(body, null, { maxLenPerPoint: 50 });
      expect(points[0]!.endsWith("…")).toBe(true);
      expect(points[0]!.length).toBeLessThanOrEqual(50);
    });

    it("preserves short text without truncation", () => {
      const body = "## Short\nThis is short content";
      const points = extractKeyPoints(body, null, { maxLenPerPoint: 120 });
      expect(points[0]).toBe("Short：This is short content");
    });
  });

  // ── CSO design document (primary verification target) ──

  describe("Project Z design document", () => {
    const csoBody = [
      "# Project Z管理一种新的人AI协作组织设计",
      "",
      "## 核心理念",
      "",
      "不是在选软件系统，是在设计一种新的协作方式",
      "",
      "## 问题定义",
      "",
      "Project Z需要解决的核心问题：如何在数据安全约束下实现AI辅助决策",
      "",
      "## 三层协作架构",
      "",
      "Company X内部数据安全区、Organization Y AI分析中台、外部分布式节点",
      "",
      "### 安全层",
      "",
      "数据主权边界控制",
      "",
      "### 分析层",
      "",
      "AI分析引擎与规则引擎",
      "",
      "### 执行层",
      "",
      "分布式节点执行",
      "",
      "## 组织架构与虚拟经理",
      "",
      "全国总监下属3个虚拟经理，4个大区经理各下属3个虚拟经理",
      "",
      "## 数据安全红线",
      "",
      "Company X原始导出/System A完整报表/处方明细/内部定价绝不能存",
      "",
      "## 投入",
      "",
      "Phase 1试点总投入：首月5000-8000元，后续每月3000-5000元",
      "",
      "## 边界与原则",
      "",
      "AI做分析人做判断，AI跟人不替代人，先1个大区试点",
      "",
      "## 讨论邀请",
      "",
      "欢迎讨论",
      "",
      "## 下一步",
      "",
      "待定",
      "",
      "## 关联",
      "",
      "Some relations",
    ].join("\n");

    it("extracts key structural concepts", () => {
      const points = extractKeyPoints(csoBody, null, { maxPoints: 12 });

      // Must preserve architecture terms
      expect(points.some((p) => p.includes("三层协作架构"))).toBe(true);
      // Must preserve role terms
      expect(points.some((p) => p.includes("虚拟经理"))).toBe(true);
      // Must preserve data security
      expect(
        points.some((p) => p.includes("数据安全") || p.includes("数据主权")),
      ).toBe(true);
    });

    it("skips noise headings (讨论邀请, 下一步, 关联)", () => {
      const points = extractKeyPoints(csoBody, null, { maxPoints: 12 });
      expect(points.some((p) => p.includes("讨论邀请"))).toBe(false);
      expect(points.some((p) => p.includes("下一步"))).toBe(false);
      expect(points.some((p) => p.includes("关联"))).toBe(false);
    });

    it("preserves investment and pilot details", () => {
      const points = extractKeyPoints(csoBody, null, { maxPoints: 12 });
      expect(
        points.some(
          (p) => p.includes("5000") || p.includes("试点") || p.includes("投入"),
        ),
      ).toBe(true);
    });

    it("preserves boundary principles", () => {
      const points = extractKeyPoints(csoBody, null, { maxPoints: 12 });
      expect(
        points.some(
          (p) =>
            p.includes("边界") ||
            p.includes("AI做分析") ||
            p.includes("不替代"),
        ),
      ).toBe(true);
    });
  });

  // ── Insight page (Harness review) ──

  describe("insight page", () => {
    const insightBody = [
      "# 用Harness工程理论审查Project Z AI组织设计",
      "",
      "## 核心判断",
      "",
      "这个设计方案缺少状态管理和失败恢复机制",
      "",
      "## 问题一：缺少状态管理",
      "",
      "组织设计没有考虑Agent状态持久化问题",
      "",
      "## 问题二：缺少失败恢复",
      "",
      "没有定义失败场景和恢复路径",
      "",
      "## 问题三：Latent vs Deterministic",
      "",
      "混淆了确定性任务和概率性任务的处理方式",
      "",
      "## 问题四：Harness太胖",
      "",
      "当前的Harness层承担了过多职责，需要瘦身",
      "",
      "## 关联",
      "",
      "Related entities",
    ].join("\n");

    it("extracts insight headings with context", () => {
      const points = extractKeyPoints(insightBody);
      expect(points.some((p) => p.includes("核心判断"))).toBe(true);
      expect(
        points.some((p) => p.includes("状态管理") || p.includes("状态持久化")),
      ).toBe(true);
      expect(
        points.some((p) => p.includes("失败恢复") || p.includes("恢复路径")),
      ).toBe(true);
    });

    it("preserves technical terms", () => {
      const points = extractKeyPoints(insightBody);
      expect(
        points.some((p) => p.includes("Harness") || p.includes("harness")),
      ).toBe(true);
    });
  });

  // ── Options ──

  describe("options", () => {
    it("respects maxLenPerPoint", () => {
      const body = "## Heading\n" + "A".repeat(200);
      const points = extractKeyPoints(body, null, { maxLenPerPoint: 30 });
      expect(points[0]!.length).toBeLessThanOrEqual(30);
    });

    it("respects maxPoints", () => {
      const body = Array.from(
        { length: 20 },
        (_, i) => `## H${i}\nContent ${i}`,
      ).join("\n");
      const points = extractKeyPoints(body, null, { maxPoints: 3 });
      expect(points.length).toBe(3);
    });
  });
});

// ── buildMemorySkeleton ──

describe("buildMemorySkeleton", () => {
  const csoBody = [
    "## 核心理念",
    "",
    "不是在选软件系统，是在设计一种新的协作方式",
    "",
    "## 三层协作架构",
    "",
    "Company X内部数据安全区、Organization Y AI分析中台、外部分布式节点",
    "",
    "## 组织架构与虚拟经理",
    "",
    "全国总监下属3个虚拟经理，4个大区经理各下属3个虚拟经理",
    "",
    "## 数据安全红线",
    "",
    "Company X原始导出绝不能存",
    "",
    "## 投入",
    "",
    "Phase 1试点总投入：首月5000-8000元",
    "",
    "## 边界与原则",
    "",
    "AI做分析人做判断，AI跟人不替代人，先1个大区试点",
  ].join("\n");

  it("returns key_points and structure_terms", () => {
    const skeleton = buildMemorySkeleton(csoBody, null);
    expect(skeleton).toBeDefined();
    expect(skeleton!.key_points.length).toBeGreaterThanOrEqual(2);
    expect(skeleton!.structure_terms).toBeInstanceOf(Array);
  });

  it("returns undefined when no body and no frontmatter", () => {
    expect(buildMemorySkeleton(null, null)).toBeUndefined();
    expect(buildMemorySkeleton("", null)).toBeUndefined();
  });

  it("returns undefined when no L1 and no extractable points", () => {
    expect(buildMemorySkeleton("   ", null)).toBeUndefined();
  });

  // ── structure_terms extraction ──

  describe("structure_terms", () => {
    it("extracts heading titles as terms", () => {
      const skeleton = buildMemorySkeleton(csoBody, null);
      const terms = skeleton!.structure_terms;
      // Headings like 三层协作架构, 组织架构 should be extracted
      expect(terms.length).toBeGreaterThan(0);
    });

    it("extracts English technical terms", () => {
      const body = [
        "## Harness Architecture",
        "The Harness layer manages Agent lifecycle",
        "",
        "## State Management",
        "Use Deterministic state machine for control flow",
      ].join("\n");
      const skeleton = buildMemorySkeleton(body, null);
      const terms = skeleton!.structure_terms;
      const joined = terms.join(" ");
      expect(joined).toContain("Harness");
      expect(joined).toContain("Agent");
    });

    it("filters common English words from terms", () => {
      const body = [
        "## The System Design",
        "This is the architecture with components",
      ].join("\n");
      const skeleton = buildMemorySkeleton(body, null);
      const terms = skeleton!.structure_terms;
      // "The", "This", "With" should be filtered
      expect(terms).not.toContain("The");
      expect(terms).not.toContain("This");
      expect(terms).not.toContain("With");
    });

    it("extracts Chinese compound nouns from headings", () => {
      const skeleton = buildMemorySkeleton(csoBody, null);
      const terms = skeleton!.structure_terms;
      // Should pick up terms like 数据安全, 虚拟经理 from heading context
      const joined = terms.join(" ");
      expect(
        joined.includes("数据安全") ||
        joined.includes("虚拟经理") ||
        joined.includes("三层协作架构"),
      ).toBe(true);
    });

    it("caps structure_terms at 10 items", () => {
      const body = Array.from(
        { length: 20 },
        (_, i) => `## Term${i} Design\nContent about architecture ${i}`,
      ).join("\n");
      const skeleton = buildMemorySkeleton(body, null);
      expect(skeleton!.structure_terms.length).toBeLessThanOrEqual(10);
    });
  });

  // ── L1 summary merge ──

  describe("L1 summary merge", () => {
    it("prepends L1 summary sentences to key_points", () => {
      const l1Summary = "这是一个关于Project Z组织设计的讨论稿。核心是三层协作架构方案的详细说明。";
      const skeleton = buildMemorySkeleton(csoBody, null, l1Summary);
      expect(skeleton).toBeDefined();
      // L1 sentences should come first
      expect(skeleton!.key_points[0]).toContain("Project Z");
      expect(skeleton!.key_points[1]).toContain("三层协作架构");
    });

    it("caps merged points at 6 total", () => {
      const l1Summary = "第一句。第二句。第三句。第四句。";
      const skeleton = buildMemorySkeleton(csoBody, null, l1Summary);
      expect(skeleton!.key_points.length).toBeLessThanOrEqual(6);
    });

    it("deduplicates L1 and body points", () => {
      const l1Summary = "三层协作架构是核心设计。";
      const skeleton = buildMemorySkeleton(csoBody, null, l1Summary);
      // Should not have duplicate "三层协作架构" points
      const matches = skeleton!.key_points.filter((p) => p.includes("三层"));
      expect(matches.length).toBeLessThanOrEqual(2);
    });

    it("returns skeleton with only L1 when body is empty", () => {
      const l1Summary = "这是一个重要的项目记录。";
      const skeleton = buildMemorySkeleton(null, null, l1Summary);
      expect(skeleton).toBeDefined();
      expect(skeleton!.key_points.length).toBeGreaterThan(0);
      expect(skeleton!.key_points[0]).toContain("项目记录");
    });

    it("filters short L1 sentences (< 10 chars)", () => {
      const l1Summary = "短。这是足够长的一句话会被保留。";
      const skeleton = buildMemorySkeleton(null, null, l1Summary);
      expect(skeleton).toBeDefined();
      // Short sentence should be filtered
      expect(skeleton!.key_points.every((p) => p.length >= 10)).toBe(true);
    });
  });

  // ── 800-char cap ──

  describe("800-char cap", () => {
    it("caps total key_points length at 800 chars", () => {
      // Generate a body with many long points
      const body = Array.from(
        { length: 20 },
        (_, i) =>
          `## Heading ${i} with some context\n这是一段关于第${i}个主题的详细描述，包含足够多的文字来测试总长度限制是否生效，需要确保不会超过八百个字符的上限`,
      ).join("\n");
      const skeleton = buildMemorySkeleton(body, null);
      const totalLen = skeleton!.key_points.reduce((sum, p) => sum + p.length, 0);
      expect(totalLen).toBeLessThanOrEqual(800);
    });
  });

  // ── Full integration with CSO document ──

  describe("Project Z full skeleton", () => {
    it("produces usable skeleton with structure terms", () => {
      const skeleton = buildMemorySkeleton(csoBody, null);

      expect(skeleton).toBeDefined();
      expect(skeleton!.key_points.length).toBeGreaterThanOrEqual(4);

      const text = skeleton!.key_points.join(" ");
      // Must include core structure concepts
      expect(text).toContain("三层协作架构");
      expect(text).toContain("虚拟经理");

      // structure_terms should have meaningful terms
      const terms = skeleton!.structure_terms;
      expect(terms.length).toBeGreaterThan(0);
    });

    it("with L1 summary produces enriched skeleton", () => {
      const l1Summary = "Project Z是一种新型人AI协作组织设计，采用三层架构和虚拟经理机制。";
      const skeleton = buildMemorySkeleton(csoBody, null, l1Summary);

      expect(skeleton).toBeDefined();
      // L1 content should be in key_points
      const firstTwo = skeleton!.key_points.slice(0, 2).join(" ");
      expect(firstTwo).toContain("协作组织");
    });
  });
});
