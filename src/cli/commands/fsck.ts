import type { Command } from "commander";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding, FsckLayer, FsckLanceState, FsckReport } from "../../core/fsck/types.js";
import { buildReport, reportToMarkdown } from "../../core/fsck/report.js";
import type { RepairPlan, RepairPlanStatus } from "../../core/fsck/repair-plan.js";
import { buildRepairPlan, formatRepairPlanMarkdown } from "../../core/fsck/repair-plan.js";
import { probeSqlite } from "../../core/fsck/sqlite-probe.js";
import { probeFts } from "../../core/fsck/fts-probe.js";
import { probeLance } from "../../core/fsck/lance-probe.js";
import { probeVault } from "../../core/fsck/vault-probe.js";
import { probeHierarchy } from "../../core/fsck/hierarchy-probe.js";
import {
	escapeLocalDetailPath,
	inspectMisplacedVaultArtifacts,
	resolveTrustedVaultBoundary,
	type MisplacedVaultArtifactLocalDetail,
	type TrustedVaultBoundary,
} from "../../core/maintenance/misplaced-vault-artifacts.js";

export interface FsckInput {
	vaultPath: string;
	lancePath: string;
	db: CBrainDB;
	layer?: FsckLayer;
	vaultBoundary?: TrustedVaultBoundary;
	includeLocalDetails?: boolean;
}

export interface FsckResult {
	report: FsckReport;
	exitCode: 0 | 1 | 2;
	localDetails?: readonly MisplacedVaultArtifactLocalDetail[];
}

export interface RepairPlanResult {
	plan: RepairPlan;
	exitCode: 0 | 1 | 2;
}

const ALL_LAYERS: FsckLayer[] = ["vault", "sqlite", "fts", "lance"];

export async function runFsck(input: FsckInput): Promise<FsckResult> {
	const timestamp = new Date().toISOString();
	const layers = input.layer ? [input.layer] : ALL_LAYERS;
	const findings: FsckFinding[] = [];
	let localDetails: readonly MisplacedVaultArtifactLocalDetail[] = [];
	let lanceState: FsckLanceState = "unchecked";
	let fatalError: string | undefined;

	try {
		if (layers.includes("vault")) {
			const inspection = inspectMisplacedVaultArtifacts(input.vaultBoundary, {
				includeLocalDetails: input.includeLocalDetails,
			});
			findings.push(...probeVault(input.vaultPath, input.db, inspection.scan));
			if (input.includeLocalDetails === true) localDetails = inspection.localDetails;
		}
		if (layers.includes("sqlite")) {
			findings.push(...probeSqlite(input.db));
			findings.push(...probeHierarchy(input.vaultPath, input.db));
		}
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
	return input.includeLocalDetails === true ? { report, exitCode, localDetails } : { report, exitCode };
}

function repairPlanExitCode(status: RepairPlanStatus): 0 | 1 | 2 {
	if (status === "clean") return 0;
	if (status === "blocked") return 2;
	return 1;
}

function parseRepairLimit(raw: string | undefined): number {
	if (raw === undefined) return 50;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 0) return 50;
	return n;
}

export async function runRepairPlan(input: FsckInput): Promise<RepairPlanResult> {
	const { report } = await runFsck(input);
	const plan = buildRepairPlan(report);
	return { plan, exitCode: repairPlanExitCode(plan.overallStatus) };
}

