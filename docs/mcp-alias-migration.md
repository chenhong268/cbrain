# MCP 别名迁移说明

当前版本保留全部旧工具名，现有 MCP 客户端无需立刻修改。本表只帮助
仓库内调用方和外部客户端逐步改用统一入口；旧入口在下一次**主版本**
变更前仍保持可用。CBrain 不会根据本表自动替换任何客户端调用。

| 旧工具名 | 统一工具与 action |
| --- | --- |
| `get_tags` | `tag({ action: "list" })` |
| `add_tag` | `tag({ action: "add" })` |
| `remove_tag` | `tag({ action: "remove" })` |
| `add_alias` | `alias({ action: "add" })` |
| `remove_alias` | `alias({ action: "remove" })` |
| `get_links` | `link({ action: "list" })` |
| `add_link` | `link({ action: "add" })` |
| `remove_link` | `link({ action: "remove" })` |
| `job_submit` | `job({ action: "submit" })` |
| `job_list` | `job({ action: "list" })` |
| `job_status` | `job({ action: "status" })` |
| `job_cancel` | `job({ action: "cancel" })` |
| `job_retry` | `job({ action: "retry" })` |
| `batch_delete_pages` | `batch({ action: "delete_pages" })` |
| `batch_add_links` | `batch({ action: "add_links" })` |
| `batch_merge_pages` | `batch({ action: "merge_pages" })` |
| `get_profile` | `profile({ action: "get" })` |
| `update_profile` | `profile({ action: "update" })` |
| `remove_profile` | `profile({ action: "remove" })` |
| `reload_profile` | `profile({ action: "reload" })` |
| `list_insights` | `insight({ action: "list" })` |
| `get_insight` | `insight({ action: "get" })` |
| `archive_insight` | `insight({ action: "archive" })` |
| `dismiss_insight` | `insight({ action: "dismiss" })` |
| `query_insights` | `insight({ action: "query" })` |
| `promote_discovery` | `insight({ action: "promote_discovery" })` |

日常 Agent 只可调用其 20 个受限工具。上表中的统一工具若不在该身份的
权限范围内，不能为了迁移而提高权限；请显式使用既有 debug、maintenance
或 full 身份，并遵循该身份的安全流程。
