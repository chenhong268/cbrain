# 场景-功能映射索引

> 用户该用什么功能？这份索引帮你快速定位。
> Agent 读取 RESOLVER.md 路由后，可用本索引做功能推荐和主动提示。
> **默认前门是 `cbrain_recall`**：自然语言回忆/核查/找人/层级/总结/关系/判断首选它（CBrain 内部分发）。低层工具（`deep_recall` / `summarize` / `dossier` / `brain_storm` / `query` / `expand_entity`）只在 advanced escape hatch / debug / fallback 场景出现，不是默认首选。

## 映射表

### 1. 深度了解某人/某事
- **触发**：这人怎么样 / 帮我了解XX / XX是什么来头 / 关于XX的一切
- **工具**：`cbrain_recall(query, detail:"normal")`（默认前门，内部 overview/content 分发）
- **注意**：一步出完整画像（关系、时间线、富化），不要用 query 拼凑
- **追问**：拿到 slug 后可用 `expand_entity`（debug/fallback）补充细节

### 2. 两人/两公司什么关系
- **触发**：XX和YY什么关系 / 怎么认识的 / 有什么联系 / 之间
- **工具**：`cbrain_recall`（默认，内部 relationship 分发）
- **advanced escape hatch**：`graph_query(mode='traverse', depth=2)`（仅当前门不足以表达时直调）
- **深度分析**：走 connect.md skill 做完整关系分析

### 3. 全景概览/总结
- **触发**：总结 / 梳理 / 全貌 / 概览 / overview / 帮我理一下
- **工具**：`cbrain_recall`（默认，内部 overview 分发）
- **advanced escape hatch**：`summarize(slug, depth=1)`（debug/internal profile 工具，图遍历概览）
- **注意**：不要用 query；cbrain_recall 一步给全局鸟瞰

### 4. 结构化档案页
- **触发**：这个人的全貌 / 完整档案 / dossier / RAGmap / 详细档案
- **工具**：`cbrain_recall`（默认前门）
- **advanced escape hatch**：`dossier(slug)`（debug/internal profile 工具，结构化档案：基本信息 + 关系网络 + 时间线 + 洞察）
- **区别**：review 是叙事式，dossier 是结构化表格

### 5. 头脑风暴/分析推理
- **触发**：分析一下 / 联想 / 知识缺口 / cross-domain / 有什么盲点 / 帮我想想
- **工具**：`cbrain_recall`（默认，内部 reasoning 分发）
- **advanced escape hatch**：`brain_storm(query)`（debug/internal profile 工具，LLM 推理 + 缺口分析 + 跨域关联）
- **注意**：不要用 query；cbrain_recall 推理一步搞定

### 6. 快速查找
- **触发**：搜 / 找 / 有没有 / 查一下 / 谁在XX / XX认识谁
- **工具**：`cbrain_recall(query, detail:"brief", limit:3)`（默认前门，自然语言首选）
- **advanced escape hatch / debug**：`query(query, limit=10)`（仅精确关键词定位/debug，自然语言禁用）
- **后续**：找到后可 `expand_entity`（debug/fallback）看详情

### 7. 展开实体/补充细节
- **触发**：多说说 / 展开 / 详细看这个 / 补充 / 丰富 / 完善
- **工具**：`expand_entity(slug)`（追问已知实体，debug/fallback）
- **前置**：需要先有 slug（通过 cbrain_recall 获取，默认前门）

### 8. 合并重复页面
- **触发**：这两个重复了 / 合并 / 一样的 / 重复页面
- **工具**：`merge_pages(source, target, dryRun=true)` 先预览，确认后执行
- **注意**：先 dryRun=true 看影响范围，再正式合并

### 9. 发现与洞察
- **触发**：最近有什么发现 / 有什么我漏掉的 / 有什么关联没注意到的
- **工具**：`list_insights()` + `read_discoveries()`
- **区别**：insight 是系统自动生成的洞察，discovery 是跨域关联发现

### 10. 时间线/事件回顾
- **触发**：时间线 / 事件 / 发生了什么 / 历史记录 / 什么时候
- **工具**：`get_timeline(slug)` — 按时间排列的事件流
- **补充**：`add_timeline_entry` 可手动添加事件

