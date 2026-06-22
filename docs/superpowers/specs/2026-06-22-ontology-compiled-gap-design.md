# Ontology Compiled-Gap — Design

> 关联 issue: #220 `bug: compiled executable crashes when ontology assets are not available on filesystem`
> 日期: 2026-06-22
> 状态: Draft（待 review）

## Problem

packaged/compiled runtime（`bun build --compile`）启动崩：

```
ENOENT: no such file or directory, open '/$bunfs/root/ontology.yaml'
  at new OntologyLoader → getOntology → getFactFieldWhitelist (模块顶层)
```

`--version` / `--help` / 任何 CLI 启动都被拖崩。#211 修了 `package.json` 读取（version fallback），ontology 是**同构**的运行时文件问题，但**不能照搬 fallback**——ontology 是核心数据，缺失必须明确报错，不能静默吞或回退空。

## Root Cause（复现审计）

**触发链**：`src/core/ner.ts:54 export const FACT_FIELD_WHITELIST = getFactFieldWhitelist()` 在**模块顶层 eager 求值** → `getOntology()`（loader.ts:165 singleton）→ `new OntologyLoader()`（loader.ts:21）→ `parse(readFileSync(ontology.yaml))`（loader.ts:23）。

- `OntologyLoader` 构造 `readFileSync(join(__dirname, "ontology.yaml"))`：source/npm 模式 ontology.yaml 在位（成功）；compiled 模式 `__dirname` 是 `/$bunfs/root`，ontology.yaml 不在 → ENOENT throw（**含绝对路径**）。
- **触发面**：任何 CLI 启动。`buildProgram()` import 所有命令模块 → `mcp/context.ts:10` / `dialogue` / `ingest` 等都 import `ner.ts` → 顶层 `FACT_FIELD_WHITELIST` 执行 → ontology 加载。`--version`/`--help` 被 commander 处理前就崩。
- `getOntology()` 其他调用方（entity-resolver / merge-workflow / pipeline / shared / slug / maintenance / ner 内部）全是**运行时函数内**调用，非顶层。**唯一顶层 eager 是 `ner.ts:54`。**
- `FACT_FIELD_WHITELIST` 被 dialogue / ingest / structured-facts / structured-facts-backfill 运行时索引（4 处）。

## Design Decision

**lazy-load + sanitized diagnostic**。不是 #211 version fallback 的延伸——ontology 缺失**不静默吞、不回退空**，要明确报错。

### 1. `src/core/ner.ts` — lazy `FACT_FIELD_WHITELIST`（方案 A1）

- 删 `export const FACT_FIELD_WHITELIST = getFactFieldWhitelist()`（顶层 eager，根因）。
- `getFactFieldWhitelist()` 改 **memoized lazy**（首次调用才 load ontology，缓存结果）。
- 4 调用方改 function 调用：
  - `src/core/dialogue.ts:286` `FACT_FIELD_WHITELIST[et]` → `getFactFieldWhitelist()[et]`（import 改 `getFactFieldWhitelist`）
  - `src/core/ingest.ts:340` 同
  - `src/core/structured-facts.ts:25` 同
  - `src/core/structured-facts-backfill.ts:114` 同
- 效果：import ner.ts 不再触发 ontology；`--version`/`--help` 不崩。

### 2. `src/ontology/loader.ts` — `OntologyLoader` sanitized error

- 构造 `readFileSync` try/catch。
- 失败 throw 自定义 `OntologyRuntimeAssetMissingError`：
  - message：`ontology runtime asset 不可用。这是 packaged/compiled runtime 的已知限制 —— ontology.yaml 未随 bundle 分发。需要 ontology 的命令（NER / 实体解析 / ingest 等）请用 source checkout 或 npm install 模式运行。`
  - **不泄露** `/$bunfs/...` 绝对路径（不把 path 放 message/stack 可见处）。
  - **不 fallback** 空 ontology（throw，不返回空 data）。
- 导出 `OntologyRuntimeAssetMissingError` class（instanceof 检查用）。

### 3. CLI 顶层 catch（方案 B1）

- `src/cli/index.ts`（plan 时确认现状）catch `OntologyRuntimeAssetMissingError` → `console.error(e.message)` + `process.exit(1)`，**不打印 stack**（避免路径泄露）。
- 其他 error 正常冒泡（不动现有 error 处理）。
- `--version`/`--help` 经修复 1 后不触发 ontology，不会到这；这层 catch 兜底需要 ontology 的命令（如 `cbrain dream`、`cbrain ingest`）在 compiled 缺 asset 时的行为。

## Boundaries

- **不 fallback 空 ontology**（核心数据，缺失必报错）。
- **不泄露本地绝对路径**到任何用户可见输出（message / stderr）。
- **不硬编码用户路径**。
- source tree / npm installed 模式**保持现有行为**（ontology 在位，lazy 是纯优化，结果不变）。

## Testing（fixture 全匿名，无真实人名/公司/产品/vault 内容）

- `tests/ontology/loader-missing-asset.test.ts`（新）：
  - `new OntologyLoader("/nonexistent/ontology.yaml")` → throw `OntologyRuntimeAssetMissingError`
  - error.message **不含**绝对路径片段（如不出现 `/tmp/`、`/$bunfs/`、`nonexistent` 等真实路径）
  - error.message 含修复方向关键词（如 "ontology"、"runtime"、"source" 或 "install"）
  - 不返回空 ontology（throw 而非空 data）
- CLI smoke（新，可用 spawn 或 mock ontology 不可用）：
  - `--version` / `--help` 在 ontology 不可用时**不崩**，正常输出
- ontology-dependent diagnostic：
  - `getOntology()` 在 ontology 缺失时 throw `OntologyRuntimeAssetMissingError`（sanitized）
- 现有 `tests/version.test.ts` + `tests/ontology/*`（loader.test.ts / ner-prompt.test.ts）**不回归**。

## Non-goals

- 不做完整 packaging overhaul（compiled binary 不是当前主分发，phase-3 走 npm + HTTP）。
- 不改 ontology schema / ontology.yaml 内容。
- 不改实体/关系语义。
- 不碰 Hermes config。
- 不关闭 #220，不 push main。

## Acceptance Criteria（#220）

- [ ] ontology 缺失时 `--version` / `--help` 不崩（lazy 后不触发 ontology）
- [ ] 需要 ontology 的命令（dream/ingest/NER 相关）缺 asset → sanitized 短错误 + 修复方向
- [ ] 不泄露绝对路径到用户输出
- [ ] 不 fallback 空 ontology
- [ ] source / npm installed 模式不回归（lazy 纯优化）
- [ ] `bun test tests/version.test.ts` + `bun test tests/ontology` + `bun run check` 通过
