import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding } from "./types.js";
import { anonymizeSlugs } from "./report.js";

export function probeFts(db: CBrainDB): FsckFinding[] {
	const findings: FsckFinding[] = [];

	// 缺失：chunks 有但 chunks_fts 没有
	const gaps = db.rawDb.prepare(
		`SELECT DISTINCT c.page_slug FROM chunks c
		 LEFT JOIN chunks_fts f ON f.page_slug = c.page_slug
		 WHERE f.page_slug IS NULL`,
	).all() as Array<{ page_slug: string }>;
	if (gaps.length) {
		findings.push({
			check: "fts.coverage_gap",
			layer: "fts",
			severity: "warning",
			count: gaps.length,
			sampleSlugs: anonymizeSlugs(gaps.map((r) => r.page_slug)),
			detail:
				"FTS 索引缺口：有 chunks 但未进 chunks_fts（走 cbrain sync 重建 chunks 顺带 FTS，非 --reindex-vectors）",
			suggestedCommand: gaps.length <= 5 ? "cbrain sync --slug <slug> --reindex" : "cbrain doctor",
		});
	}

	// 残留：chunks_fts 有但对应 chunks 已删（搜索会召回已删除/过期内容）
	const stale = db.rawDb.prepare(
		`SELECT DISTINCT f.page_slug FROM chunks_fts f
		 LEFT JOIN chunks c ON c.page_slug = f.page_slug
		 WHERE c.page_slug IS NULL`,
	).all() as Array<{ page_slug: string }>;
	if (stale.length) {
		findings.push({
			check: "fts.stale_rows",
			layer: "fts",
			severity: "warning",
			count: stale.length,
			sampleSlugs: anonymizeSlugs(stale.map((r) => r.page_slug)),
			detail: "FTS 索引残留：chunks_fts 有 row 但对应 chunks 已删（搜索可能召回已删除内容）",
			suggestedCommand: stale.length <= 5 ? "cbrain sync --slug <slug> --reindex" : "cbrain doctor",
		});
	}

	return findings;
}
