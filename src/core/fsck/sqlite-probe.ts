import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding } from "./types.js";
import { anonymizeSlugs } from "./report.js";

export function probeSqlite(db: CBrainDB): FsckFinding[] {
	const findings: FsckFinding[] = [];
	const raw = db.rawDb;

	// ─── title collision ────────────────────────────────────────────
	const dupTitles = raw.prepare(
		"SELECT title, COUNT(*) AS c, GROUP_CONCAT(slug) AS slugs FROM pages GROUP BY title HAVING c > 1",
	).all() as Array<{ title: string; c: number; slugs: string }>;

	if (dupTitles.length > 0) {
		const count = dupTitles.reduce((n, r) => n + r.c, 0);
		findings.push({
			check: "sqlite.title_collision",
			layer: "sqlite",
			severity: "error",
			count,
			sampleSlugs: anonymizeSlugs(dupTitles.flatMap((r) => r.slugs.split(","))),
			detail: `${dupTitles.length} 个标题被多个 page 共用（cbrain doctor 为诊断/隔离入口，不自动修复）`,
			suggestedCommand: "cbrain doctor",
		});
	}

	// ─── page without chunks ────────────────────────────────────────
	const noChunks = raw.prepare(
		"SELECT p.slug FROM pages p LEFT JOIN (SELECT DISTINCT page_slug FROM chunks) c ON p.slug = c.page_slug WHERE c.page_slug IS NULL",
	).all() as Array<{ slug: string }>;

	if (noChunks.length > 0) {
		findings.push({
			check: "sqlite.page_without_chunks",
			layer: "sqlite",
			severity: "warning",
			count: noChunks.length,
			sampleSlugs: anonymizeSlugs(noChunks.map((r) => r.slug)),
			detail: "page 没有 chunks（无法检索；普通 sync 会在 hash 匹配但索引缺失时重建）",
			suggestedCommand: noChunks.length <= 5 ? "cbrain sync --slug <slug>" : "cbrain sync",
		});
	}

	// ─── FK orphans ─────────────────────────────────────────────────
	const fk = db.checkFkViolations();
	for (const [table, n] of Object.entries(fk.byTable)) {
		findings.push({
			check: `sqlite.orphan_${table}`,
			layer: "sqlite",
			severity: "warning",
			count: n,
			sampleSlugs: [],
			detail: `${table} 表有 ${n} 行指向不存在的 page（FK 孤儿）`,
			suggestedCommand: "cbrain repair-fk --execute",
		});
	}

	// ─── quarantine context (info) ──────────────────────────────────
	const qrow = raw.prepare("SELECT value FROM config WHERE key = 'watcher.quarantine'").get() as
		| { value: string }
		| undefined;

	if (qrow) {
		try {
			const list = JSON.parse(qrow.value) as Array<{ slug?: string }>;
			findings.push({
				check: "sqlite.quarantine_context",
				layer: "sqlite",
				severity: "info",
				count: list.length,
				sampleSlugs: anonymizeSlugs(
					list.map((x) => x.slug ?? "").filter(Boolean),
				),
				detail: "watcher 隔离中的 page（context，非故障）",
				suggestedCommand: "",
			});
		} catch {
			// corrupt JSON — skip to avoid noise
		}
	}

	return findings;
}
