import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "../..");

function parse(relativePath: string): ts.SourceFile {
  const path = join(ROOT, relativePath);
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function calledName(node: ts.CallExpression): string | undefined {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return undefined;
}

function callsWithin(node: ts.Node, name: string): ts.CallExpression[] {
  const matches: ts.CallExpression[] = [];
  function visit(child: ts.Node): void {
    if (ts.isCallExpression(child) && calledName(child) === name) matches.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return matches;
}

function findCommandAction(source: ts.SourceFile, command: string): ts.Node {
  let action: ts.Node | undefined;
  function chainCommandName(expression: ts.Expression): string | undefined {
    if (ts.isCallExpression(expression)) {
      if (calledName(expression) === "command") {
        const first = expression.arguments[0];
        return first && ts.isStringLiteral(first) ? first.text : undefined;
      }
      return chainCommandName(expression.expression);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return chainCommandName(expression.expression);
    }
    return undefined;
  }
  function visit(node: ts.Node): void {
    if (!ts.isCallExpression(node) || calledName(node) !== "action") {
      ts.forEachChild(node, visit);
      return;
    }
    if (chainCommandName(node.expression) === command) {
      action = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!action) throw new Error(`command action not found: ${command}`);
  return action;
}

function healthCheckerConstructions(source: ts.SourceFile): ts.NewExpression[] {
  const matches: ts.NewExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "HealthChecker") {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return matches;
}

describe("#341 trusted boundary runtime threading contracts", () => {
  test.each([
    ["src/cli/commands/server.ts", "serve"],
    ["src/cli/commands/maintenance.ts", "health"],
    ["src/cli/commands/maintenance.ts", "health-debt"],
    ["src/cli/commands/maintenance.ts", "dream"],
  ])("%s %s resolves the active config and boundary exactly once", (path, command) => {
    const action = findCommandAction(parse(path), command);
    expect(callsWithin(action, "loadConfigWithPath")).toHaveLength(1);
    expect(callsWithin(action, "loadConfig")).toHaveLength(0);
    expect(callsWithin(action, "resolveTrustedVaultBoundary")).toHaveLength(1);
  });

  test("all six health runtime construction paths pass a boundary as argument five", () => {
    const sources = [
      parse("src/cli/commands/maintenance.ts"),
      parse("src/mcp/server.ts"),
      parse("src/mcp/tools/ops.ts"),
      parse("src/mcp/tools/action-candidates.ts"),
    ];
    const constructions = sources.flatMap(healthCheckerConstructions);
    expect(constructions).toHaveLength(6);
    for (const construction of constructions) {
      expect(construction.arguments).toHaveLength(5);
      expect(construction.arguments?.[4]?.getText()).toMatch(/vaultBoundary$/);
    }
  });

  test("downstream MCP runtime files never reload or resolve the active config", () => {
    for (const path of [
      "src/mcp/context.ts",
      "src/mcp/server.ts",
      "src/mcp/tools/ops.ts",
      "src/mcp/tools/action-candidates.ts",
    ]) {
      const source = parse(path);
      expect(callsWithin(source, "loadConfigWithPath")).toHaveLength(0);
      expect(callsWithin(source, "loadConfig")).toHaveLength(0);
      expect(callsWithin(source, "resolveTrustedVaultBoundary")).toHaveLength(0);
    }
  });
});
