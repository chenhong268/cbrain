# Hermes Skill Pack Deploy Contract — Design Spec

> Issue #334 · `fix(agent-contract): verify and deploy the canonical CBrain skill pack for Hermes`
> Parent #333 · 2026-07-14

## 1. 问题

仓库已把 natural recall / operational attention / debug search 的路由收口到 canonical skill pack（`skills/`），但 Hermes 实际加载的 CBrain skill 可能仍是历史手工版本。侦察确认四个具体缺口：

1. **安装嵌套 bug**（`docs/install-onboarding.md` Step 7）：`cp -r "<pack>/" ~/.hermes/skills/brain-ops/cbrain/skills/` 把 pack 塞进嵌套 `skills/`，target root `.../cbrain/` 不含 `SKILL.md`，入口落在 `.../cbrain/skills/SKILL.md`。symlink 变体同样 off-by-one。若 Hermes 扫 `<dir>/SKILL.md` 找入口则找不到。
2. **verification 无 manifest / 无 incompatible 维度**：`cbrain skill-pack --target` 已能比对扁平 target（current/stale/missing/unverified，fileHash 驱动），但无 manifest、无 pack-version、无 `incompatible`，且 `REQUIRED_FILES` 硬编码只 6 个，遗漏 skills/ 其余 27 个运行依赖文件。
3. **routing fixture 缺**：operational→`next_actions` 路由只存在于 skill 层（`RESOLVER.md`→`query.md[operations]`→`next_actions`），TS router `classifyFrontdoorQuery` 无 operational route、next_tool 从不 `next_actions`。三类匿名 routing smoke fixture（operational/natural/debug）不存在。
4. **docs gate gap + 内部矛盾**：`check-docs-consistency` 不验证 install 文档的安装命令 target 形状；`known-issues.md` 称"Hermes 不读 SKILL.md"，与 install 文档把 SKILL.md 当 Hermes 入口部署矛盾。

## 2. 目标 / 范围 / 非目标

### 目标
建立确定、可验证、不静默漂移的 Hermes skill 部署合同：canonical pack 有 manifest + pack-version 自检；`skill-pack` 只读校验 target；安装文档输出同源根入口；docs gate 防退化；匿名 routing fixture 覆盖三类意图。

### 范围
- 新增 `skills/MANIFEST.json`（packVersion + 全部运行文件清单）。
- `cbrain skill-pack` 增强：manifest 驱动校验 + `incompatible` 维度 + 收紧的 `missing` 语义。
- 修正 `install-onboarding.md` 安装形状（根入口同源、命令收紧）。
- `check-docs-consistency` 扩展：安装 target 不嵌套 + manifest version 一致性。
- 匿名 routing smoke fixture（skill 层）。

### 非目标（守边界）
- 不自动覆盖 `~/.hermes` 或删除用户已有 skill。CLI 无任何写 target 代码路径、无 `--install`/`--force`/`--overwrite` flag。
- 不修改 recall ranking、MCP tool handler、tool profile。**不扩展 TS router**（不加 operational route）。
- 不开 structured output。
- 不解决"Hermes 是否读 SKILL.md"的运行时行为（只保证加载路径同源；真实 Hermes smoke 列为合并后 release gate）。
- 不改 `github:<owner>/cbrain` 硬编码（功能性公开 install source，非私人数据，标残余风险）。

## 3. 设计

### 3.1 `skills/MANIFEST.json`（新源文件，pack 包含）

```json
{
  "packVersion": "2.0.7",
  "files": [
    "SKILL.md",
    "RESOLVER.md",
    "hermes-cbrain-brief.md",
    "recall-resolver.md",
    "brain-ops.md",
    "query.md",
    "review.md",
    "connect.md",
    "ingest.md",
    "enrich.md",
    "cleanup.md",
    "dream.md",
    "write.md",
    "signal-detector.md",
    "signal-router.md",
    "feature-index.md",
    "filing-rules.md",
    "response-contract.routing-eval.jsonl",
    "agent-facing.routing-eval.jsonl",
    "recall.routing-eval.jsonl",
    "episodic.routing-eval.jsonl",
    "signal-router.routing-eval.jsonl",
    "compounding-review.routing-eval.jsonl",
    "agentic.routing-eval.jsonl",
    "provenance.routing-eval.jsonl",
    "hierarchy.routing-eval.jsonl",
    "query.routing-eval.jsonl",
    "connect.routing-eval.jsonl",
    "ingest.routing-eval.jsonl",
    "dream.routing-eval.jsonl",
    "cleanup.routing-eval.jsonl",
    "review.routing-eval.jsonl",
    "write.routing-eval.jsonl"
  ]
}
```

