# #433 final fix wave report

日期：2026-08-24

Fix base：`c16123b5c164650619b13024694f0392b55cc5a2`

实现提交：`c8fc45c`（`test: close evidence validity final review findings (#433)`）

报告提交：本报告作为紧随实现提交的独立文档提交，最终 hash 见分支日志。

## 结论

`final-review-findings.md` 中 F1–F7 与 M1 已全部处理。最终改动仍局限于两份 test/reference 文件、既有计划文档与本报告；没有修改 `src/`、数据库、schema、migration、MCP、CLI、package、lockfile 或 vault，也没有加入 registry、plugin layer、runtime framework、后台循环或真实数据。

## F1 — fuzzy temporal left endpoint

实现：

- 新增单一三态比较器 `before | ambiguous | crossed`。
- exact `asOf` 位于模糊边界 `[earliest, latestExclusive)` 时返回 ambiguous；到达 `latestExclusive` 后才 crossed。
- exact instant 边界在同一时刻 crossed，保持既有 instant 语义。
- day/month/year/approximate 四组字面 fixture 均覆盖 earliest、inside、latestExclusive，并横跨 Claim valid-from、valid-to、transition、Event cancellation。

RED：

```text
bun test tests/core/evidence-claim-validity-contract.test.ts --test-name-pattern 'fuzzy .* (Claim boundaries|transition|cancellation)'
0 pass, 12 fail
earliest 被错误判为 planned_or_confirmed / scheduled / effective，而不是 temporal unknown。
```

GREEN：

```text
bun test tests/core/evidence-claim-validity-contract.test.ts --test-name-pattern '(fuzzy .* (Claim boundaries|transition|cancellation)|exact instant boundaries)'
13 pass, 0 fail
```

## F2 — TemporalPoint fail closed

实现：

- instant 只接受带显式 `Z` 或固定 offset 的严格 RFC 3339 shape。
- day/month/year 做严格公历校验；offset 做语法与小时/分钟范围校验。
- 所有派生毫秒必须有限；approximate 必须满足 `earliest < latestExclusive`。
- exact 零长度 `[valid_from, valid_to)` 被拒绝；可证明有序的不确定区间继续合法。

RED：

```text
bun test tests/core/evidence-claim-validity-contract.test.ts --test-name-pattern '(TemporalPoint validation|zero-length|provably ordered)'
1 pass, 11 fail
非法日/月、无时区 instant、越界 offset、非有限/无时区/反向/相等 approximate 与 exact 零长度均未被拒绝。
```

其中“可证明有序的不确定区间继续合法”首次即通过，是保护性断言，不伪报为 RED。

GREEN：

```text
12 pass, 0 fail
```

## F3 — transition shape and priority

实现：

- `ClaimTransition` 改为判别联合：supersedes 必须有 `newClaimId`；revokes 禁止携带该字段。
- reducer 同时做运行时 shape fail-closed。
- 优先级固定为 crossed revocation、ambiguous revocation、crossed supersession、ambiguous supersession。
- crossed revocation 与 crossed supersession 共存时仍返回 revoked 并报告 conflict。

RED：

```text
bun test ... --test-name-pattern '(ambiguous confirmed revocation|runtime validation rejects|confirmed revocation wins)'
1 pass, 3 fail

bun run typecheck:tests
2 个 TS2578：旧可选 shape 使两条 @ts-expect-error 未生效。
```

既有 crossed revocation conflict 断言首次即通过，是保护性断言。

GREEN：

```text
4 pass, 0 fail
bun run typecheck:tests -> exit 0
```

## F4 — contradiction must be active

实现：

- supports 与 contradicts 共用 stance-aware active-binding predicate。
- 只有 verified 且 pinned source version 可用的 contradiction 产生 conflict/not-high。
- unchecked、mismatch、source-version unavailable contradiction 不产生 conflict。

RED：

```text
bun test ... --test-name-pattern '(contradiction marks|contradiction is not an active conflict)'
active 保护断言通过；3 个 inactive contradiction 均错误返回 conflict=true。
```

GREEN：

```text
4 pass, 0 fail
```

## F5 — immutable Calibration snapshots

实现：

- JSON-shaped 输入先深克隆，再递归冻结 clone；即使调用方父对象已冻结也继续处理 clone 的子节点。
- 不冻结、不修改、不别名 caller-owned nested objects。
- EvaluationContract replacement、Calibration result、dimensionResults 与 missingRequirements 都是独立冻结快照。
- 评价后修改原 dimensions 数组/对象不会改变已返回的 status 或维度内容。

RED：

```text
bun test ... --test-name-pattern '(pre-frozen parent|caller-owned nested|frozen dimension snapshot|frozen missing-requirements)'
0 pass, 4 fail
```

失败分别证明：预冻结父对象仍被复用、调用方数组被别名/误冻、dimensionResults 按引用返回、missingRequirements 未冻结。

GREEN：

```text
4 pass, 0 fail
```

## F6 — Calibration temporal/version contract

实现：

- `CalibrationInput.asOf/windowEnd` 改为显式 `TemporalPoint`，移除裸 `asOfMs/windowEndMs`。
- 模糊 window boundary 返回 inconclusive；确定 before 才 not_due，crossed 才进入 Outcome/scorer。
- `evaluatorVersion` 必填且必须非空；`utility` 收窄为 `useful | neutral | harmful`，并有运行时 fail-closed。
- v1/v2 对冻结输入各自实际调用 evaluator，结果对象与 dimension snapshots 独立、冻结、可逐字段 diff。

