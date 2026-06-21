# Known Issues

> Current as of v1.9.6. 本文件只记录**当前版本**已知问题与安全恢复方法；历史问题随版本修复后移除。

## 多个 `cbrain serve` 进程共写同一 profile（已修复，#208 phase 1）

- **症状（修复前）**：同一 profile 同时跑 `cbrain serve --http` 和一个或多个 `cbrain serve`（stdio）——并发写 `brain.sqlite` 与 LanceDB 索引，表现为 `database is locked`、LanceDB `Too many concurrent writers`、Rust 侧 panic、端口绑定失败、MCP stdio 管道异常关闭。
- **原因**：旧版 PID 锁是 transport-scoped / lock-id-scoped 的，HTTP 与各 stdio（不同 `CBRAIN_LOCK_ID`）进程互相看不见，可同时打开同一数据库。
- **修复（phase 1）**：profile-wide single-writer gate。启动时若发现已有活跃的 write-capable runtime 持有该 profile，直接拒绝启动（fail fast），且**在打开 SQLite/LanceDB 之前**就拒绝。stale（死进程）pid 文件自动清理。
- **`cbrain serve --force` 不再绕过 writer gate**：它只保留跳过 stale 清理的旧语义，不影响 gate。要让一个 profile 同时存在多个 writer，唯一（不安全）途径是环境变量 `CBRAIN_UNSAFE_ALLOW_MULTI_WRITER=1`。
- **多 Agent 共享同一个 brain 的正确姿势**：只跑**一个** `cbrain serve --http`，让各 Agent 连它。（phase 2 将为 HTTP serve 增加 MCP-over-HTTP，使 stdio 客户端可连 HTTP runtime；phase 3 迁移 Hermes。）
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