### 11. 帮我写/生成内容
- **触发**：帮我写 / 写段介绍 / 写周报 / 朋友圈 / 生成文案 / 写报告
- **工具**：走 write.md skill — 基于知识库内容生成（素材用 cbrain_recall 取）
- **注意**：不是让 Agent 瞎编，是从 CBrain 已有知识中提取素材

### 12. 导入/录入内容
- **触发**：导入 / 录入 / 记一下 / 保存 / 收录 / 存入 / 这段内容
- **工具**：`ingest(content, type, title, tags)` — 自动分块、NER、建边
- **格式**：text 或 markdown

### 13. 标签管理
- **触发**：打个标签 / 加标签 / 标签管理 / 按标签找
- **工具**：`add_tag` / `remove_tag` / `get_tags`
- **批量**：`batch_add_tags` 批量打标

### 14. 清理/去重
- **触发**：清理 / 去重 / 整理 / 有什么该删的 / 大脑整理
- **工具**：走 cleanup.md skill — 引导式清理（重复、孤儿、过期 stub）
- **注意**：不自动删除，列出来让用户确认

### 15. 维护/同步
- **触发**：同步 / sync / 重新索引 / 体检 / 健康检查
- **工具**：`sync()` 或 `dream()`（夜间全量维护：sync + enrich + cleanup + health）
- **定时**：`dream.md` 完整 5 步维护流水线

### 16. 层级/分类
- **触发**：分类 / 层级 / 上下级 / 属于哪个 / 子分类
- **工具**：hierarchy 相关工具 — 建立和管理实体层级关系

### 17. 反馈/纠错
- **触发**：这个信息不对 / 纠正 / 反馈 / 投诉 / 错了
- **工具**：`record_feedback(query, relevant_slugs?, irrelevant_slugs?, note?)` — 标记某次查询结果中哪些 slug 有用 / 无用，CBrain 据此调整学习权重（有用加权、无用衰减）。必须带上原始 query，不是通用投诉通道

### 18. 配置调整
- **触发**：改一下配置 / 调整参数 / 配置
- **读取**：`cbrain config` — 查看当前配置
- **修改**：`cbrain config --set key=value` — 用户明确确认后执行（如 `cbrain config --set ner.enabled=false`）

### 19. 复杂多步研究（EXPERIMENTAL）
- **触发**：A和B的差异/取舍/哪个更适合 / 我还遗漏了什么/盲区 / A、B、C之间有什么内在联系 / 这个结论依据够不够
- **工具**：`cbrain_recall`（默认前门，内部 reasoning 分发）
- **advanced escape hatch**：`agentic_research({ query, detail, known_slugs, intent_hint })`（EXPERIMENTAL，debug/internal profile，多步管道）
- **注意**：多步管道仅用于需要交叉验证的复杂研究，不是默认路由
- **不要用 agentic_research 的场景**：单一实体查找→cbrain_recall；简单搜索→query（debug）；找人→cbrain_recall（recall_episode）；核查→cbrain_recall（grounded 内部）

## 速查：容易混淆的功能

| 你想… | 用 | 不要用 |
|--------|-----|--------|
| 了解一个人/公司的全貌 | cbrain_recall | query（debug，太浅） |
| 全局概览某个领域 | cbrain_recall（overview） | query（debug，太零散） |
| 看两个人的关系 | cbrain_recall（relationship） | query（debug，没有关系推理） |
| 分析和推理 | cbrain_recall（reasoning） | query（debug，只检索不推理） |
| 写内容 | write skill（素材走 cbrain_recall） | 不要 Agent 瞎编，用 CBrain 知识 |
| 结构化档案 | cbrain_recall | review（叙事式 vs 结构化） |
| 合并重复 | merge_pages(dryRun=true) | delete_page（会丢数据） |

## 反模式

```
❌ query + get_page + get_links + get_timeline 连调 → cbrain_recall 一次搞定
❌ 总结类请求用 query → cbrain_recall（overview 内部分发）
❌ 无 slug 直接调 expand_entity → 先 cbrain_recall 拿 slug（expand_entity 是 debug/fallback）
❌ "帮我了解XX" 用 query → cbrain_recall
❌ 合并前不 dryRun → 必须先 dryRun=true 预览
```
