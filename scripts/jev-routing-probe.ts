/**
 * MCP 路由判断探针：Jev 能否判断"这句话该调哪个 CBrain 工具"
 *
 * 背景：CBrain 现在把路由判断写在工具 description 里（src/mcp/tools/recall.ts 的
 * deep_recall description 有 ~1500 字规则：【grounded 模式】【内容回忆禁止 grounded】
 * 【首轮硬门控】if…【回答模板】），靠调用方 Agent 自己读、自己判、自觉遵守。
 * 这是不可程序化验证、不可测、跨 Agent 不一致的一层。
 *
 * 范围：读取全部 skills/*.routing-eval.jsonl，仅评估 daily profile 的 initial
 * 阶段、带 expected_tool 的正向路由。skill-only、禁用和边界用例不进入准确率。
 *
 * 候选工具名直接来自 agent profile 的实际 allowlist。描述是本探针的简写，
 * 因此结果是离线路由分类对比，不等同于 Hermes 的真实端到端成功率。
 *
 * 用法：
 *   bun run scripts/jev-routing-probe.ts                       # 仅检查样本/菜单，不发请求
 *   bun run scripts/jev-routing-probe.ts --models baseline --limit 10
 *   bun run scripts/jev-routing-probe.ts --models baseline,jev-zh,jev-en --out /tmp/routing-results.json
 * --out 含逐条输入和解析结果，按私有数据保管，勿提交到仓库。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pLimit from "p-limit";
import { DeepSeekLLMProvider } from "../src/llm/deepseek.js";
import { AGENT_ALLOWLIST } from "../src/mcp/tool-profiles.js";

const argv = process.argv.slice(2);
const arg = (n: string, d: string): string => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const CONCURRENCY = Number(arg("concurrency", "4"));
const TIMEOUT_MS = Number(arg("timeout", "30000"));
const LIMIT = Number(arg("limit", "0"));
const OUT = arg("out", "");
const JEV_MODEL = arg("jev-model", "jev-1.13.0");
const MODELS = arg("models", "none")
	.split(",")
	.map((s) => s.trim());
const CONFIG_PATH =
	process.env.CBRAIN_CONFIG ||
	new URL("../cbrain.json", import.meta.url).pathname;
const SKILLS_DIR = new URL("../skills/", import.meta.url).pathname;

/** 两个模型看到同一份简写说明；名称与实际 daily MCP 菜单同步。 */
const TOOL_DESCRIPTIONS: Record<(typeof AGENT_ALLOWLIST)[number], string> = {
	cbrain_recall:
		"自然语言回忆与核查的默认前门。用户问'之前讨论过吗/有依据吗/当时怎么设计的/是什么来头/总结一下/查一下X'等，都走这里，由内部按意图分发。",
	recall_episode:
		"情境找人。想不起名字时，靠时间、地点、事件、共同经历等线索找人；已知人物问'一起做过什么/共同经历'不算找人，走 cbrain_recall。",
	graph_query:
		"实体之间的关系查询与图谱遍历。'A和B什么关系'、'A认识谁'、找共同关联、一对一的实体关系对比。",
	get_org_tree:
		"只查明确树根实体的组织层级与汇报线。'谁向谁汇报'、'某组织下面有哪些人'、某实体的组织架构树；总结/梳理/复盘组织架构即使有树根也先走 cbrain_recall。",
	read_discoveries:
		"读取已有的发现摘要。'最近有什么发现'、'有什么我漏掉的关联'。",
	next_actions:
		"当前运行状态与待办。'系统现在有什么异常'、'接下来该处理什么'。",
	get_timeline: "按时间轴看事件序列。'这段时间发生了什么'、时间线。",
	deep_recall:
		"高级深度回忆开关（daily 会话仅在首轮未命中后的二次检索才允许）。",
	ingest: "把用户明确提供的新文章、文档或记录写入知识库。",
	ingest_dialogue: "把对话中的新事实或会话记录写入知识库。",
	get_page: "已知页面 slug 时读取单个页面的正文和元数据。",
	list_pages: "列出知识库页面，可按类型过滤。",
	get_pages: "已知多个页面 slug 时批量读取页面摘要。",
	put_page: "更新知识库中已有页面。",
	profile: "读取或更新实体的结构化档案。",
	resolve_slugs: "把已知实体名称解析为页面 slug。",
	update_discovery_status: "把已有发现标记为已读、已处理或忽略。",
	find_similar_entities: "查找可能重复的实体页面。",
	merge_entities: "审核或合并重复的实体页面。",
	status: "查看知识库的基础运行状态和数量统计。",
};
const TOOLS = Object.fromEntries(
	AGENT_ALLOWLIST.map((name) => [name, TOOL_DESCRIPTIONS[name]]),
);
const TOOL_NAMES = new Set(AGENT_ALLOWLIST);

