import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface ResolutionRule {
  patterns: string[];
  skill: string;
  flags: string[];
  category: string;
}

export interface ResolverReport {
  rules: number;
  skillsReferenced: string[];
  skillsOnDisk: string[];
  orphans: string[];
  missingFiles: string[];
  coverage: { category: string; rules: number }[];
  overlaps: { pattern: string; skills: string[] }[];
  valid: boolean;
  issues: string[];
}

export class ResolverChecker {
  private resolverPath: string;

  constructor(resolverPath: string) {
    this.resolverPath = resolverPath;
  }

  parse(): ResolutionRule[] {
    const content = readFileSync(this.resolverPath, "utf-8");
    const rules: ResolutionRule[] = [];
    let currentCategory = "";

    for (const line of content.split("\n")) {
      const catMatch = line.match(/^### (.+)/);
      if (catMatch && !catMatch[1].includes("Resolution") && !catMatch[1].includes("Inventory") && !catMatch[1].includes("Validation")) {
        currentCategory = catMatch[1].trim();
        continue;
      }

      const ruleMatch = line.match(/^-\s*(.+?)\s*→\s*(\S+\.md)\s*(.*)$/);
      if (ruleMatch && currentCategory) {
        const patternStr = ruleMatch[1].trim();
        const skill = ruleMatch[2].trim();
        const flagsStr = ruleMatch[3].trim();

        const patterns = patternStr.split(/[、,]/).map((s) => s.trim()).filter(Boolean);
        const flagMatches = flagsStr.match(/\[([^\]]+)\]/g);
        const flags = flagMatches ? flagMatches.map((f) => f.slice(1, -1)) : [];

        rules.push({ patterns, skill, flags, category: currentCategory });
      }
    }

    return rules;
  }

  check(): ResolverReport {
    const issues: string[] = [];
    const rules = this.parse();
    const skillsDir = join(dirname(this.resolverPath));

    // All skill files referenced
    const skillsReferenced = [...new Set(rules.map((r) => r.skill))];
    const skillsOnDisk = skillsReferenced.filter((s) => existsSync(join(skillsDir, s)));

    // Missing files
    const missingFiles = skillsReferenced.filter((s) => !skillsOnDisk.includes(s));
    for (const f of missingFiles) {
      issues.push(`Missing file: skills/${f} referenced in RESOLVER.md but not found on disk`);
    }

    // Orphans: skills on disk not referenced in RESOLVER.md
    const allMdFiles = existsSync(skillsDir)
      ? readdirSync(skillsDir).filter((f: string) => f.endsWith(".md") && f !== "RESOLVER.md")
      : [];
    const orphans = allMdFiles.filter((f: string) => !skillsReferenced.includes(f));
    for (const f of orphans) {
      issues.push(`Orphan skill: skills/${f} exists on disk but is not referenced in RESOLVER.md`);
    }

    // Overlap detection: patterns that appear in multiple rules
    const patternMap = new Map<string, string[]>();
    for (const rule of rules) {
      for (const p of rule.patterns) {
        const existing = patternMap.get(p);
        if (existing) {
          existing.push(rule.skill);
        } else {
          patternMap.set(p, [rule.skill]);
        }
      }
    }
    const overlaps: { pattern: string; skills: string[] }[] = [];
    for (const [pattern, skills] of patternMap) {
      if (skills.length > 1) {
        overlaps.push({ pattern, skills });
        issues.push(`Overlap: pattern "${pattern}" matches ${skills.length} skills (${skills.join(", ")})`);
      }
    }

    // Category coverage
    const categories = [...new Set(rules.map((r) => r.category))];
    const coverage = categories.map((c) => ({
      category: c,
      rules: rules.filter((r) => r.category === c).length,
    }));

    const valid = issues.length === 0;

    return {
      rules: rules.length,
      skillsReferenced,
      skillsOnDisk,
      orphans,
      missingFiles,
      coverage,
      overlaps,
      valid,
      issues,
    };
  }
}
