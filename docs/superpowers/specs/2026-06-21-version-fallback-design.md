# version.ts Runtime Fallback — Design

> 关联 issue: #211 `bug: packaged Bun executable crashes reading //package.json`
> 日期: 2026-06-21
> 状态: Draft（待 review）

## Problem

打包的 Bun 可执行文件（`bun build --compile`）启动时崩：

```
ENOENT: no such file or directory, open '/$bunfs/package.json'
```

`--version` / `--help` / `serve` 全部受影响。

## Root Cause

`src/version.ts` 在模块加载时同步读 `../package.json`：

```ts
const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
export const version = pkg.version;
```

`import.meta.url` 在 compiled binary 里指向虚拟 `$bunfs`，`../package.json` 解析成 `/$bunfs/package.json`，不存在 → ENOENT。

`version` 被 4 处 import：
- `src/cli/program.ts:2`（commander `.version()`）
- `src/cli/commands/skill-pack.ts:16`
- `src/http/server.ts:9`（MCP server name/version）
- `src/mcp/server.ts:9`（MCP server version）

任何启动路径碰到其中之一就崩——不只是 `--version`，是**整个 cbrain 启动**。

source checkout 和 npm installed package 模式下 `package.json` 在位（npm 默认总是带 package.json），当前代码能工作。**只有 compiled binary 崩。**

## Design Decision

**方案：Runtime fallback**（issue 验收明确允许 "safe fallback that never crashes"）。

不引入 build 步骤 / generated module，理由：
- compiled binary 是 v1.0.0（2026-05-05）引入的历史能力，当前 `package.json` 无 build/compile 脚本，phase-3 主分发走 npm install + HTTP MCP。
- 验收核心是 *never crashes*，fallback 满足。
- 零侵入：`export const version` 签名不变，4 处引用零改动。

## Implementation

### `src/version.ts`

```ts
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

/** 版本解析全部失败时的回退值（compiled binary 等无 package.json 场景）。 */
export const FALLBACK_VERSION = "0.0.0-unknown" as const;

type FileReader = (path: string) => string;

/**
 * 安全解析当前版本号。
 * - source / npm installed：读 import.meta.url 相对的 ../package.json
 * - compiled binary ($bunfs) 或 package.json 缺失/损坏：回退 FALLBACK_VERSION
 *
 * 通过依赖注入 read 函数实现可测，避免 bun module mock。
 */
export function readPackageVersion(read: FileReader = readFileSync): string {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
  ];
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(read(pkgPath)) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // 路径不存在 / JSON 损坏 / 字段无效 → 尝试下一个候选
    }
  }
  return FALLBACK_VERSION;
}

export const version: string = readPackageVersion();
```

关键点：
- `export const version` 签名不变 → 4 处引用零改动。
- 类型守卫 `{ version?: unknown }` + `typeof === "string"` + 非空 → 不信任外部 JSON（符合 TS coding-style）。
- `candidates` 数组预留扩展点：未来真要 compiled 注入真实版本号，只需加一个候选（如编译期常量），不必重构。

### `tests/version.test.ts`（新建，TDD RED 先行）

通过 DI 注入 mock `read`，纯 unit，不碰真实 package.json（不硬编码版本号，遵循 CHANGELOG 既定规矩）：

| 场景 | 注入 read 返回/行为 | 期望 |
|:---|:---|:---|
| 正常解析 | `'{"version":"9.9.9"}'` | `"9.9.9"` |
| 真实默认读取 | 不注入（默认 readFileSync） | 非空 string，不抛 |
| compiled binary (ENOENT) | 抛 Error | `FALLBACK_VERSION`，不抛 |
| malformed JSON | `'{'` | `FALLBACK_VERSION` |
| version 字段缺失 | `'{}'` | `FALLBACK_VERSION` |
| version 非 string | `'{"version":123}'` | `FALLBACK_VERSION` |
| version 空串 | `'{"version":""}'` | `FALLBACK_VERSION` |

## Out of Scope

- 不加 build/compile 脚本。
- 不改 `bin/check-install-smoke.sh`（Stage 2 已覆盖 version 路径，source/installed 仍给真实版本号，断言照过；本期只验证它不断）。
- 不改 4 处 version 引用。
- 不接 `--define` / generated 注入（`candidates` 数组留作未来钩子，本期不启用）。

## Acceptance Criteria 对照

issue 验收逐条：

- [x] `cbrain --version` 不崩（source + packaged）：fallback 保证不抛
- [x] `cbrain --help` / `cbrain serve --help` 不需读 package.json：version fallback 不抛
- [x] install smoke 覆盖 version 路径：现有 Stage 2，验证仍 pass
- [x] 测试用匿名/mock 数据
- [x] `bun run check` 通过
