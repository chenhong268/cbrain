import type { Command } from "commander";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding, FsckLayer, FsckLanceState, FsckReport } from "../../core/fsck/types.js";
import { buildReport, reportToMarkdown } from "../../core/fsck/report.js";
import { probeSqlite } from "../../core/fsck/sqlite-probe.js";
import { probeFts } from "../../core/fsck/fts-probe.js";
import { probeLance } from "../../core/fsck/lance-probe.js";
import { probeVault } from "../../core/fsck/vault-probe.js";

export interface FsckInput {
	vaultPath: string;
	lancePath: string;
	db: CBrainDB;
	layer?: FsckLayer;
}

export interface FsckResult {
	report: FsckReport;
	exitCode: 0 | 1 | 2;
}

const ALL_LAYERS: FsckLayer[] = ["vault", "sqlite", "fts", "lance"];

export async function runFsck(input: FsckInput): Promise<FsckResult> {
	const timestamp = new Date().toISOString();
	const layers = input.layer ? [input.layer] : ALL_LAYERS;
	const findings: FsckFinding[] = [];
	let lanceState: FsckLanceState = "unchecked";
	let fatalError: string | undefined;

	try {
		if (layers.includes("vault")) findings.push(...probeVault(input.vaultPath, input.db));
		if (layers.includes("sqlite")) findings.push(...probeSqlite(input.db));
		if (layers.includes("fts")) findings.push(...probeFts(input.db));
		if (layers.includes("lance")) {
			const r = await probeLance(input.lancePath, input.db);
			findings.push(...r.findings);
			lanceState = r.state;
		}
	} catch (e) {
		fatalError = e instanceof Error ? `fsck probe failed: ${e.message}` : "fsck probe failed (unknown)";
	}

	const report = buildReport(findings, lanceState, timestamp, fatalError);
	const exitCode: 0 | 1 | 2 = fatalError ? 2 : report.overallStatus === "pass" ? 0 : 1;
	return { report, exitCode };
}

export function register(program: Command): void {
	program
		.command("fsck")
		.description("只读存储一致性检查（vault/SQLite/FTS/LanceDB 四层对齐 + FK 孤儿），不写数据")
		.option("--json", "输出稳定 FsckReport JSON（供下游 Agent 解析）")
		.option("--layer <name>", "只跑指定层：vault|sqlite|fts|lance")
		.action(async (opts: { json?: boolean; layer?: string }) => {
			const { loadConfig } = await import("../context.js");
			const { CBrainDB } = await import("../../storage/sqlite.js");
			const { existsSync } = await import("node:fs");
			const { FsckLayerSchema } = await import("../../core/fsck/types.js");
			const config = loadConfig();
			const ts = new Date().toISOString();
			const emit = (report: FsckReport, exitCode: 0 | 1 | 2): void => {
				if (opts.json) console.log(JSON.stringify(report));
				else console.log(reportToMarkdown(report));
				process.exit(exitCode);
			};

			// 非法 --layer → exit 2（否则任意字符串会让无 layer 执行 → 静默 pass）
			let layer: FsckLayer | undefined;
			if (opts.layer) {
				const parsed = FsckLayerSchema.safeParse(opts.layer);
				if (!parsed.success) {
					emit(buildReport([], "unchecked", ts, `Invalid --layer: ${opts.layer}. Allowed: vault|sqlite|fts|lance`), 2);
					return;
				}
				layer = parsed.data;
			}

			// DB 不存在 → exit 2，绝不创建文件/目录（只读契约；CBrainDB 构造器会建）
			if (!existsSync(config.dbPath)) {
				emit(buildReport([], "unchecked", ts, "DB file not found at configured dbPath"), 2);
				return;
			}

			const db = new CBrainDB(config.dbPath, { skipMigrate: true });
			try {
				const { report, exitCode } = await runFsck({
					vaultPath: config.vaultPath,
					lancePath: config.lancePath,
					db,
					layer,
				});
				emit(report, exitCode);
			} finally {
				db.close();
			}
		});
}
