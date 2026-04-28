import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { ResolverChecker, type ResolutionRule } from "./resolver.js";

export interface EvalFixture {
  intent: string;
  expected_skill: string;
  ambiguous_with?: string[];
}

export interface EvalResult {
  intent: string;
  expected: string;
  matched: string | null;
  pass: boolean;
  ambiguous: boolean;
  ambiguous_with: string[] | undefined;
}

export interface EvalReport {
  total: number;
  pass: number;
  fail: number;
  results: EvalResult[];
}

export function matchIntent(intent: string, rules: ResolutionRule[]): { skill: string | null; matchedBy: string[] } {
  const matched: string[] = [];
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (intent.includes(pattern)) {
        matched.push(rule.skill);
        break; // one match per rule is enough
      }
    }
  }
  return {
    skill: matched[0] ?? null, // first match wins (resolution order)
    matchedBy: [...new Set(matched)],
  };
}

export function loadFixtures(skillsDir: string): EvalFixture[] {
  const fixtures: EvalFixture[] = [];
  if (!existsSync(skillsDir)) return fixtures;

  for (const entry of readdirSync(skillsDir)) {
    if (!entry.endsWith(".routing-eval.jsonl")) continue;
    const fixturePath = join(skillsDir, entry);

    const lines = readFileSync(fixturePath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const f = JSON.parse(line);
        if (f.intent && f.expected_skill) {
          fixtures.push({
            intent: f.intent,
            expected_skill: f.expected_skill,
            ambiguous_with: f.ambiguous_with,
          });
        }
      } catch {}
    }
  }
  return fixtures;
}

export function runEval(resolverPath: string): EvalReport {
  const skillsDir = dirname(resolverPath);
  const checker = new ResolverChecker(resolverPath);
  const rules = checker.parse();
  const fixtures = loadFixtures(skillsDir);

  const results: EvalResult[] = [];
  for (const f of fixtures) {
    const { skill, matchedBy } = matchIntent(f.intent, rules);
    const pass = skill === f.expected_skill;
    const ambiguous = f.ambiguous_with
      ? f.ambiguous_with.some((a) => matchedBy.includes(a))
      : matchedBy.length > 1 && !pass;

    results.push({
      intent: f.intent,
      expected: f.expected_skill,
      matched: skill,
      pass,
      ambiguous,
      ambiguous_with: f.ambiguous_with,
    });
  }

  return {
    total: results.length,
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    results,
  };
}
