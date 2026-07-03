import { existsSync } from "node:fs";
import { LanceDBManager, LanceTableMissingError } from "../../storage/lancedb.js";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding, FsckLanceState } from "./types.js";
import { anonymizeSlugs } from "./report.js";

export async function probeLance(
	lancePath: string,
	db: CBrainDB,
): Promise<{ findings: FsckFinding[]; state: FsckLanceState }> {
	if (!existsSync(lancePath)) return { findings: [], state: "unchecked" };

	const mgr = new LanceDBManager();
	try {
		await mgr.connect(lancePath);
		const table = await mgr.openChunksStrict();
		const rows = (await table.query().select(["pageSlug"]).toArray()) as Array<{ pageSlug: string }>;
		const vectorSlugs = new Set(rows.map((r) => r.pageSlug));

		const chunkSlugs = db.rawDb
			.prepare("SELECT DISTINCT page_slug FROM chunks")
			.all() as Array<{ page_slug: string }>;

		const missing = chunkSlugs.filter((r) => !vectorSlugs.has(r.page_slug));
		if (missing.length === 0) return { findings: [], state: "ok" };

		return {
			state: "ok",
			findings: [
				{
					check: "lance.vector_coverage_gap",
					layer: "lance",
					severity: "error",
					count: missing.length,
					sampleSlugs: anonymizeSlugs(missing.map((r) => r.page_slug)),
					detail: "page 有 chunks 但 LanceDB 无向量（recall 受损）。必须先停 serve：reindex 会原子替换 LanceDB 目录，与运行中的 serve 并发会损坏索引。dream 不重建缺失向量，不适用。",
					suggestedCommand: "停 serve（launchctl unload ai.cbrain.serve.plist）→ cbrain sync --reindex-vectors → 重启 serve → cbrain fsck --json --layer lance 验证",
				},
			],
		};
	} catch (e) {
		if (e instanceof LanceTableMissingError) return { findings: [], state: "missing" };
		return { findings: [], state: "corrupt" };
	}
}
