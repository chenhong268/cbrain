# CBrain Agent 协作分工

> 小爱（Hermes Agent）与 Claude Code 的协作协议。
> 最后更新：2026-05-17

## 角色

| | 小爱（Hermes Agent） | Claude Code |
|:---|:---|:---|
| **定位** | 产品经理 + QA + 外围工具 | 内核开发者 |
| **主要语言** | Python / Shell | TypeScript / Bun |
| **工作环境** | Hermes gateway (Telegram) | 终端 / VS Code |
| **代码权限** | 可提 PR，不直接 push main | 直接 push main |
| **Git author** | 小爱 <xiaoi@hermes> (PR only) | chenhong (直接 push) |

## 小爱的职责

### 1. 日常使用 + 问题发现
- 通过 MCP/HTTP API 使用 CBrain 全部功能
- 发现 bug 时记录：现象、复现步骤、根因分析（读源码后的判断）
- 发现需求时记录：使用痛点、期望行为、建议方案

### 2. Issue 提交
- 通过 `gh issue create --repo chenhong268/cbrain` 提交
- 统一使用以下模板：

```markdown
## 类型
bug / feature / performance

## 现象
（从使用侧观察到的）

## 复现步骤
1. ...

## 根因分析（如果能定位）
（读源码后的判断，或标注"未定位"）

## 建议修复方向
（如果有想法）

## 影响范围
（影响日常使用的哪些场景）
```

- 标签：`from:xiaoai`（小爱提的）/ `from:claude-code`（Claude Code 提的）

### 3. 外围工具开发
范围：Hermes plugin、shell hook、cron 脚本、辅助脚本（如清理、3D 可视化）

- Hermes plugin → `~/.hermes/plugins/` 目录，小爱直接写
- 辅助脚本 → skill 的 `scripts/` 目录
- 如果外围工具需要 CBrain 新增 API → 先提 issue，Claude Code 加 endpoint，小爱再调用

### 4. 数据维护
- health / sync / dream / cleanup / compact 日常操作
- NER stub 清理、链接补全、实体去重合并
- Profile 维护

### 5. 集成测试
- Claude Code 改完代码后，小爱在真实环境验证
- 在 issue 里回复验证结果（通过 / 未通过 + 具体现象）

### 6. PR 提交（偶尔）
当小爱能确认修一个简单 bug 时：
1. `git checkout -b fix/issue-N`
2. 改代码 + `bun test`
3. `gh pr create` → Claude Code 审查 + 合并

## Claude Code 的职责

### 1. Feature 开发
- TypeScript 代码实现
- 性能优化（SQLite 调优、内存优化、查询加速）
- 新 MCP tool / HTTP endpoint 开发

### 2. Bug 修复
- 根据 issue 描述定位代码级根因
- 修复 + 写测试
- Push main + 关闭 issue

### 3. 代码审查
- 审查小爱的 PR（如果有的话）
- 确认不引入回归

## 协作流程

```
小爱日常使用 → 发现问题/需求
  ↓ gh issue create（标 from:xiaoai）

Claude Code 按 issue 列表开发
  ↓ 完成后 push main + 关闭 issue

小爱验证
  ↓ CBrain 重启 → 实际场景测试 → issue 里回复验证结果
  ↓ 如果还有问题 → 重新打开 issue
```

## 紧急 Bug

MCP 宕机、数据丢失风险等紧急情况：
- 不走 issue 流程
- 小爱直接在对话中告知宏哥
- 宏哥决定是否让 Claude Code 紧急修复

## Git 约定

- 分支命名：`fix/issue-N` / `feat/issue-N`（N = issue 编号）
- Commit message：`feat:` / `fix:` / `perf:` / `docs:` / `chore:`
- 小爱只通过 PR 提交，不直接 push main

## 已知边界

- 小爱对 TS 代码库的修改需要 Claude Code 审查
- 小爱不跑 CBrain 测试套件，验证靠集成测试（真实环境）
- 两人不同时改同一模块的代码，避免冲突
