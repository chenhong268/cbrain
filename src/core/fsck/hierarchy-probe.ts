import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding } from "./types.js";
import { anonymizeSlugs } from "./report.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";

/**
 * #279 hierarchy probes: pages whose `reports_to` frontmatter is broken.
 * Two distinct findings (both layer="sqlite", severity="error"):
 *   - `hierarchy.malformed_reports_to`: value is not a full slug (no "/").
 *     Hermes feedback: this is a real broken-link class — the gate MUST surface
 *     it, NOT skip it. Mirrors health.ts:886-895.
 *   - `hierarchy.frontmatter_graph_mismatch`: value is a full slug but has no
 *     matching current/active graph edge. Reuses health.ts:899-914 SQL
 *     (#233 current-fact — superseded/rejected/candidate do NOT satisfy).
 *
 * No silent scan cap — release gate scans every page with a file_path (#279
 * review: a release gate must not quietly miss pages beyond an arbitrary limit).
 */
export function probeHierarchy(vaultPath: string, db: CBrainDB): FsckFinding[] {
	const findings: FsckFinding[] = [];
	const pages = db.rawDb
		.prepare("SELECT slug, file_path FROM pages WHERE file_path IS NOT NULL")
		.all() as Array<{ slug: string; file_path: string }>;
	const mismatched: string[] = [];
	const malformed: string[] = [];

	for (const page of pages) {
		const filePath = join(vaultPath, page.file_path);
		if (!existsSync(filePath)) continue;

		let reportsTo: string | null = null;
		try {
			const raw = readFileSync(filePath, "utf-8");
			const parsed = parseFrontmatter(raw);
			const fm = parsed.frontmatter as Record<string, unknown>;
			const rt = fm.reports_to;
			reportsTo = typeof rt === "string" && rt ? rt : null;
		} catch {
			continue;
		}
		if (!reportsTo) continue;

		if (!reportsTo.includes("/")) {
			malformed.push(page.slug);
			continue;
		}

		const hasEdge = db.rawDb
			.prepare(
				"SELECT 1 FROM links WHERE from_slug = ? AND to_slug = ? AND relation = 'reports_to' AND (trust_state IS NULL OR trust_state IN ('trusted','user_thought')) LIMIT 1",
			)
			.get(page.slug, reportsTo);

		if (!hasEdge) mismatched.push(page.slug);
	}

	if (malformed.length > 0) {
		findings.push({
			check: "hierarchy.malformed_reports_to",
			layer: "sqlite",
			severity: "error",
			count: malformed.length,
			sampleSlugs: anonymizeSlugs(malformed),
			detail: "page 的 reports_to frontmatter 不是完整 slug（应为 entity/xxx 格式）；Hermes 反馈的真实断链类型，gate 必须暴露",
			suggestedCommand: "cbrain hierarchy <slug>",
		});
	}
	if (mismatched.length > 0) {
		findings.push({
			check: "hierarchy.frontmatter_graph_mismatch",
			layer: "sqlite",
			severity: "error",
			count: mismatched.length,
			sampleSlugs: anonymizeSlugs(mismatched),
			detail: "page 的 reports_to frontmatter 缺少对应 current graph edge（#233 current-fact 语义；#273 compensation 已保证新写不产生，历史残留需人工）",
			suggestedCommand: "cbrain hierarchy <slug>",
		});
	}
	return findings;
}