规则：
- `packVersion` 手写，verify 时强校验 `== src/version.ts` 导出的 version（即 `package.json` version）。不等 → canonical 自检 fail（`VERSION_MISMATCH`，exit 1）。这是"不静默漂移"守卫：release bump version 忘改 manifest 会被 `skill-pack` 和 docs gate 双重拦截。
- `files[]` 列 canonical pack **全部 33 个运行依赖文件**（17 `.md` + 16 `.routing-eval.jsonl`，对应 `package.json` files 字段 `"skills/"` 全包 + `SKILL.md` §4 索引）。CLI 完全由 `files[]` 驱动校验，替代硬编码 `REQUIRED_FILES` const。
- **schema/path 校验**：`files[]` 每项必须是安全相对路径——无重复、无绝对路径（不以 `/` 开头）、无 `..` 段、不含 `MANIFEST.json` 自身。违例 → `MANIFEST_INVALID`。
- **canonical exact-inventory gate**：`files[]` 必须与 `skills/` 实际文件集合**完全相等**（集合相等，不多不少）。canonical 新增第 34 个文件忘更新 manifest → 不等 → canonical 自检 fail（`INVENTORY_MISMATCH`）。防"新增文件静默漂移"。
- **target manifest 等价校验**：`--target` 比对时，target MANIFEST 的 `files[]` 必须与 canonical `files[]` 完全相等。target 手改 manifest 清单（删/加文件项）→ 不等 → `incompatible`（不会报 `current`）。
- **最小强制集合 `ENTRY_FILES`**（硬编码 const，不在 manifest）：`SKILL.md`、`hermes-cbrain-brief.md`、`RESOLVER.md`、`recall-resolver.md`（`SKILL.md` §1 启动流程必读入口）。verify 时校验 `ENTRY_FILES ⊆ manifest.files[]`，否则 manifest 自残 → `MANIFEST_INVALID`。
- **MANIFEST.json 不进自己的 hash 列表**，单独验证（存在 + 可解析 + `packVersion` 匹配 + schema/inventory 校验）。不自证。

### 3.2 `skill-pack` CLI：参数与状态判定

参数不变：`cbrain skill-pack [--json] [--target <path>]`。仍是单一扁平命令、只读。

**canonical 自检**（无 `--target`）：读 `skills/MANIFEST.json` → 校验 `packVersion == version.ts` + `ENTRY_FILES ⊆ files[]` + `files[]` 每个文件存在/可读 + `SKILL.md` 字符数阈值（沿用现有 `SIZE_WARN=30_000` / `SIZE_ERROR=100_000`）。失败 → `verificationStatus=fail`（exit 1）。

**target 比对**（`--target <path>`），按优先级命中即定：

| # | target.status | 条件 |
|:---:|:---|:---|
| 1 | `unverified` | canonical 自检 fail（优先级最高，压所有 target 状态） |
| 2 | `missing` | target 路径不存在（严格；唯一可展示安装命令的 target 状态） |
| 3 | `incompatible` | target 存在但为空目录，或无/坏 MANIFEST，或 `packVersion ≠ canonical`，或 `files[] ≠ canonical.files[]` |
| 4 | `stale` | version 等 + `files[]` 等，但缺文件或某文件 hash ≠ canonical |
| 5 | `current` | version 等 + `files[]` 等 + 全文件 hash 匹配 |

