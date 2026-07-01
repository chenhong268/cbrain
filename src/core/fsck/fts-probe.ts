import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding } from "./types.js";
import { anonymizeSlugs } from "./report.js";

export function probeFts(db: CBrainDB): FsckFinding[] {
	const gaps = db.rawDb.prepare(
		`SELECT DISTINCT c.page_slug FROM chunks c
		 LEFT JOIN chunks_fts f ON f.page_slug = c.page_slug
		 WHERE f.page_slug IS NULL`,
	).all() as Array<{ page_slug: string }>;

	if (!gaps.length) return [];

	return [
		{
			check: "fts.coverage_gap",
			layer: "fts",
			severity: "warning",
			count: gaps.length,
			sampleSlugs: anonymizeSlugs(gaps.map((r) => r.page_slug)),
			detail:
				"FTS 索引缺口：有 chunks 但未进 chunks_fts（走 cbrain sync 重建 chunks 顺带 FTS，非 --reindex-vectors）",
			suggestedCommand:
				gaps.length <= 5
					? "cbrain sync --slug <slug> --reindex"
					: "cbrain doctor",
		},
	];
}
