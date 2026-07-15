import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { CBrainDB } from "../../storage/sqlite.js";
import type { FsckFinding } from "./types.js";
import { anonymizeSlugs } from "./report.js";
import { parseFrontmatter } from "../../utils/frontmatter.js";
import type { MisplacedVaultArtifactScan } from "../maintenance/misplaced-vault-artifacts.js";

function walkMd(root: string): string[] {
	const out: string[] = [];
	const entries = readdirSync(root, { withFileTypes: true });
	for (const ent of entries) {
		if (ent.name.startsWith(".")) continue; // skip hidden dirs/files (.obsidian, .trash, .git)
		const p = join(root, ent.name);
		if (ent.isDirectory()) {
			out.push(...walkMd(p));
		} else if (ent.name.endsWith(".md")) {
			out.push(p);
		}
	}
	return out;
}

function anonymousSamples(count: number): string[] {
	return anonymizeSlugs(Array.from({ length: Math.min(count, 5) }, () => "candidate"));
}

function appendMisplacedArtifactFindings(
	findings: FsckFinding[],
	scan?: MisplacedVaultArtifactScan,
): void {
	if (!scan?.eligible) return;
	if (scan.zeroByteMarkdownCount > 0) {
		findings.push({
			check: "vault.misplaced_zero_byte_markdown",
			layer: "vault",
			severity: "warning",
			count: scan.zeroByteMarkdownCount,
			sampleSlugs: anonymousSamples(scan.zeroByteMarkdownCount),
			detail: "检测到 vault 边界外的零字节 Markdown；零字节不代表可安全删除",
			suggestedCommand: "cbrain fsck --layer vault --local-details",
		});
	}
	if (scan.reviewRequiredCount > 0) {
		findings.push({
			check: "vault.misplaced_review_required_artifact",
			layer: "vault",
			severity: "warning",
			count: scan.reviewRequiredCount,
			sampleSlugs: anonymousSamples(scan.reviewRequiredCount),
			detail: "检测到 vault 边界外需人工核查的 CBrain 形态条目",
			suggestedCommand: "cbrain fsck --layer vault --local-details",
		});
	}
	if (scan.unreadableCount > 0) {
		findings.push({
			check: "vault.misplaced_artifact_scan_incomplete",
			layer: "vault",
			severity: "warning",
			count: scan.unreadableCount,
			sampleSlugs: anonymousSamples(scan.unreadableCount),
			detail: "vault 边界外条目检查不完整；未输出路径或底层错误",
			suggestedCommand: "cbrain fsck --layer vault --local-details",
		});
	}
}

export function probeVault(
	vaultPath: string,
	db: CBrainDB,
	misplacedScan?: MisplacedVaultArtifactScan,
): FsckFinding[] {
	const findings: FsckFinding[] = [];
	const pages = db.listPages();
	const dbBySlug = new Map(pages.map((p) => [p.slug, p]));

	const fileExistsDbMissing: string[] = [];
	const mismatch: string[] = [];

	for (const abs of walkMd(vaultPath)) {
		const rel = relative(vaultPath, abs);
		const raw = readFileSync(abs, "utf-8");
		const { frontmatter } = parseFrontmatter(raw);
		const fmSlug = frontmatter.slug;
		if (!fmSlug) continue;

		const dbPage = dbBySlug.get(fmSlug);
		if (!dbPage) {
			fileExistsDbMissing.push(fmSlug);
			continue;
		}

		if (dbPage.file_path !== rel) {
			mismatch.push(fmSlug);
		}
	}

	if (fileExistsDbMissing.length > 0) {
		findings.push({
			check: "vault.file_exists_db_missing",
			layer: "vault",
			severity: "error",
			count: fileExistsDbMissing.length,
			sampleSlugs: anonymizeSlugs(fileExistsDbMissing),
			detail: "vault 有 .md 但 DB 无对应 page",
			suggestedCommand: "cbrain sync --slug <slug> --reindex",
		});
	}

	if (mismatch.length > 0) {
		findings.push({
			check: "vault.frontmatter_slug_mismatch",
			layer: "vault",
			severity: "warning",
			count: mismatch.length,
			sampleSlugs: anonymizeSlugs(mismatch),
			detail: "frontmatter slug/path 与 DB 不一致",
			suggestedCommand: "cbrain sync --slug <slug> --reindex",
		});
	}

	const dbExistsFileMissing = pages.filter(
		(p) => p.file_path && !existsSync(join(vaultPath, p.file_path)),
	);

	if (dbExistsFileMissing.length > 0) {
		findings.push({
			check: "vault.db_exists_file_missing",
			layer: "vault",
			severity: "error",
			count: dbExistsFileMissing.length,
			sampleSlugs: anonymizeSlugs(dbExistsFileMissing.map((p) => p.slug)),
			detail:
				"DB 有 page 但 vault 文件缺失（DB body 仍在 → backup 恢复 / re-ingest / manual writeback）",
			suggestedCommand: "cbrain show <slug>",
		});
	}

	appendMisplacedArtifactFindings(findings, misplacedScan);

	return findings;
}
