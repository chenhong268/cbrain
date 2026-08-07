# Organization Provenance Projector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 entity/person 页面中带有确定性来源标记的 `organization`，以可重复、可审计、fail-closed 的方式投影成同三元组的 trusted “任职”关系，并让 MCP `put_page` 与 vault sync 共用同一个投影路径；NER/LLM 与 `add_knowledge.facts` 始终只产生候选信息。

**Architecture:** 在 SQLite 增加窄的精确查询和 trusted employment upsert；在 `ContentPipeline` 增加共享的 organization projector，按 canonical slug → exact title → unique alias 解析目标并拒绝歧义/错误类型；MCP `put_page` 仅在本次显式提供 `extra.organization` 时由 handler 注入 `organization_source: agent`，vault sync 只消费文件中已有的 `manual|agent` 标记；NER structured-facts 写入 `organization_source: ner`，但 projector 永不信任该来源。

**Tech Stack:** Bun, TypeScript, SQLite, existing PageManager/ContentPipeline/MCP page tools, Vitest-style Bun tests.

## Global Constraints

- 严格保持 #375 的 record/field 边界：不做通用 provenance framework、不迁移历史数据、不改 reports_to、不改变 `add_knowledge.facts` 的候选语义。
- 任何不合法来源、空值、错误页面类型、目标不存在/歧义/错误类型/自指，均不写关系；只产生固定 reason code/count，不把 slug、标题或知识库原文写入日志/错误。
- 不覆盖历史页面已有 `organization`，除非本次明确写入；无 marker 的历史字段永不自动升级为 trusted。
- 复用同一 projector 与同一 storage upsert；不在 MCP、sync、NER 各自复制关系写入逻辑。
- 测试 fixture 使用匿名实体（实体A、组织C 等），保留工作树中已有的未跟踪 plan 文档，不提交它们。

---

## Task 1: Add exact organization target queries and idempotent trusted employment upsert

**Files:** `src/storage/sqlite.ts`, new `tests/storage/organization-lifecycle.test.ts`

- [x] 先写失败测试：canonical slug、exact title、alias 查询返回全部匹配；重复 `(person, organization, 任职)` 写入只保留一条并刷新 `last_validated_at`；候选关系升级为 trusted；已有不同组织的 trusted employment 不被删除或替代；不创建 reverse edge。
- [x] 为 SQLite 增加窄查询方法，返回最小 `{slug,type,title}` 投影：按 exact title 返回全部行，按 alias 返回全部行；不得复用会任意取第一行的 `getPageByTitle`/`getSlugByAlias`。
- [x] 增加固定关系名 `任职` 的 trusted upsert：按同三元组原地 update，否则 insert；写入受控 `source_type`、`source_page_slug`、evidence、confidence、`trust_state=trusted`、`last_validated_at`/effective weight；不调用通用 reverse-link 行为，不 supersede 其他 employment。
- [x] 运行 focused storage tests，确认现有 reports_to/link 生命周期测试不回归。

## Task 2: Implement the shared fail-closed organization projector

**Files:** `src/core/ingestion/pipeline.ts` (or a narrow adjacent module if needed), new `tests/core/pipeline-organization.test.ts`

- [x] 先写失败测试覆盖：只接受 `manual|agent`；source page 必须是 `entity/person`；organization 必须是非空 string；canonical slug 优先，其次 exact title，再次 alias；title/alias 多匹配拒绝；目标必须是 `entity/company|entity/organization`；自指、缺失 marker、`ner`、错误类型均不写；固定 reason code；重复写刷新时间且不产生重复；不同已有 employment 保留。
- [x] 新增 `ContentPipeline.processOrganization(fromSlug, frontmatter)`，从 source page 重新读取类型和字段，按上述顺序解析目标，并调用 Task 1 的唯一 upsert；不要信任调用方传入的任意 source 字段或模糊 resolver。
- [x] 将日志/诊断限制为固定 code/count，不打印 slug、标题、body、alias 或原始错误；无效输入以 skipped 结果结束，不抛出破坏页面写入的异常。
- [x] 运行 pipeline/projector focused tests，并审查事务边界：关系失败不能留下半条关系，成功页面写入与关系写入顺序可重试。

