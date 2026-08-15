# Known Issues

> 本文件记录仍适用的已知问题与安全恢复方法；历史问题随版本修复后移除。

## serve 启动遇数据库外键违规（FK violation，#209）

- **症状**：`cbrain serve` 启动报「外键一致性检查未通过」,exit 1,不进 HTTP/MCP/watcher。诊断给出按表统计的孤儿引用数 + 修复命令。
- **原因**：legacy 数据在 derived 表(tags/chunks/links/等)留了引用已删除 page 的孤儿行;migration 的 FK check 拦下。
- **安全恢复**：
  1. `cbrain repair-fk`（dry-run,查看各表孤儿数,不改 DB）
  2. `cbrain repair-fk --execute`（删孤儿 derived 行,atomic,前后 FK check,不动 page/markdown）
  3. 重启 `cbrain serve`
- ⚠️ serve **不自动修复、不带病启动**——FK 违规是数据一致性问题,必须显式修复。

## 多个 `cbrain serve` 进程共写同一 profile（已修复，#208 phase 1）

- **症状（修复前）**：同一 profile 同时跑 `cbrain serve --http` 和一个或多个 `cbrain serve`（stdio）——并发写 `brain.sqlite` 与 LanceDB 索引，表现为 `database is locked`、LanceDB `Too many concurrent writers`、Rust 侧 panic、端口绑定失败、MCP stdio 管道异常关闭。
- **原因**：旧版 PID 锁是 transport-scoped / lock-id-scoped 的，HTTP 与各 stdio（不同 `CBRAIN_LOCK_ID`）进程互相看不见，可同时打开同一数据库。
- **修复（phase 1）**：profile-wide single-writer gate。启动时若发现已有活跃的 write-capable runtime 持有该 profile，直接拒绝启动（fail fast），且**在打开 SQLite/LanceDB 之前**就拒绝。stale（死进程）pid 文件自动清理。
- **`cbrain serve --force` 不再绕过 writer gate**：它只保留跳过 stale 清理的旧语义，不影响 gate。要让一个 profile 同时存在多个 writer，唯一（不安全）途径是环境变量 `CBRAIN_UNSAFE_ALLOW_MULTI_WRITER=1`。
- **多 Agent 共享同一个 brain 的正确姿势（phase 2 已完成）**：只跑**一个** `cbrain serve --http`，它现在在 `/mcp` 暴露 **MCP-over-HTTP** 端点（Streamable HTTP）。各 Agent（A/B/C、cron）作为独立 MCP client 连 `http://127.0.0.1:<port>/mcp`，各自 session、共享同一个 DB/LanceDB/watcher runtime。**禁止**为多 Agent 各自 spawn `cbrain serve`（stdio）—— single-writer gate 会挡，且并发写会损坏数据。
  - 拓扑：
    ```text
    Agent A ┐
    Agent B ├── MCP-over-HTTP ──> 单个 cbrain serve --http（唯一 writer）
    Cron   ┘                         ├─ SQLite/LanceDB writer
                                     ├─ watcher
                                     └─ /mcp（多 session，自动清理）
    ```
  - stdio MCP 仍保留（单机/调试），但生产多 Agent 一律走 HTTP MCP。
  - phase 3（待办）：Hermes `~/.hermes/config.yaml` 把 stdio profile 迁移到 HTTP MCP endpoint。
- ⚠️ **`CBRAIN_UNSAFE_ALLOW_MULTI_WRITER=1` 仅用于救援/调试**：会并发写数据库、损坏数据。启用时日志打 UNSAFE banner。不写入任何推荐配置或 README。

## LanceDB 向量索引损坏（`LanceDB connection failed`）

- **症状**：`cbrain query` 或 `cbrain serve` 报向量库连接/读取失败。
- **原因**：`lancedb/` 索引文件损坏（异常退出、磁盘问题）。
- **安全恢复**：先 `cbrain backup` 备份、`cbrain doctor` 诊断，再按场景重建向量：
  - **单页损坏**：`cbrain sync --slug <page-slug> --reindex`（per-page 重建，不丢数据）
  - **watcher 隔离页**：`cbrain sync --reindex-quarantined`（恢复被 watcher 隔离的向量故障页）
  - **整库损坏**：`cbrain sync --reindex-vectors`（从 SQLite chunks 原子重建整个 LanceDB）
- ⚠️ **切勿直接删除 `lancedb/` 目录** —— 先备份，再用上面的安全命令重建。
- ⚠️ **重建前先停止 `cbrain serve`**：单页/隔离恢复会拒绝在活动 serve 持有索引时运行。

## Watcher / PID 锁残留（`watcher lock`）

- **症状**：`cbrain serve` 报锁占用，无法启动。
- **原因**：上次进程非正常退出，PID 锁文件残留。
- **安全恢复**：先 `cbrain doctor` 确认无活动 serve 进程（`pgrep -f 'cbrain.*serve'`）；确认是 stale 锁后，删除 `<profile>/cbrain-http.pid` 或 `<profile>/cbrain-stdio.pid` 再重启。
- ⚠️ **慎用 `cbrain serve --force`**：它会跳过 stale PID 清理；若仍有活动进程在跑，并发操作同一索引会损坏数据。仅在你 100% 确定无活动进程时用。（`--force` 不绕过 phase-1 writer gate，见上。）

## Agent 不读 SKILL.md（适用于 Hermes 等运行时）

- **症状**：修改 skill 文件并重启 Agent 后，Agent 不遵循新规则。
- **原因**：部分 Agent 运行时（如 Hermes）只读主记忆文件，不读 SKILL.md。
- **规避**：把关键规则写入 Agent 的主记忆文件（如 MEMORY.md），SKILL.md 仅作参考文档。