RED：

```text
bun test ... --test-name-pattern '(not_due precedes|Calibration treats fuzzy|rejects missing or blank evaluator|rejects utility|evaluator v1 and v2)'
1 pass, 9 fail

bun run typecheck:tests
旧接口对 asOf/windowEnd 产生 13 处类型错误。
```

重写后的 v1/v2 双次评价测试首次即通过，因为 F5 已先建立独立快照；如实作为保护性增强记录。

GREEN：

```text
10 pass, 0 fail
bun run typecheck:tests -> exit 0
```

## F7 — Event / legacy parity

实现：

- candidate/rejected/ineligible Event 返回 `{ rows: [], displayState: "excluded" }`。
- graph/timeline adapters 接受匿名 frozen 多行输入，逐行保留 count/order/display。
- timeline identity 同时含 entity 与 row identity；相同内容的不同实体/行仍保持独立。
- recall 不调用 supplied throwing kernel/accounting callbacks，并返回内部固定零工作；测试传入 99/99 诱饵计数，防止 input echo。
- display 用字面 allowlist 形状断言；internal Claim/Event IDs 只存在于 raw。

RED：

```text
bun test ... --test-name-pattern '(every participant view|legacy graph preserves|legacy timeline preserves|pre-cutover brief recall)'
0 pass, 4 fail
```

失败分别为错误 display state、两个单行 adapter 形状，以及 recall 回显 99 次计数。

GREEN：

```text
4 pass, 0 fail
bun run typecheck:tests -> exit 0
```

## M1 — fixture 14 effective_at vs recorded_at

新增 `effective_at=T2 < asOf < recorded_at=T3` 的字面断言，期望 superseded；同时保留 `asOf<T2` 的 historical 断言。

```text
bun test ... --test-name-pattern '\[14\]'
1 pass, 0 fail, 2 expect() calls
```

该断言首次即通过，说明这是补强字段区分能力，不是新的行为修复。

## 接口与计划同步

- TemporalPoint 构造器现在有明确 fail-closed 合同；比较逻辑统一为三态。
- ClaimTransition 为判别联合，并增加同语义运行时 shape 校验。
- Evidence verification state 明确包含 unchecked；active-binding predicate 按 stance 复用。
- Timeline excluded state 显式化；legacy graph/timeline adapters 改为多行；recall 依赖显式但 pre-cutover 不调用。
- Calibration 改用 TemporalPoint、必填 evaluator version、闭合 utility union 与 readonly frozen results。
- 计划文档已移除旧 `asOfMs/windowEndMs`、可选 supersession target、单行 adapter 和 array-spread-only v2 示例；同步了严格日期校验、transition 优先级、active contradiction、snapshot ownership 与多行 parity 规则。

## 最终验证

```text
bun test tests/core/evidence-claim-validity-contract.test.ts
101 pass, 0 fail, 174 expect() calls

bun test tests/core/evidence-claim-validity-contract.test.ts tests/mcp/graph-timeline-envelope.test.ts tests/core/evidence.test.ts tests/core/evidence-summary.test.ts
192 pass, 0 fail, 607 expect() calls

bun run typecheck:tests
exit 0

bun run check:docs
Verdict: PASS

bun run check:ci
4575 pass, 0 fail, 21101 expect() calls; exit 0

privacy rg scan
exit 1 with empty output = no path/email matches

git diff --check
exit 0, empty output
```

## 对抗式自审与做减法

最可能翻车的五点及证据：

1. 左端点仍被当作 before：四精度 × Claim/transition/Event 的 earliest 字面断言会失败。
2. 高优先级模糊 revocation 被 crossed supersession 短路：专门的混合 transition 断言会失败。
3. deepFreeze 冻结调用方或复用预冻结父对象：caller ownership 与 pre-frozen-parent 测试会失败。
4. parity 只测一行或无法抓排序/丢行：多行 fixture 的完整 display/raw 数组字面值同时锁住 count 与 order；timeline 的相同内容行锁住 identity。
5. recall 的零工作只是 caller echo：99/99 诱饵计数与两个 throwing callbacks 会同时抓住回声和真实调用。

做减法结论：

- 没有新增生产接口、持久状态、兼容 alias、feature flag、registry、plugin、后台进程或真实 consumer wiring。
- 三态 comparator 有 Claim、Event、Calibration 三个真实 test/reference 消费者；active-binding predicate 被 eligibility/corroboration/inference 共同消费；snapshot helper 被 EvaluationContract 与 Calibration 两个真实入口消费。
- 测试只保护公开返回状态、顺序、计数、冻结/所有权和调用边界；没有 source-string assertion，也没有用 helper 计算 expected state/display。
- 未做无关重构；所有修改都能随本次 test/reference commit 独立回滚。

## 未解决疑虑

本轮范围内没有已知未解决行为缺陷。剩余产品风险是合同本来就明确排除的生产集成：该 helper 仍只在 tests/reference 使用，任何真实存储、Graph/Timeline cutover 或 Calibration runtime 都必须继续经过 data-model gate，不能由本提交推断为已授权。