## Task 3: Mark organization fields written by NER/LLM as candidate-only

**Files:** `src/core/ingestion/structured-facts.ts`, `src/core/ingestion/entity-facts.ts`, existing structured/entity fact tests

- [x] 先补失败测试：空 organization 被 NER/LLM 填充时同时写 `organization_source: ner`；已有 non-empty organization 不覆盖；已有 `manual|agent` 来源不被降级；NER 来源永远不能被 projector 提升 trusted。
- [x] 在两条 structured-fact 写入路径中只对 organization 做窄处理：仅当值实际填入且没有更强来源时写 marker；其他字段行为保持不变。
- [x] 保持 `add_knowledge.facts` 现有 candidate-only 语义，增加回归测试证明不会写 trusted employment。

## Task 4: Harden MCP `put_page` explicit organization provenance

**Files:** `src/mcp/tools/pages.ts`, `tests/mcp/server.test.ts` (or the narrowest existing page-tool test file)

- [x] 先补失败测试：显式 `extra.organization` 在同一 page write 注入 `organization_source: agent` 并投影；caller 伪造 `organization_source: manual|ner`（无论是否带 organization）固定报错且 page/version/edge 均零写；仅 body/tags 更新历史 organization 不补 marker、不投影；目标歧义/错误类型只跳过关系而不泄露详情；重复显式写不重复边且刷新验证时间。
- [x] 在任何 create/update/patch/version 写入前预检 extra：只接受非空 string organization；拒绝 caller organization_source；使用新对象注入 agent marker，避免污染调用方对象。
- [x] 新建和更新成功后调用共享 `processOrganization`；不复制 resolver/upsert；保留既有 page quality、version、wikilink、NER 和 KR 行为。
- [x] 验证冲突路径在 `createVersion`、`pages.create/update/patch`、index 及任何关系写入之前就返回，确保零写原子性。

## Task 5: Wire vault sync to the same projector without historical guessing

**Files:** `src/core/maintenance/sync.ts`, new or existing sync-focused tests

- [x] 先补失败测试：带合法 `organization_source: manual`（及受治理 agent marker）的 entity/person vault page 投影成功；缺 marker、`ner`、历史 organization、歧义 alias、错误 target type 均不写；sync 重复运行保持单边并刷新验证时间。
- [x] 在现有四个 reports_to sync processing points 同步调用 `pipeline.processOrganization`，或抽出同一窄 helper 但不引入通用 registry/framework；调用前后不修改 raw/，只消费解析后的 explicit marker。
- [x] 检查 sync 的 create/update/recovery 路径都覆盖，避免只覆盖首次发现；运行 focused sync tests 和相关 ingestion tests。

## Task 6: Adversarial review, verification, and handoff

**Files:** all changed files plus this plan

- [x] 用最挑剔的审查者攻击至少以下风险：marker 伪造绕过、title/alias 任意首行选择、错误 target type、source page 类型绕过、历史字段隐式升级、候选边被误信任、重复边/反向边、日志泄露、部分写入。
- [x] 检查 `git diff --check`、focused tests、lint/typecheck；最后运行项目全量 `bun run check`，记录 pass/skip/fail 证据：focused 279 pass/0 fail；全量 5286 pass/4 skip/0 fail（5290 tests，24600 expects）。
- [x] 复查实现是否新增了不必要的 MCP tool、CLI、迁移、公共抽象或兼容分支；确认删除/避免的代码和每个共享抽象的真实消费者（MCP put_page、vault sync）。
- [x] 仅提交 #375 相关源码、测试和本计划；不纳入根 worktree 的其他未跟踪 plan；完成后给出 PR/merge 前审核结论与剩余风险。

## Self-review checklist

- [x] 是否所有 trusted 写入都经过同一个 projector 与同一个窄 upsert？
- [x] 是否能证明没有任何路径把 `ner`、历史无 marker 或 `add_knowledge.facts` 变成 trusted？
- [x] 是否所有 ambiguity/invalid 分支都 fail closed 且不泄露知识库内容？
- [x] 是否 page write 的 forged marker 在任何持久化前拒绝？
- [x] 是否没有迁移历史数据、改变 reports_to 或扩张到通用 provenance？
