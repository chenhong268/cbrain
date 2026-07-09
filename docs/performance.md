# 性能基准与可复现性（Performance）

> CBrain 的发布性能门禁以「确定性 operation-count budget」为主轴，**不以 wall-clock 时间为门槛**。时间随硬件、数据规模、缓存命中、LLM provider 抖动而变，不可复现；query count 不会。本文告诉你怎么跑基准、怎么读输出、哪些数是本地验收、哪些是产品声明。

## 设计立场：为什么不用「毫秒级」当门禁

一个裸的绝对声明（"query 50ms"）无法复现——换一台机器、换一个数据规模、冷启 vs 热启，数字都不同。所以 CBrain 的性能保障分两层：

1. **确定性 query-count budget**（`gate:perf`）—— 同样的匿名 fixture、同样的 journey，正确实现的 batch 路径每次跑出的 SQL 次数恒定，与硬件无关。一个 per-page N+1 回归会让次数随数据量爆炸，被门禁确定性地抓住，无需任何计时。
2. **wall-clock 只用作 hang ceiling**（5000ms）—— 只防卡死，不当性能门槛。

要看你自己硬件上的真实延迟，用 `cbrain perf-diagnose`——它报的是**你这个 brain** 的观测值，明确标成观测，不是产品基准。

## 三套观测

| 观测 | 看什么 | 数据 | 何时用 |
|:-----|:------|:-----|:------|
| `cbrain perf-diagnose` | 你这个 brain 的真实慢 journey 分布 | 运行时 telemetry（warm） | 日常诊断「为什么慢」 |
| `bun run gate:perf` | 确定性合成基准（匿名 fixture） | 65 页 / 65 chunks（cold） | 发版前验收 |
| `bun run gate:v2-preflight` | 发布聚合 go/no-go | 7 个 gate 合跑 | 发版 go/no-go |

## 1. `cbrain perf-diagnose` — 运行时观测

只读。打开 SQLite brain 时强制 `readonly`（永不写、永不迁移），读已有的 telemetry（`search_trace_sessions` / `search_trace_steps` / `query_log` / `search_log`），聚合出慢 journey 的时间和预算花在哪。安全维度 only——永不暴露 query 原文、slug、路径、credential。

### 跑

```
cbrain perf-diagnose                                  # 默认：近 7 天，慢阈值 1000ms
cbrain perf-diagnose --days 30 --limit 50 --min-latency-ms 500
cbrain perf-diagnose --days 7 --min-latency-ms 0 --json   # patrol 推荐配置
```

| 参数 | 默认 | 含义 |
|:-----|:-----|:-----|
| `--days` | 7 | 回看窗口（天）；0 = 仅今天 |
| `--limit` | 20 | 最多列多少慢 session |
| `--min-latency-ms` | 1000 | 慢阈值；0 = 列全部 session |
| `--json` | off | 机器可读 JSON（CI / 脚本） |

### 读输出

人类可读输出（示意，数值非真实测量）：

```
╔══ CBrain perf-diagnose ══╗
  sessions:  120 total, 18 slow (>= 1000ms)
  degraded:  4.2%
  latency:   p50 1320ms / p95 3110ms / max 5400ms
  avg steps: 4.1 / avg llm calls: 0.3
  by mode:
    smart: 90x (p50 1280ms, p95 2900ms, max 5400ms, degraded 3%)
  degraded reasons:
    low_score: 3x (p50 ...ms, p95 ...ms, max ...ms)
  slowest step kinds:
    vector_search: 9x, avg 820ms
  slow sessions (top 18):
    #42 smart/grounded ok 2100ms steps=5 llm=0 slowest=vector_search
╚══════════════════════════╝
```

字段解读：

- **p50 / p95 / max** — nearest-rank 百分位，**仅对慢 session**（≥ `--min-latency-ms`）计算。p95 = 95% 的慢 session 快于此值。窗口内没有慢 session 时，`latency` 为空。
- **degraded_rate** — 检索**质量**降级率（空结果 / 低分 / 向量超时 / 预算耗尽），不是延迟慢。
- **latency_warning_rate** — 慢但**完整**（latency > 2000ms 且未 degraded）的比例。慢 ≠ 坏，这是 #250 刻意分离的两个语义。
- **by_mode / by_intent / by_status** — 按模式 / 意图 / 状态切片的延迟与降级分布，定位哪类请求最痛。
- **by_degraded_reason** — 哪类降级原因最常出现（`vector_timeout` / `fts_empty` / `low_score` / `budget_exhausted` ...）。
- **slowest_step_kinds** — 慢 session 里最耗时步骤类型的排行（哪个内部环节在吃时间）。
- **slow_sessions** — 具体慢 session 列表（mode / intent / status / latency / steps / llm 调用数 / 最慢步骤），**不含 query 原文、slug、路径**。

### 隐私

会读取 `summary_json` 仅用于提取白名单 reason code；原始 summary 不进入报告，未知字符串直接丢弃。**永不**读取/输出 query 原文、`input_json`、`output_summary`、result slug、credential。降级原因只保留已知 code 白名单（`ALL_DEGRADED_REASON_CODES`），任意未知字符串直接丢弃，绝不「洗」进报告。

### DB 不可用

数据库缺失或不可读时，优雅降级为带 warning 的空报告，`exit 0`——不阻塞 daily patrol。

> 运维巡检里 `perf-diagnose` 怎么被消费，见 [docs/patrol.md](patrol.md)。

