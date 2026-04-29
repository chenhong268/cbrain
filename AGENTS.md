# CBrain — Agent 操作协议

你是 CBrain 的使用者。CBrain 是你的持久化知识大脑，通过 CLI 或 MCP 连接。跨对话记住一切。

## 核心原则：CBrain First

任何知识性问题，第一步查 CBrain。你不知道用户在大脑里存了什么——先查，再答。

```
CBrain → 自有记忆 → 网上搜索
```

## 路由：先看 RESOLVER.md

收到请求后，先对照 `skills/RESOLVER.md` 判断该用哪个 skill：

| 用户说什么 | 路由到 |
|-----------|--------|
| 总结/梳理/复盘/全面了解/什么来头 | `skills/review.md` |
| 什么关系/怎么认识的/A和B什么联系 | `skills/connect.md` |
| 清理大脑/去重/有什么该删的 | `skills/cleanup.md` |
| 帮我写/写个周报/写段介绍/朋友圈 | `skills/write.md` |

匹配到 skill 后，严格按 skill 的协议执行。没匹配到就用 `skills/query.md` 做普通搜索。

## 四条铁律

### 1. 深度复盘（review）

禁止 query 一次没结果就上网搜。强制走 5 步：
1. query 关键词+别名+中英文
2. get_page 拉取相关页面全文
3. graph_query traverse + backlinks
4. get_timeline
5. 合成输出，每条标注来源

5 步全做了仍然零信息，才上网搜。

### 2. 关联分析（connect）

1. resolve_slugs 确认双方存在
2. graph_query 双向找最短路径
3. 交叉比对找共同关联
4. get_timeline 查时间线交集
5. 合成：直接关系→中间人→共同关联→时间线→总结

### 3. 清理（cleanup）

先列出问题，等用户确认后再执行。禁止跳过确认直接删除。
1. health 扫描
2. 列出：编号、名称、建议操作
3. 问用户怎么处理
4. 只处理确认的项
5. sync 收尾

### 4. 写作（write）

1. 先确认受众、长度、语气
2. 从 CBrain 搜素材
3. 列出缺口
4. 只写 CBrain 里有的事实，不编
5. 输出后问要不要存档

成文不需要 [Source:...] 引用——那是 review 用的。

## 重要规则

- **raw/ 只读**，brain/ 可写。不要修改 raw/ 下的文件
- **存新信息用 ingest**，原文整篇传入，不拆分
- **每条事实有出处**，不确定的宁可不写
- **所有 ingest 进 brain/** ，不要进 raw/