关键语义修正（审核修正点 1 + 2）：
- `unverified` 优先级最高：canonical 损坏时无论 target 状态都报 `unverified`，**不展示安装命令**（防把坏 pack 装出去）。
- `missing` **严格** = target 路径不存在。**已存在空目录归 `incompatible`**（空目录下执行 copy/symlink 会产生 `cbrain/skills/` 嵌套，已 shell 复现）。
- 安装命令展示条件：`verificationStatus !== fail && target.status === missing`。
- "目录已存在但无/坏 MANIFEST"归 `incompatible`（目录有东西、不是 canonical pack、可能是用户私有 skill → 不可安全安装）。
- `TARGET_NOT_FOUND` **不再是异常信封**：`--target <不存在路径>` 返回正常 `target.status=missing` + exit 1，不抛 `SkillPackError`。
- 任何非 `current` → 聚合 `status=fail`（exit 1）。

### 3.3 `verificationStatus` vs `status` 语义

- `verificationStatus`：**只**表示 canonical pack 自检结果（`pass` / `warn` / `fail`）。
- 顶层 `status`：canonical + target 的**聚合**结果（`pass` / `warn` / `fail`）。
- 例：canonical 通过、target stale → `verificationStatus=pass`、`status=fail`。
- 聚合规则：canonical fail → `status=fail`；canonical pass + target 非 current → `status=fail`；canonical pass + target current（或无 target）→ `status=pass`/`warn`。

### 3.4 安装形状（copy / symlink）

安装契约：**Hermes 扫描 `~/.hermes/skills/<dir>/SKILL.md` 找入口**（target root 必须含 `SKILL.md`，不嵌套）。

文档给两种形状，**symlink 默认推荐**（随 CBrain 升级自动同步）：

```bash
# symlink（默认推荐）
mkdir -p ~/.hermes/skills/brain-ops
ln -s "<pack-path>" ~/.hermes/skills/brain-ops/cbrain

# copy
mkdir -p ~/.hermes/skills/brain-ops
cp -r "<pack-path>" ~/.hermes/skills/brain-ops/cbrain
```

`<pack-path>` = CBrain 安装的 `skills/` 目录绝对路径（由 `cbrain skill-pack` 报告的 `packPath`）。

收紧规则（审核修正点 3）：
- symlink：`mkdir -p` **父目录** `brain-ops`，`ln -s` 创建 target `cbrain`（不预创建 target 本身）。
- copy：仅当 `target.status === missing`（target 不存在）时展示。**空目录不算 missing**（见 §3.2，空目录归 `incompatible`）。
- 安装命令展示条件：`verificationStatus !== fail && target.status === missing`。
- `stale` / `incompatible` / `unverified` 状态下，**CLI 和文档都不得输出可直接覆盖的 copy/symlink 命令**，只给"人工备份后检查"说明。
- 安装后强制 verify：`cbrain skill-pack --target ~/.hermes/skills/brain-ops/cbrain` 应报 `current`。

安装后结构（target root 直接含入口）：
```
~/.hermes/skills/brain-ops/cbrain/   ← target root（Hermes 扫描点）
├── SKILL.md                          ← 入口，来自 canonical pack
├── MANIFEST.json                     ← packVersion + files[]
├── hermes-cbrain-brief.md
├── RESOLVER.md
├── recall-resolver.md
└── ... (其余 29 个运行文件)
```

### 3.5 不覆盖保护（三重机制）

1. **CLI 零写路径**：`skill-pack` action handler 只调 `verifySkillPack`（读）+ `compareTarget`（读），无 `fs.writeFile / cp / symlink / rm` 调用。代码上不可能写 target。
2. **安装命令只写新路径 + 强制预检**：文档命令 target 是 CBrain 专属命名 `~/.hermes/skills/brain-ops/cbrain/`。文档**强制要求**安装前先跑 `cbrain skill-pack --target <路径>`：`missing` → 安全安装；`current` → 已是 canonical，无需安装；`stale`/`incompatible` → 路径已有不同内容，人工决定，文档不给自动覆盖命令。
3. **CLI 无写 flag**：不提供 `--install`/`--force`/`--overwrite`。issue 非目标由代码结构兑现，不靠文档承诺。

### 3.6 错误处理与隐私边界