export function register(program: Command): void {
	program
		.command("fsck")
		.description("存储一致性检查（默认只读；--repair-stale-fts 仅清理 stale FTS rows）")
		.option("--json", "输出稳定 FsckReport JSON（供下游 Agent 解析）")
		.option("--layer <name>", "只跑指定层：vault|sqlite|fts|lance")
		.option("--repair-plan", "输出 privacy-safe repair plan，而不是原始 fsck report")
		.option("--repair-stale-fts", "安全删除 chunks_fts 中没有对应 chunks 的残留 rows")
		.option("--local-details", "仅本机显示 vault 边界外候选的转义相对路径（只读）")
		.action(async (opts: { json?: boolean; layer?: string; repairPlan?: boolean; repairStaleFts?: boolean; localDetails?: boolean }) => {
			if (opts.localDetails && (
				opts.layer !== "vault"
				|| opts.json
				|| opts.repairPlan
				|| opts.repairStaleFts
			)) {
				console.error("Error: --local-details requires --layer vault and cannot be combined with --json, --repair-plan, or repair flags.");
				process.exit(2);
				return;
			}

			const { loadConfigWithPath } = await import("../context.js");
			const { CBrainDB } = await import("../../storage/sqlite.js");
			const { existsSync } = await import("node:fs");
			const { FsckLayerSchema } = await import("../../core/fsck/types.js");
			const loaded = loadConfigWithPath();
			const config = loaded.config;
			const vaultBoundary = resolveTrustedVaultBoundary({
				configRoot: loaded.configRoot,
				vaultPath: config.vaultPath,
			});
			const ts = new Date().toISOString();
			const emit = (report: FsckReport, exitCode: 0 | 1 | 2): void => {
				if (opts.json) console.log(JSON.stringify(report));
				else console.log(reportToMarkdown(report));
				process.exit(exitCode);
			};
			const emitPlan = (plan: RepairPlan, exitCode: 0 | 1 | 2): void => {
				if (opts.json) console.log(JSON.stringify(plan));
				else console.log(formatRepairPlanMarkdown(plan));
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
			if (opts.repairStaleFts && layer && layer !== "fts") {
				emit(buildReport([], "unchecked", ts, "--repair-stale-fts can only be used with --layer fts"), 2);
				return;
			}
			if (opts.repairStaleFts) layer = "fts";

			// DB 不存在 → exit 2，绝不创建文件/目录（只读契约；CBrainDB 构造器会建）
			if (!existsSync(config.dbPath)) {
				const report = buildReport([], "unchecked", ts, "DB file not found at configured dbPath");
				if (opts.repairPlan) {
					emitPlan(buildRepairPlan(report), 2);
				} else {
					emit(report, 2);
				}
				return;
			}

			const db = new CBrainDB(config.dbPath, { skipMigrate: true });
			try {
				if (opts.repairStaleFts) {
					db.cleanupStaleFtsRows();
				}
				const { report, exitCode, localDetails } = await runFsck({
					vaultPath: config.vaultPath,
					lancePath: config.lancePath,
					db,
					layer,
					vaultBoundary,
					includeLocalDetails: opts.localDetails,
				});
				if (opts.repairPlan) {
					const plan = buildRepairPlan(report);
					emitPlan(plan, repairPlanExitCode(plan.overallStatus));
					return;
				}
				if (opts.localDetails) {
					const incomplete = report.findings.some(
						(finding) => finding.check === "vault.misplaced_artifact_scan_incomplete",
					);
					if (incomplete && (localDetails?.length ?? 0) === 0) {
						console.log("Misplaced artifact inspection incomplete; no local paths are available.");
						process.exit(1);
						return;
					}
					console.log(reportToMarkdown(report));
					console.log("Local-only read-only preview; zero bytes do not prove deletion safety.");
					for (const detail of localDetails ?? []) {
						console.log(`${detail.classification} ${escapeLocalDetailPath(detail.relativePath)}`);
					}
					process.exit(exitCode);
					return;
				}
				emit(report, exitCode);
			} finally {
				db.close();
			}
		});

	program
		.command("repair-plan")
		.description("将 fsck 发现转成 privacy-safe 修复计划（默认 dry-run）")
		.option("--json", "输出稳定 RepairPlan JSON（供下游 Agent 解析）")
		.option("--limit <n>", "限制本次可执行修复数量", "50")
		.option("--execute", "执行已声明安全的派生层修复（Phase 1 之后逐步开放）")
		.option("--verify", "只验证当前 repair plan 是否清空，不执行修复")
		.action(async (opts: { json?: boolean; limit?: string; execute?: boolean; verify?: boolean }) => {
			const { loadConfigWithPath } = await import("../context.js");
			const { CBrainDB } = await import("../../storage/sqlite.js");
			const { existsSync } = await import("node:fs");
			const loaded = loadConfigWithPath();
			const config = loaded.config;
			const vaultBoundary = resolveTrustedVaultBoundary({
				configRoot: loaded.configRoot,
				vaultPath: config.vaultPath,
			});
			const ts = new Date().toISOString();
			const emitPlan = (plan: RepairPlan, exitCode: 0 | 1 | 2): void => {
				if (opts.json) console.log(JSON.stringify(plan));
				else console.log(formatRepairPlanMarkdown(plan));
				process.exit(exitCode);
			};

			if (!existsSync(config.dbPath)) {
				const report = buildReport([], "unchecked", ts, "DB file not found at configured dbPath");
				emitPlan(buildRepairPlan(report), 2);
				return;
			}

			const db = new CBrainDB(config.dbPath, { skipMigrate: true });
			try {
				const input: FsckInput = {
					vaultPath: config.vaultPath,
					lancePath: config.lancePath,
					db,
					vaultBoundary,
				};
				const { plan } = await runRepairPlan(input);

				if (opts.verify) {
					plan.execution = {
						mode: "verify",
						executed: [],
						skipped: [],
						verificationCommand: "cbrain repair-plan --verify --json",
					};
					emitPlan(plan, repairPlanExitCode(plan.overallStatus));
					return;
				}

				if (opts.execute) {
					const limit = parseRepairLimit(opts.limit);
					const executable = plan.items.filter((item) => item.canExecute && item.check === "fts.stale_rows");
					const toExecute = executable.slice(0, limit);
					const executed: string[] = [];
					const skipped = plan.items
						.filter((item) => item.canExecute)
						.slice(limit)
						.map((item) => item.check);
					for (const item of toExecute) {
						if (item.check === "fts.stale_rows") {
							db.cleanupStaleFtsRows();
							executed.push(item.check);
						}
					}
					const refreshed = buildRepairPlan((await runFsck(input)).report);
					refreshed.execution = {
						mode: "execute",
						executed,
						skipped,
						verificationCommand: "cbrain repair-plan --verify --json",
					};
					emitPlan(refreshed, repairPlanExitCode(refreshed.overallStatus));
					return;
				}

				plan.execution = {
					mode: "dry_run",
					executed: [],
					skipped: [],
					verificationCommand: "cbrain repair-plan --verify --json",
				};
				const exitCode = repairPlanExitCode(plan.overallStatus);
				emitPlan(plan, exitCode);
			} finally {
				db.close();
			}
		});
}