## 2. `bun run gate:perf` — 确定性合成基准

匿名合成 fixture（65 页 / 65 chunks：5 个核心页 + 60 个 filler person），8 个 journey，在隔离 tmpdir 里冷启动跑。**永不读你的真实 vault / runtime / HOME。**

### 跑

```
bun run gate:perf
```

输出 JSON + 终端摘要（示意，数值非真实测量）：

```
╔══ CBrain v2.0 Perf Report ══╗
  verdict:    GO
  duration:   380ms (journeys total 320ms)
  slowest:    exact-recall (90ms)
  hottest:    exact-recall (50% query budget)
  journeys:
    ✓ exact-recall      90ms / 50% budget (26/52q) / 312chars
    ✓ topic-recall      70ms / 50% budget (14/28q) / 280chars
    ✓ grounded-recall   40ms / 50% budget (4/8q)   / 210chars
    ...
  warnings:   none
╚════════════════════════════╝
```

### 为什么是 query-count 而不是时间

每个 journey 有一个固定的 SQL 语句 baseline，budget = baseline × 2：

| journey | baseline（SQL 次数） | budget（×2） |
|:--------|:---------|:------------|
| exact-recall | 26 | 52 |
| topic-recall | 14 | 28 |
| relationship-lookup | 7 | 14 |
| episodic-person | 6 | 12 |
| grounded-recall | 4 | 8 |
| version-history | 2 | 4 |
| degraded-search | 2 | 4 |
| empty-search | 2 | 4 |

关键：batch DB 方法是真 IN-clause batch，所以**正确实现的 query count 不随 page 数增长**。fixture 故意塞 60 个 filler person 就是为了让 N+1 可见——episodic 该恒为 6，如果谁写成了 per-person 循环，就会变成 60+，撞破 12 的 budget 而失败。这个数和硬件无关，每次跑都一样，零方差。

### verdict 规则

| 类型 | 规则 |
|:-----|:-----|
| 硬 no-go | 任一 journey 失败（含超 query budget）/ 超时（> 5000ms hang ceiling）/ tmpdir 没清干净 |
| 软 warning（不 fail） | journey 用到 ≥ 80% query budget、或时长 ≥ 80% hang ceiling（4000ms）—提示哪里该优化 |

### 时间维度怎么看

时间在 gate 里**只防卡死**（5000ms ceiling），不作性能门槛。journey 实际 wall-clock 会随硬件变——所以 gate 不报「标准 p50」，也刻意不把任何毫秒数写进 verdict。要看你自己硬件上的真实延迟，用 `perf-diagnose`。

## 3. `bun run gate:v2-preflight` — 发布聚合

把 7 个 gate 合跑成一个 go/no-go 包，返回单份 JSON 报告：

| check | 命令 | 超时 |
|:------|:-----|:-----|
| offline-first-recall | `bun run gate:offline` | 180s |
| rc-journeys | `bun run gate:rc` | 180s |
| hermes-dialogue | `bun run gate:hermes` | 180s |
| performance | `bun run gate:perf` | 180s |
| docs-consistency | `bun run check:docs` | 60s |
| resolver-pilot | `bash bin/check-resolver-pilot.sh` | 60s |
| storage-consistency | `bun run gate:consistency` | 180s |

任一 required check fail → `no-go`，报告给出 `failed_stage` 和 `next_action`。这是 v2.0 发版的 go/no-go 总闸。

## 基准维度速查

复现一次基准要交代的全集：

| 维度 | gate:perf | perf-diagnose |
|:-----|:----------|:--------------|
| dataset | 匿名合成 fixture | 你自己的真实 brain |
| page count | 65（5 核心 + 60 filler） | 你的页数 |
| chunk count | 65（每页 1 chunk） | 你的 chunk 数 |
| hardware 影响 | 不影响 query count（确定性）；wall-clock 随硬件 | wall-clock 随你跑的硬件与负载 |
| cold/warm | cold（每次新建 tmpdir） | warm（已跑过的 journey telemetry） |
| 命令 | `bun run gate:perf` | `cbrain perf-diagnose` |
| p50/p95/max | 不报（确定性 gate） | 报（nearest-rank，仅慢 session） |
| 可复现性 | query count 每次相同，零方差 | 延迟随负载抖动 |

## 本地验收 gate vs 产品声明（别混淆）

这三类数常被混为一谈，但含义完全不同：

- **本地验收 gate**（`gate:perf` / `gate:v2-preflight` 的 verdict）— **这个版本、这台机器、这次发版** 的 go/no-go。是开发者/release manager 的发布闸，不是跨硬件的产品声明。
- **运行时观测**（`perf-diagnose`）— **你这个 brain** 在你硬件上的延迟分布。是运维诊断，不是产品基准。
- **产品声明**（[CHANGELOG](../CHANGELOG.md)）— 带**上下文**的相对改进，例如「查询变体并行化让 simple/medium 查询延迟降 49–59%」「embedding 缓存命中 647ms → 7ms（99%）」。这些标了具体路径和条件，不是裸毫秒数。

> 在博客、对外回应、README 里引用 CBrain 性能时：引用 CHANGELOG 里**带上下文的相对改进**，或 gate 的**确定性 query-count budget**。**不要**把 `perf-diagnose` 在你自己 brain 上的单次 p50 当成产品级数字——它没标硬件、数据规模、冷热启，不可复现。