interface Case {
	input: string;
	expected: string;
	category: string;
	file: string;
	line: number;
}

export function loadCases(dir = SKILLS_DIR): Case[] {
	const files = readdirSync(dir)
		.filter((n) => n.endsWith(".routing-eval.jsonl"))
		.sort();
	const out: Case[] = [];
	for (const name of files) {
		for (const [index, line] of readFileSync(join(dir, name), "utf8")
			.split("\n")
			.entries()) {
			if (!line.trim()) continue;
			const row = JSON.parse(line) as {
				input?: unknown;
				intent?: unknown;
				expected_tool?: unknown;
				category?: unknown;
				required_profile?: unknown;
				route_phase?: unknown;
			};
			const tool = row.expected_tool;
			// 两个字段名并存：agent-facing 用 input，recall/agentic/provenance 用 intent
			const text =
				typeof row.input === "string"
					? row.input
					: typeof row.intent === "string"
						? row.intent
						: null;
			if (typeof tool !== "string") continue; // skill-only / response-contract case
			if (tool === "FORBIDDEN") continue;
			if (
				row.category === "anti_pattern" ||
				row.category === "profile_boundary"
			)
				continue;
			// 只评估 daily profile 首轮：Agent 的默认会话看不到 full/debug 工具，
			// 拿 full-only gold 评分等于让模型猜一个它无权调用的答案。
			if ((row.required_profile ?? "daily") !== "daily") continue;
			if ((row.route_phase ?? "initial") !== "initial") continue;
			if (text === null || text.trim() === "")
				throw new Error(
					`${name}:${index + 1} daily initial tool case lacks input`,
				);
			if (!TOOL_NAMES.has(tool as (typeof AGENT_ALLOWLIST)[number])) {
				throw new Error(
					`${name}:${index + 1} daily initial gold ${tool} is absent from agent tool menu`,
				);
			}
			out.push({
				input: text,
				expected: tool,
				category:
					typeof row.category === "string" ? row.category : "uncategorized",
				file: name,
				line: index + 1,
			});
		}
	}
	return out;
}

interface Outcome {
	predicted: string | null;
	score: number | null;
	latencyMs: number;
	error: string | null;
}

function safeError(error: unknown): string {
	if (!(error instanceof Error)) return "UnknownError";
	return error.message.match(/^DeepSeek API error: \d+/)?.[0] ?? error.name;
}

async function askBaseline(
	llm: DeepSeekLLMProvider,
	input: string,
): Promise<Outcome> {
	const t0 = performance.now();
	const catalog = Object.entries(TOOLS)
		.map(([n, d]) => `- ${n}: ${d}`)
		.join("\n");
	try {
		const raw = await llm.chat(
			[
				{
					role: "system",
					content: "Return valid JSON only. No markdown wrapping.",
				},
				{
					role: "user",
					content:
						"用户对个人知识库说了一句话，判断应该调用下面哪个工具。\n\n" +
						`可选工具：\n${catalog}\n\n用户说：${input}\n\n` +
						'只返回 JSON：{"tool": "工具名", "confidence": 0.9}',
				},
			],
			{ thinking: "disabled" },
		);
		const cleaned = raw
			.replace(/^```(?:json)?\s*\n?/m, "")
			.replace(/\n?```\s*$/m, "");
		const parsed = JSON.parse(cleaned) as {
			tool?: unknown;
			confidence?: unknown;
		};
		const tool = typeof parsed.tool === "string" ? parsed.tool.trim() : null;
		return {
			predicted: tool,
			score: typeof parsed.confidence === "number" ? parsed.confidence : null,
			latencyMs: performance.now() - t0,
			error:
				tool === null
					? "no tool"
					: TOOL_NAMES.has(tool as (typeof AGENT_ALLOWLIST)[number])
						? null
						: "unknown tool",
		};
	} catch (e) {
		return {
			predicted: null,
			score: null,
			latencyMs: performance.now() - t0,
			error: safeError(e),
		};
	}
}

