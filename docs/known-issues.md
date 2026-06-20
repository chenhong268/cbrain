# Known Issues

> Current as of v1.9.6. 本文件只记录**当前版本**已知问题与安全恢复方法；历史问题随版本修复后移除。

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
- ⚠️ **慎用 `cbrain serve --force`**：它会跳过 PID 锁检查，若仍有活动进程在跑，两个进程并发操作同一索引会损坏数据。仅在你 100% 确定无活动进程时用。

## Agent 不读 SKILL.md（适用于 Hermes 等运行时）

- **症状**：修改 skill 文件并重启 Agent 后，Agent 不遵循新规则。
- **原因**：部分 Agent 运行时（如 Hermes）只读主记忆文件，不读 SKILL.md。
- **规避**：把关键规则写入 Agent 的主记忆文件（如 MEMORY.md），SKILL.md 仅作参考文档。
