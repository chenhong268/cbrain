# Recall Resolver — Tool 层路由表

> 意图 → MCP 工具。与 skill 层 RESOLVER.md 互补：那个决定加载哪个 skill 文件，这个决定调哪个 MCP 工具。

## 决策树

```
用户提问涉及 CBrain 知识
│
├─ "关于X的一切"？
│   信号：回忆、详细了解、深入了解、怎么样、什么来头、关于X的上下文
│   → deep_recall
│   → 遇到 stub → expand_entity 补充
│
├─ "给我一个全景"？
│   信号：总结、概览、全面、全貌、梳理、overview、帮我理一下
│   → summarize
│   → 遇到 stub → expand_entity 补充
│
├─ "结构化档案"？
│   信号：完整档案、dossier、RAGmap、信息表、详细档案
│   → dossier
│   → 区别：review 是叙事式，dossier 是结构化表格
│
├─ "帮我分析/推理"？
│   信号：分析、联想、知识缺口、cross-domain、背后逻辑、有什么联系
│   → brain_storm
│
├─ "XX和YY什么关系"？
│   信号：什么关系、怎么认识的、有什么联系、之间
│   → graph_query(mode=traverse, depth=2)
│   → 深度分析 → connect skill
│
├─ "最近有什么发现"？
│   信号：有什么发现、漏掉的、关联没注意到、洞察
│   → list_insights + read_discoveries
│
├─ "时间线/事件回顾"？
│   信号：时间线、发生了什么、历史记录、什么时候
│   → get_timeline
│
├─ "这两个重复了"？
│   信号：合并、重复页面、一样的
│   → merge_pages(source, target, dryRun=true)
│   → 注意：必须先 dryRun=true 预览
│
├─ "快速查找"？
│   信号：搜、找、有没有、查一下、谁在XX、XX认识谁
│   → query
│   → 需要完整信息？→ expand_entity
│
├─ 追问某个具体实体？
│   信号：多说说、展开、细节、详细看这个
│   → expand_entity（需先有 slug）
│
└─ 不确定
    → query（最轻量，安全默认）
```

## 禁止模式

```
❌ query + get_page + get_links + get_timeline 连调 → deep_recall 一次搞定
❌ 总结类请求用 query → summarize
❌ 无 slug 直接调 expand_entity → 先 query/deep_recall/summarize 拿 slug
❌ deep_recall 连调多次 → 一次搞定，limit 调大
```

## 工具能力速查

| 工具 | 返回内容 | 适用场景 |
|------|---------|---------|
| deep_recall | body + links + timeline + tags + related + insights | 需要完整上下文 |
| summarize | 图遍历 + 结构化概览 + 可配置深度 | 需要全局鸟瞰 |
| dossier | 结构化档案（基本信息 + 关系 + 时间线 + 洞察） | 需要表格化档案 |
| brain_storm | LLM 推理 + 缺口分析 + 跨域关联 | 需要分析和推理 |
| graph_query | 关系遍历（traverse/backlinks/related） | 查两个人/公司关系 |
| list_insights | 系统自动生成的洞察列表 | 发现漏掉的关联 |
| read_discoveries | 跨域关联发现 | 深度发现 |
| get_timeline | 按时间排列的事件流 | 时间线回顾 |
| merge_pages | 合并结果预览 + 执行 | 合并重复页面（先 dryRun） |
| query | slug + title + snippet | 快速搜索，轻量 |
| expand_entity | 单实体的详细信息 | 追问已知实体 |