async function askJev(
	apiKey: string,
	input: string,
	lang: "zh" | "en",
): Promise<Outcome> {
	const t0 = performance.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const resp = await fetch("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				state: {
					user_message: input,
					available_tools: Object.entries(TOOLS).map(([name, purpose]) => ({
						name,
						purpose,
					})),
				},
				model: JEV_MODEL,
				questions: {
					tool: {
						type: "choice",
						instructions:
							lang === "zh"
								? "用户这句话最应该调用下面哪一个工具？依据工具的用途判断。"
								: "Which single tool should be called for this user message? Judge by each tool's purpose.",
						criteria: TOOLS,
					},
				},
			}),
			signal: controller.signal,
		});
		if (!resp.ok) {
			return {
				predicted: null,
				score: null,
				latencyMs: performance.now() - t0,
				error: `HTTP ${resp.status}`,
			};
		}
		const json = (await resp.json()) as {
			answers?: { tool?: { choice?: unknown; confidence?: unknown } };
		};
		const a = json.answers?.tool;
		const tool = typeof a?.choice === "string" ? a.choice.trim() : null;
		return {
			predicted: tool,
			score: typeof a?.confidence === "number" ? a.confidence : null,
			latencyMs: performance.now() - t0,
			error:
				tool === null
					? "no choice"
					: TOOL_NAMES.has(tool as (typeof AGENT_ALLOWLIST)[number])
						? null
						: "unknown tool",
		};
	} catch (e) {
		return {
			predicted: null,
			score: null,
			latencyMs: performance.now() - t0,
			error: safeError(e),
		};
	} finally {
		clearTimeout(timer);
	}
}

// ─── main ─────────────────────────────────────────────────────
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 8)
	throw new Error("--concurrency must be 1..8");
if (!Number.isInteger(TIMEOUT_MS) || TIMEOUT_MS < 1000)
	throw new Error("--timeout must be at least 1000 ms");
if (!Number.isInteger(LIMIT) || LIMIT < 0)
	throw new Error("--limit must be a non-negative integer");
if (
	MODELS.some(
		(model) => !["none", "baseline", "jev-zh", "jev-en"].includes(model),
	) ||
	(MODELS.includes("none") && MODELS.length !== 1) ||
	new Set(MODELS).size !== MODELS.length
) {
	throw new Error(
		"--models must be none or a unique comma-separated subset of baseline,jev-zh,jev-en",
	);
}