**错误信封**（`--json` 失败时）：`{version, packPath, verificationStatus:"fail", status:"fail", code, error}`。稳定 code：`PACK_NOT_FOUND`（canonical skills dir 缺失）/ `PACK_INVALID` / `MANIFEST_MISSING`（canonical 无 MANIFEST）/ `MANIFEST_INVALID`（格式坏 / `ENTRY_FILES` 缺失 / `files[]` schema 违例）/ `VERSION_MISMATCH`（`packVersion ≠ version.ts`）/ `INVENTORY_MISMATCH`（canonical `files[]` ≠ skills/ 实际文件集合）。无 stack trace 泄露 stderr。

**隐私边界**（审核修正点 4）：
- 允许输出本次命令显式涉及的 pack/target **操作路径**（`packPath`、`entrypointPath`、`target.path`）——安装和排错需要，现有测试要求绝对 `packPath`。
- **禁止**输出：target 文件正文、vault 内容、credential、无关私人路径、stack trace。
- target 校验只读 MANIFEST.json（元数据）+ 算各文件 sha256（hash），不读取/打印 target skill 正文。
- routing fixture 用合成 sentinel（"系统当前有什么异常"等通用句），不写真名/路径/email。
- 测试统一使用 `/tmp` 或临时目录。

### 3.7 `check-docs-consistency` 扩展

新增/扩展 check（审核修正点 5）：
- **install-target 精确路径**：扫描 install 文档里 skill-pack 的 copy/symlink 命令，断言 target 恰好是 `~/.hermes/skills/brain-ops/cbrain`（精确路径，拦截嵌套退化 + 防路径漂移；不只检查"不以 `/skills/` 结尾"）。
- **manifest version 一致性**：扩展 `checkVersions`，校验 `skills/MANIFEST.json.packVersion == package.json version`（与 `skill-pack` verify 双守卫）。
- 现有 15 个 check 不破坏；新增 check 走同样的 truth source（package.json / `buildProgram`）和 exit code 约定（0 pass / 1 fail）。

### 3.8 routing smoke fixture（skill 层，不扩展 TS router）

审核选定 Skill-layer fixture。三类 smoke 全部作为 **skill-layer contract 校验**，**不经过 TS router**（TS router `classifyFrontdoorQuery` 返回 `deep_recall` 而非 `cbrain_recall`，且非目标禁改；让 natural case 过 TS router 无法实现）。

- 三类匿名 fixture + expected skill-layer routing target：
  - operational："系统当前有什么异常" / "接下来处理什么" → `RESOLVER.md` → `query.md[operations]` → `next_actions`
  - natural：普通知识问题 → `hermes-cbrain-brief.md` → `cbrain_recall`
  - debug：精确 debug 关键词 → `query.md` → `query`
- 校验方式：bun:test doc-contract 断言 `RESOLVER.md` 路由表 + `query.md[operations]` branch + `hermes-cbrain-brief.md` 覆盖三类意图→正确 skill 文件→正确 tool（grep 规则文本，**不调 `classifyFrontdoorQuery`**）。扩展现有 `checkAgentWorkflowContract`。
- **不修改现有 `agent-facing.routing-eval.jsonl`**：该文件是 TS router 评估文件，现有 natural→`deep_recall` 是 TS 层语义（router 内部 next_tool）。skill-layer smoke 是独立 contract 层（MCP tool 语义），混入同文件会制造两层语义冲突。skill-layer smoke fixture 内联在 bun:test，不追加进 `agent-facing.routing-eval.jsonl`。
- TS router **不动**；现有 `*.routing-eval.jsonl` 用例**不动**。

### 3.9 Hermes 加载契约与 release gate

- **安装契约**（本 issue 明确声明）：Hermes 扫描 target root 的 `SKILL.md`。本 issue 保证"加载路径同源"——canonical pack 的根 `SKILL.md` 通过修正后的安装形状直达 target root。
- **真实 Hermes 加载 smoke**：列为**合并后 release gate**，不在本 issue 实现。spec 明确记录，不塞进 `known-issues.md` 引用。
- `known-issues.md` 矛盾（"Hermes 不读 SKILL.md"）：本 issue 不解决 Hermes 运行时是否读 SKILL.md；文档交叉引用 `known-issues.md` 说明"加载路径同源由本合同保证，运行时读取行为由合并后 release gate 验证"。

