# Personal Tag Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, pure `personal`-tag classifier to the ingest write path so clear personal memory is auto-tagged, while work/research/technical content and ambiguous input fail closed.

**Architecture:** New pure module `src/core/ingestion/personal-tag-classifier.ts` (no LLM/DB/IO) with a 3-gate function (routing-marker → guardrail → positive → fail-closed). `src/core/ingestion/ingest.ts` calls it at the entry of `ingestText` and `ingestMarkdown` to merge `personal` into effective tags via set union before any durable write. `DialogueIngest` is untouched.

**Tech Stack:** Bun, TypeScript (strict), `bun:test`. SQLite via `bun:sqlite`.

**Commit constraint (#236):** Single independent commit at the end (issue comment requirement overrides the skill's default frequent-commits). All tasks accumulate changes in the worktree; only Task 8 commits. No push, no issue close.

**Spec:** `docs/superpowers/specs/2026-07-01-personal-tag-classifier-design.md`

---

## File Structure

- **Create:** `src/core/ingestion/personal-tag-classifier.ts` — pure classifier, 3 gates, exported `classifyPersonalTag`.
- **Create:** `tests/core/personal-tag-classifier.test.ts` — pure-function matrix (no DB/mock).
- **Modify:** `src/core/ingestion/ingest.ts` — import classifier; inject effective tags in `ingestText` (~:235-248) and `ingestMarkdown` (~:219-221).
- **Modify:** `tests/core/ingest.test.ts` — extend with personal-tag cases on text + markdown + entity-append + duplicate paths.
- **Modify:** `tests/mcp/ingest-classify.test.ts` — extend with MCP-layer personal-tag case.

Privacy: all fixtures use sentinels only (`人物A / 事件B / 主题C / 资料D / 地点E` + `偏好X / 项目Y / 主题Z`). No real names, companies, products, paths, or private content anywhere.

---

## Task 1: Classifier — positive signals + fail-closed

**Files:**
- Create: `tests/core/personal-tag-classifier.test.ts`
- Create: `src/core/ingestion/personal-tag-classifier.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/personal-tag-classifier.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { classifyPersonalTag } from "../../src/core/ingestion/personal-tag-classifier.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/core/personal-tag-classifier.test.ts`
Expected: FAIL — module `../../src/core/ingestion/personal-tag-classifier.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/ingestion/personal-tag-classifier.ts`:

```ts
/**
 * Deterministic personal-tag classifier for the ingest write path.
 *
 * Returns true when content is clearly personal long-term memory and no
 * veto fires. Pure: no LLM, no DB, no file IO. Source-agnostic.
 * Conflict or uncertainty → false (fail closed).
 *
 * Phase 1 (this file): positive signals + fail-closed only.
 * Guardrail (Gate 1) and routing-marker (Gate 0) are added in later tasks.
 */

export interface PersonalTagInput {
  title?: string;
  content: string;
  tags?: string[];
}

// Gate 2 — possessive preference / habit (first-person)
const POSSESSIVE_CN = /我(?:的)?(?:偏好|习惯|喜好|口味|风格)|我喜欢|我爱|我偏好|我习惯|我一般|我通常|我总是/;
const POSSESSIVE_EN = /\bmy (?:preference|habit|taste|style)\b|\bi (?:prefer|like|love|always|usually)\b/i;

// Gate 2 — strong life signals (first-person NOT required)
const LIFE_CN = /健康|看病|体检|失眠|焦虑|抑郁|运动|跑步|健身|锻炼|节食|过敏|家人|父母|妈妈|爸爸|孩子|儿子|女儿|老婆|妻子|丈夫|老公|兄弟|姐妹|朋友|作息|周末|假期|休假|旅行|旅游|爱好|兴趣|读书|阅读|电影|音乐|游戏|烹饪|做饭|宠物|生活|日常|反思|感悟|心情|情绪|日记/;
const LIFE_EN = /\b(health|workout|fitness|insomnia|allergy|family|parent|mother|mom|dad|father|kids?|children|spouse|wife|husband|brother|sister|sibling|friend|routine|hobby|interest|reading|movie|music|travel|pets?|lifestyle|reflection|journal)\b/i;

export function classifyPersonalTag(input: PersonalTagInput): boolean {
  const text = `${input.title ?? ""}\n${input.content ?? ""}`.toLowerCase();
  if (!text.trim()) return false;

  // Gate 2 — positive (Gate 0 / Gate 1 added in later tasks)
  if (POSSESSIVE_CN.test(text) || POSSESSIVE_EN.test(text) || LIFE_CN.test(text) || LIFE_EN.test(text)) {
    return true;
  }
  // Gate 3 — fail closed
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/core/personal-tag-classifier.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Do NOT commit yet** (single-commit constraint; commit happens in Task 8).

---

## Task 2: Classifier — guardrail veto (conflict wins)

**Files:**
- Modify: `tests/core/personal-tag-classifier.test.ts` (append `guardrail` describe block)
- Modify: `src/core/ingestion/personal-tag-classifier.ts` (add Gate 1)

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/personal-tag-classifier.test.ts` (before the final EOF, after the existing describes):

```ts
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test tests/core/personal-tag-classifier.test.ts`
Expected: FAIL on the new guardrail cases (e.g. `日常运维` returns `true` because `日常` is a positive life signal and no guardrail exists yet).

- [ ] **Step 3: Add Gate 1 (guardrail) to the implementation**

In `src/core/ingestion/personal-tag-classifier.ts`, add the guardrail constants (above the function) and short-circuit before Gate 2:

```ts
// Gate 1 — guardrail (veto, overrides any positive signal). Conflict wins.
const GUARDRAIL_CN = /文章|论文|研究|报告|行业|资讯|调研|新闻|白皮书|技术|架构|代码|系统|模块|组件|服务|接口|实现|重构|部署|运维|巡检|线上|开发|工程|项目|产品|需求|迭代|版本|功能|工作|团队|会议|职责|岗位|职位|汇报|业务|公司|组织|部门|客户|合作/;
const GUARDRAIL_EN = /\b(article|paper|research|report|industry|news|whitepaper|technical|architecture|code|system|module|component|service|api|implementation|refactor|deploy|deployment|maintenance|infra(?:structure)?|project|product|requirement|version|release|okr|kpi|business|org(?:anization)?|department|stakeholder|issue|pr|pull request|commit|merge|ticket|review|bug|feature)\b/i;
```

Update `classifyPersonalTag` body to:

```ts
export function classifyPersonalTag(input: PersonalTagInput): boolean {
  const text = `${input.title ?? ""}\n${input.content ?? ""}`.toLowerCase();
  if (!text.trim()) return false;

  // Gate 1 — guardrail veto (Gate 0 added in next task)
  if (GUARDRAIL_CN.test(text) || GUARDRAIL_EN.test(text)) return false;

  // Gate 2 — positive
  if (POSSESSIVE_CN.test(text) || POSSESSIVE_EN.test(text) || LIFE_CN.test(text) || LIFE_EN.test(text)) {
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/personal-tag-classifier.test.ts`
Expected: PASS (all positive, fail-closed, and guardrail cases).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 3: Classifier — routing-marker + bare-personal + mixed

**Files:**
- Modify: `tests/core/personal-tag-classifier.test.ts` (append edge-case describe)
- Modify: `src/core/ingestion/personal-tag-classifier.ts` (add Gate 0)

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/personal-tag-classifier.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests; verify behavior**

Run: `bun test tests/core/personal-tag-classifier.test.ts`

Expected: most pass already (the `个人 OKR`, `personal contribution`, `mixed` cases are handled by the existing guardrail). The routing-marker cases (`agent_profile` / `action_loop` / `no_store`) will currently pass too IF the content also lacks a positive signal — but `"我偏好 偏好X"` is positive, so they return `true` and **FAIL**. This drives Gate 0.

- [ ] **Step 3: Add Gate 0 (routing markers) to the implementation**

Update `classifyPersonalTag` in `src/core/ingestion/personal-tag-classifier.ts` to consult `tags` first:

```ts
const ROUTING_MARKERS = new Set(["agent_profile", "action_loop", "no_store"]);

export function classifyPersonalTag(input: PersonalTagInput): boolean {
  // Gate 0 — routing/control markers (defensive veto)
  const tags = input.tags ?? [];
  if (tags.some(t => ROUTING_MARKERS.has(t))) return false;

  const text = `${input.title ?? ""}\n${input.content ?? ""}`.toLowerCase();
  if (!text.trim()) return false;

  // Gate 1 — guardrail veto
  if (GUARDRAIL_CN.test(text) || GUARDRAIL_EN.test(text)) return false;

  // Gate 2 — positive
  if (POSSESSIVE_CN.test(text) || POSSESSIVE_EN.test(text) || LIFE_CN.test(text) || LIFE_EN.test(text)) {
    return true;
  }
  return false;
}
```

Note: the bare word `个人` / `personal` is intentionally absent from all positive dictionaries, so `个人 OKR` and `personal contribution` already fail (the former via `OKR` guardrail, the latter via no positive signal + `project` guardrail). No extra rule needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/personal-tag-classifier.test.ts`
Expected: PASS (full classifier matrix).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 4: Integrate into `ingestText` (covers ingestCore + ingestEntityAppend)

This task satisfies the explicit reminder: **effectiveTags must cover both the `ingestEntityAppend` and `ingestCore` text branches.**

**Files:**
- Modify: `src/core/ingestion/ingest.ts` (import + `ingestText` injection)
- Modify: `tests/core/ingest.test.ts` (new describe block)

- [ ] **Step 1: Write the failing tests**

In `tests/core/ingest.test.ts`, inside the top-level `describe("IngestManager", ...)` (add a new nested `describe` after the existing ones, before the closing of the outer describe):

```ts
  describe("personal tag (#236)", () => {
    test("text ingest of clear personal preference adds personal tag", async () => {
      const result = await ingest.ingest({
        content: "我的偏好 是 偏好X",
        type: "text",
        title: "偏好X 笔记",
        skipNer: true,
      });
      expect(result.created).toBe(true);
      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(result.slug) as any[];
      expect(tags.map(t => t.tag)).toContain("personal");
    });

    test("text ingest of business content does NOT add personal", async () => {
      const result = await ingest.ingest({
        content: "项目Y 的 架构 设计",
        type: "text",
        title: "项目Y 设计",
        skipNer: true,
      });
      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(result.slug) as any[];
      expect(tags.map(t => t.tag)).not.toContain("personal");
    });

    test("text ingest of ambiguous mixed content does NOT add personal", async () => {
      const result = await ingest.ingest({
        content: "项目Y 让 我 失眠",
        type: "text",
        title: "项目Y 感受",
        skipNer: true,
      });
      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(result.slug) as any[];
      expect(tags.map(t => t.tag)).not.toContain("personal");
    });

    test("caller-provided tags are preserved alongside personal", async () => {
      const result = await ingest.ingest({
        content: "我习惯 每天 偏好X",
        type: "text",
        title: "偏好X 习惯",
        tags: ["偏好X"],
        skipNer: true,
      });
      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(result.slug) as any[];
      const tagValues = tags.map(t => t.tag);
      expect(tagValues).toContain("personal");
      expect(tagValues).toContain("偏好X");
    });

    test("entity append of clearly-personal text merges personal without dropping existing tags", async () => {
      // Step 1: create a person entity carrying an existing tag via the fast path.
      // "人物A，是人物B的同事" routes to entity/person (同事 relation); content has no
      // personal signal, so classifier leaves effective tags as ["auto-extracted"].
      // We pass the seed tag as a caller tag so it flows through pages.create (no raw INSERT).
      await ingest.ingest({ content: "人物A，是人物B的同事", type: "text", tags: ["auto-extracted"], skipNer: true });
      const personSlug = db.getPageByTitle("人物A")!.slug;
      const seedTags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(personSlug) as any[];
      expect(seedTags.map(t => t.tag)).toContain("auto-extracted");

      // Step 2: append clearly-personal text using the person's title → ingestEntityAppend
      const result = await ingest.ingest({
        content: "我的偏好 是 偏好X",
        type: "text",
        title: "人物A",
        skipNer: true,
      });
      expect(result.slug).toBe(personSlug);
      expect(result.created).toBe(false);

      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(personSlug) as any[];
      const tagValues = tags.map(t => t.tag);
      expect(tagValues).toContain("personal");
      expect(tagValues).toContain("auto-extracted");
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/core/ingest.test.ts`
Expected: FAIL — no `personal` tag is ever written (classifier not wired into `ingestText` yet).

- [ ] **Step 3: Wire the classifier into `ingestText`**

In `src/core/ingestion/ingest.ts`:

(a) Add the import at the top (next to the existing `content-classifier.js` import, line ~14):

```ts
import { classifyPersonalTag } from "./personal-tag-classifier.js";
```

(b) Replace the body of `ingestText` from the `routedPersonTitle` line through the end of the method. The current code (lines ~235-248) is:

```ts
    const routedPersonTitle = this.inferPersonRelationshipTitle(input.content, input.title);
    const existingPersonSlug = this.findExistingPersonSlug(input.title ?? routedPersonTitle ?? rawTitle);

    if (existingPersonSlug) {
      return this.ingestEntityAppend(existingPersonSlug, input.content, input.tags ?? [], nerAction);
    }

    const title = routedPersonTitle ?? rawTitle;
    const type = normalizePageType(routedPersonTitle ? "entity/person" : input.pageType ?? "record");
    const slug = generateSlug(title, type);
    const body = input.content;
    const tags = input.tags ?? [];

    return this.ingestCore(slug, title, type, body, tags, nerAction, input.allowDuplicate);
```

Replace it with:

```ts
    const routedPersonTitle = this.inferPersonRelationshipTitle(input.content, input.title);
    const existingPersonSlug = this.findExistingPersonSlug(input.title ?? routedPersonTitle ?? rawTitle);

    // #236: classify personal memory before durable write. One effectiveTags value
    // covers BOTH branches (ingestEntityAppend + ingestCore) of the text path.
    const classifierTitle = input.title ?? routedPersonTitle ?? rawTitle;
    const baseTags = input.tags ?? [];
    const effectiveTags = classifyPersonalTag({ title: classifierTitle, content: input.content, tags: baseTags })
      ? [...new Set([...baseTags, "personal"])]
      : baseTags;

    if (existingPersonSlug) {
      return this.ingestEntityAppend(existingPersonSlug, input.content, effectiveTags, nerAction);
    }

    const title = routedPersonTitle ?? rawTitle;
    const type = normalizePageType(routedPersonTitle ? "entity/person" : input.pageType ?? "record");
    const slug = generateSlug(title, type);
    const body = input.content;

    return this.ingestCore(slug, title, type, body, effectiveTags, nerAction, input.allowDuplicate);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/ingest.test.ts`
Expected: PASS (including the new `personal tag (#236)` block).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 5: Integrate into `ingestMarkdown` (frontmatter precedence + idempotent union)

**Files:**
- Modify: `src/core/ingestion/ingest.ts` (`ingestMarkdown` injection, line ~219)
- Modify: `tests/core/ingest.test.ts` (markdown cases in the `personal tag (#236)` block)

- [ ] **Step 1: Write the failing tests**

Append these to the `personal tag (#236)` describe block in `tests/core/ingest.test.ts`:

```ts
    test("markdown ingest of personal body adds personal while preserving frontmatter tags", async () => {
      const md = [
        "---",
        "title: 偏好X 笔记",
        "type: record",
        "slug: records/preference-note",
        "tags:",
        "  - fm-tag",
        "---",
        "",
        "我的偏好 是 偏好X",
      ].join("\n");
      const result = await ingest.ingest({ content: md, type: "markdown", skipNer: true });
      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(result.slug) as any[];
      const tagValues = tags.map(t => t.tag);
      expect(tagValues).toContain("fm-tag");
      expect(tagValues).toContain("personal");
    });

    test("markdown ingest of business body does NOT add personal", async () => {
      const md = [
        "---",
        "title: 项目Y 设计",
        "type: record",
        "slug: records/project-design",
        "---",
        "",
        "项目Y 的 架构 设计",
      ].join("\n");
      const result = await ingest.ingest({ content: md, type: "markdown", skipNer: true });
      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(result.slug) as any[];
      expect(tags.map(t => t.tag)).not.toContain("personal");
    });

    test("markdown ingest is idempotent when personal tag already in frontmatter", async () => {
      const md = [
        "---",
        "title: 偏好X 习惯",
        "type: record",
        "slug: records/preference-idempotent",
        "tags:",
        "  - personal",
        "---",
        "",
        "我习惯 每天 偏好X",
      ].join("\n");
      const result = await ingest.ingest({ content: md, type: "markdown", skipNer: true });
      const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(result.slug) as any[];
      const personalCount = tags.filter(t => t.tag === "personal").length;
      expect(personalCount).toBe(1);
    });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun test tests/core/ingest.test.ts`
Expected: FAIL on the markdown personal case (no `personal` written for markdown yet).

- [ ] **Step 3: Wire the classifier into `ingestMarkdown`**

In `src/core/ingestion/ingest.ts`, locate `ingestMarkdown` (line ~219):

```ts
    const body = parsed.body;
    const effectiveTags = parsed.frontmatter.tags ?? input.tags ?? [];

    return this.ingestCore(slug, title, type, body, effectiveTags, nerAction, input.allowDuplicate);
```

Replace the `effectiveTags` line so the classifier runs against the frontmatter-stripped body:

```ts
    const body = parsed.body;
    const baseTags = parsed.frontmatter.tags ?? input.tags ?? [];
    // #236: classify against the stripped body + title; union personal into effective tags.
    const effectiveTags = classifyPersonalTag({ title, content: body, tags: baseTags })
      ? [...new Set([...baseTags, "personal"])]
      : baseTags;

    return this.ingestCore(slug, title, type, body, effectiveTags, nerAction, input.allowDuplicate);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/core/ingest.test.ts`
Expected: PASS (all ingest cases incl. markdown personal + idempotent).

- [ ] **Step 5: Do NOT commit yet.**

---

## Task 6: Duplicate / no-op produces no tag side effect

This task satisfies the explicit reminder: **duplicate/no-op must not create a tag side effect on an existing page.**

**Files:**
- Modify: `tests/core/ingest.test.ts` (duplicate case in the `personal tag (#236)` block)

- [ ] **Step 1: Write the test**

Append to the `personal tag (#236)` describe block:

```ts
    test("duplicate re-ingest of personal content does not create extra tag side effects", async () => {
      const content = "我的偏好 是 偏好X";
      const first = await ingest.ingest({ content, type: "text", title: "偏好X 唯一", skipNer: true });
      expect(first.outcome).toBe("created");

      const tagsAfterFirst = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(first.slug) as any[];
      const personalAfterFirst = tagsAfterFirst.filter(t => t.tag === "personal").length;
      expect(personalAfterFirst).toBe(1);

      // Re-ingest the exact same body → durable-source dedup returns duplicate, no write.
      const second = await ingest.ingest({ content, type: "text", title: "偏好X 唯一", skipNer: true });
      expect(second.outcome).toBe("duplicate");

      const tagsAfterSecond = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(first.slug) as any[];
      const personalAfterSecond = tagsAfterSecond.filter(t => t.tag === "personal").length;
      // No new side effect: still exactly one personal tag row.
      expect(personalAfterSecond).toBe(1);
    });
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/core/ingest.test.ts`
Expected: PASS. The classifier runs at the `ingestText` entry (pure, no side effect), and the `ingestCore` durable-source dedup gate returns `duplicate` without writing, so no extra tag row is created. If it FAILS, the injection accidentally moved past the dedup gate — re-check Task 4 placement (injection is before `ingestCore`, dedup is inside it).

- [ ] **Step 3: Do NOT commit yet.**

---

## Task 7: MCP ingest carries the same behavior

**Files:**
- Modify: `tests/mcp/ingest-classify.test.ts` (new describe block)

- [ ] **Step 1: Write the tests**

Append to `tests/mcp/ingest-classify.test.ts` (new describe at end of file):

```ts
describe("MCP ingest personal tag (#236)", () => {
  test("MCP ingest of clear personal content writes personal tag", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "我的偏好 是 偏好X",
      type: "text",
      title: "偏好X 笔记",
      skipNer: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    const slug = parsed.raw.slug;

    const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(slug) as any[];
    expect(tags.map(t => t.tag)).toContain("personal");
  });

  test("MCP ingest of business content does NOT write personal tag", async () => {
    const server = createServer(deps);
    const tools = getTools(server);
    const handler = tools["ingest"].handler;

    const result = await handler({
      content: "项目Y 的 架构 设计",
      type: "text",
      title: "项目Y 设计",
      skipNer: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    const slug = parsed.raw.slug;

    const tags = db.rawDb.prepare("SELECT tag FROM tags WHERE page_slug = ?").all(slug) as any[];
    expect(tags.map(t => t.tag)).not.toContain("personal");
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `bun test tests/mcp/ingest-classify.test.ts`
Expected: PASS (the MCP handler calls `IngestManager.ingest`, which already applies the classifier from Task 4). If FAIL, verify the MCP ingest tool forwards `type`/`title`/`skipNer` into `IngestInput` (it does — see `src/mcp/tools/ingest.ts`).

- [ ] **Step 3: Do NOT commit yet.**

---

## Task 8: Full gate + single commit

**Files:** none new — verification and the one allowed commit.

- [ ] **Step 1: Run the focused gates**

Run:
```bash
bun test tests/core/personal-tag-classifier.test.ts
bun test tests/core/ingest.test.ts
bun test tests/mcp/ingest-classify.test.ts
bun run lint
```
Expected: all PASS, lint clean.

- [ ] **Step 2: Run the full check**

Run: `bun run check`
Expected: PASS (lint + full `bun test`). If a pre-existing unrelated test fails, capture which one and report it; do not bundle unrelated fixes into this commit.

- [ ] **Step 3: Verify DialogueIngest is untouched**

Run: `git diff main -- src/core/ingestion/dialogue.ts`
Expected: empty (no diff). `tests/core/dialogue.test.ts` likewise untouched.

- [ ] **Step 4: Privacy scan of the diff**

Run: `git diff main`
Expected: no real names, companies, products, paths, emails, or private content anywhere in code, tests, comments, or messages. Only sentinels (`人物A / 偏好X / 项目Y / ...`) and generic domain words.

- [ ] **Step 5: Single independent commit**

```bash
git add src/core/ingestion/personal-tag-classifier.ts \
        tests/core/personal-tag-classifier.test.ts \
        src/core/ingestion/ingest.ts \
        tests/core/ingest.test.ts \
        tests/mcp/ingest-classify.test.ts
git commit -m "feat(ingest): #236 deterministic personal-tag classifier on write path" -m "Pure 3-gate classifier (routing-marker -> guardrail -> positive, fail closed; no LLM/DB/IO) merged into ingestText + ingestMarkdown effective tags via set union. Covers ingestEntityAppend + ingestCore; duplicate/no-op has no tag side effect. DialogueIngest untouched. Anonymous fixtures only." -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

Do NOT push. Do NOT close the issue. Report the commit hash and the focused + full gate results.

---

## Verification Summary (acceptance ↔ task)

| #236 acceptance | Task |
|:--|:--|
| ingest personal preference → `personal` in tags | Task 4 (text), Task 5 (markdown) |
| caller tags preserved + deduped | Task 4 (caller-provided tags case) |
| business/project/research → no `personal` | Task 2 (classifier), Task 4/5 (ingest) |
| ambiguous mixed → no `personal` | Task 3 (classifier), Task 4 (ingest) |
| duplicate/re-ingest unchanged except safe tag merge | Task 6 |
| no slug/path/ontology/vault-dir changes | Tasks 4/5 (injection is metadata-only) |
| anonymous fixtures only | all tasks + Task 8 privacy scan |
| DialogueIngest untouched | Task 8 Step 3 |
| MCP ingest same behavior | Task 7 |

## Non-goals enforced

No LLM, no DB/IO in classifier. No schema/migration. No slug/file-path/ontology change. No recall/search/ranking change. No nerMode/skipNer/ner-backfill/Dream/MCP-profile change. No `raw/` change. No personal digest/profile/notification.