if (import.meta.main) {
	const allCases = loadCases();
	const cases = LIMIT ? allCases.slice(0, LIMIT) : allCases;
	console.log("=== MCP 路由判断探针 ===");
	console.log(
		`样本: ${cases.length}/${allCases.length} 条（daily / initial，gold 为 expected_tool）`,
	);
	console.log(
		`工具: ${AGENT_ALLOWLIST.length} 个候选（agent profile 全菜单）\n`,
	);

	if (MODELS[0] !== "none" && cases.length === 0)
		throw new Error("no eligible routing cases");

	const cfg = MODELS.includes("baseline")
		? (JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
				ner?: {
					llm_api_key?: string;
					llm_model?: string;
					llm_base_url?: string;
				};
			})
		: null;
	const baselineLlm =
		MODELS.includes("baseline") && cfg?.ner?.llm_api_key
			? new DeepSeekLLMProvider(
					cfg.ner.llm_api_key,
					cfg.ner.llm_base_url,
					cfg.ner.llm_model ?? "deepseek-flash",
				)
			: null;
	const jevKey = process.env.TYPESAFE_API_KEY ?? "";
	if (MODELS.includes("baseline") && !baselineLlm)
		throw new Error("baseline requested but ner.llm_api_key is unavailable");
	if (MODELS.some((model) => model.startsWith("jev-") && !jevKey))
		throw new Error("Jev requested but TYPESAFE_API_KEY is unavailable");

	const runner = pLimit(CONCURRENCY);
	const results: Array<{ model: string; c: Case; o: Outcome }> = [];

	for (const model of MODELS) {
		if (model === "none") continue;
		const t0 = performance.now();
		const outs = await Promise.all(
			cases.map((c) =>
				runner(async () => {
					if (model === "baseline") return askBaseline(baselineLlm!, c.input);
					return askJev(jevKey, c.input, model === "jev-en" ? "en" : "zh");
				}),
			),
		);
		for (let i = 0; i < cases.length; i++)
			results.push({ model, c: cases[i]!, o: outs[i]! });
		console.log(
			`[${model}] 完成 ${cases.length} 条，墙钟 ${((performance.now() - t0) / 1000).toFixed(1)}s`,
		);
	}
	console.log();

	for (const model of MODELS) {
		const rs = results.filter((r) => r.model === model);
		if (rs.length === 0) continue;
		const correct = rs.filter((r) => r.o.predicted === r.c.expected).length;
		const lat = rs.map((r) => r.o.latencyMs).sort((a, b) => a - b);
		const errs = rs.filter((r) => r.o.error).length;
		console.log(`── ${model} ──`);
		console.log(
			`  路由准确率: ${((correct / rs.length) * 100).toFixed(1)}%  (${correct}/${rs.length})`,
		);
		console.log(
			`  解析失败: ${errs}   延迟 p50/p90: ${lat[Math.floor(lat.length / 2)]} / ${lat[Math.floor(lat.length * 0.9)]} ms`,
		);
		const byCat: Record<string, { n: number; ok: number }> = {};
		for (const r of rs) {
			byCat[r.c.category] ??= { n: 0, ok: 0 };
			byCat[r.c.category]!.n++;
			if (r.o.predicted === r.c.expected) byCat[r.c.category]!.ok++;
		}
		const worst = Object.entries(byCat)
			.filter(([, v]) => v.n >= 2)
			.sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n);
		console.log(`  最差的类别:`);
		for (const [c, v] of worst.slice(0, 5))
			console.log(`    ${c.padEnd(20)} ${v.ok}/${v.n}`);
		console.log();
	}

	for (const model of MODELS) {
		const rs = results.filter(
			(r) => r.model === model && r.o.predicted !== r.c.expected,
		);
		if (rs.length === 0) continue;
		console.log(`── ${model} 判错 ${rs.length} 条 ──`);
		for (const r of rs)
			console.log(
				`  ${r.c.file}:${r.c.line} [${r.c.expected}] 实得 [${r.o.predicted}]`,
			);
		console.log();
	}

	if (OUT) {
		await Bun.write(
			OUT,
			JSON.stringify(
				{
					schema_version: 1,
					selection: {
						required_profile: "daily",
						route_phase: "initial",
						limit: LIMIT,
					},
					models: MODELS,
					baseline_model: MODELS.includes("baseline")
						? (cfg?.ner?.llm_model ?? "deepseek-flash")
						: null,
					baseline_host: MODELS.includes("baseline")
						? new URL(cfg?.ner?.llm_base_url ?? "https://api.deepseek.com").host
						: null,
					jev_model: MODELS.some((model) => model.startsWith("jev-"))
						? JEV_MODEL
						: null,
					tool_menu: TOOLS,
					cases: results.map((r) => ({
						model: r.model,
						file: r.c.file,
						line: r.c.line,
						category: r.c.category,
						input: r.c.input,
						expected: r.c.expected,
						predicted: r.o.predicted,
						score: r.o.score,
						latencyMs: r.o.latencyMs,
						error: r.o.error,
					})),
				},
				null,
				2,
			),
		);
		console.log(`逐条结果已写入 ${OUT}`);
	}
	if (results.some((r) => r.o.error)) process.exitCode = 1;
}