## 4. 测试方案（TDD，先写失败测试）

1. `tests/cli/skill-pack.test.ts`（扩展现有 715 行）：
   - canonical 无 MANIFEST → `MANIFEST_MISSING`
   - `MANIFEST.packVersion ≠ version.ts` → `VERSION_MISMATCH`
   - `files[]` 重复 / 绝对路径 / `..` / 含 MANIFEST 自身 → `MANIFEST_INVALID`
   - canonical `files[]` ≠ skills/ 实际文件集合 → `INVENTORY_MISMATCH`（manifest 多列磁盘无 / 磁盘有 manifest 漏）
   - `ENTRY_FILES` 缺失 → `MANIFEST_INVALID`
   - target 路径不存在 → `target.status=missing` + exit 1（非异常信封）
   - target 空目录 → `incompatible`（非 missing）
   - target 存在无/坏 MANIFEST → `incompatible`
   - target version 不匹配 → `incompatible`
   - target `files[]` 手改（≠ canonical）→ `incompatible`
   - target version 等 + `files[]` 等 + 文件改 → `stale`
   - target 全匹配 → `current`
   - canonical fail + target 不存在 → `target.status=unverified`（不展示安装命令）
   - canonical pass + target stale → `verificationStatus=pass, status=fail`
   - 安装命令展示条件：仅 `verificationStatus !== fail && target.status === missing`
   - 隐私断言扩展：JSON 含 `packPath`/`target.path` 但无正文/credential/无关私人路径
   - 现有 36 测试不破坏
2. `tests/bin/check-docs-consistency.*.test.ts`：
   - install-target ≠ `~/.hermes/skills/brain-ops/cbrain`（精确路径）→ fail
   - `MANIFEST.packVersion ≠ package` → fail
3. routing：三类 skill-layer contract bun:test（doc-contract 断言 RESOLVER/query/brief 路由规则，**不过 TS router**，**不改 `agent-facing.routing-eval.jsonl`**）。
4. 验收命令：`bun run check:docs` + focused tests + `bun run lint` + `bun run check` 全绿；`git diff --check` + 隐私扫描通过。

## 5. 验收标准（issue 6 条 + 5 点修正）

1. `cbrain skill-pack` 能区分 canonical pack 与匿名 stale target（`--target` current/stale/incompatible/missing/unverified 五态）。
2. 安装文档保证 Hermes 根 skill entrypoint 与 canonical pack 同源，不依赖嵌套目录被隐式加载。
3. target verification 全程只读，不自动替换/删除 target 目录（CLI 零写路径 + 无写 flag）。
4. operational / natural / debug 三类匿名 fixture 路由正确。
5. `bun run check:docs`、focused tests、`bun run lint`、`bun run check` 全绿。
6. `git diff --check` 和隐私扫描通过。

审核修正点全部纳入：`unverified` 最高优先 + `missing` 收紧（空目录归 `incompatible`）、MANIFEST 全文件 + schema/exact-inventory/target 等价校验 + `ENTRY_FILES`、安装命令收紧（仅 missing 展示）、隐私边界允许操作路径、`verificationStatus`/`status` 语义 + packVersion gate + Hermes smoke 列为合并后 release gate。

## 6. 残余风险

- **`github:<owner>/cbrain` 硬编码**：install-onboarding.md 里功能性公开 install source（lines 31/55/445），非私人数据但隐私扫描可能命中。本 issue 不动，由产品方决定是否抽象为占位。
- **Hermes 真实加载行为未验证**：本 issue 只保证加载路径同源 + skill-layer contract fixture，真实 Hermes 是否读 SKILL.md 留合并后 release gate。若 Hermes 运行时确不读 SKILL.md，则部署合同的运行时价值取决于该 gate 结论。
- **skill-layer contract 覆盖度**：三类 smoke 是 doc-contract 断言（规则文本存在），不验证 Hermes 运行时真实分类行为——那是合并后 release gate 的职责。

## 7. 不做（守 #334 边界）

不扩展 TS router / 不改 MCP tool handler / 不改 tool profile / 不开 structured output / CLI 不实现自动安装 / 不解决 Hermes 是否读 SKILL.md / 不改 github 硬编码。
