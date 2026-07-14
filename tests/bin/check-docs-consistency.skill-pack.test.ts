import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { checkManifestVersion, checkInstallTarget, checkSkillPackInstallPolicy } from "../../bin/check-docs-consistency.js";

function fails(r: { passed: boolean }[]): boolean {
  return r.some((x) => !x.passed);
}

test("checkManifestVersion flags packVersion mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-mv-"));
  try {
    writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ packVersion: "0.0.0-wrong" }));
    expect(fails(checkManifestVersion(join(dir, "MANIFEST.json")))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("checkManifestVersion passes on real skills/MANIFEST.json", () => {
  const realManifest = join(import.meta.dir, "../..", "skills", "MANIFEST.json");
  expect(fails(checkManifestVersion(realManifest))).toBe(false);
});

const CP_BLOCK = "```bash\nmkdir -p ~/.hermes/skills/brain-ops\ncp -r x ~/.hermes/skills/brain-ops/cbrain\n```";
const LN_BLOCK = "```bash\nmkdir -p ~/.hermes/skills/brain-ops\nln -s x ~/.hermes/skills/brain-ops/cbrain\n```";

test("checkInstallTarget passes when cp and ln in separate blocks, both canonical", () => {
  expect(fails(checkInstallTarget(new Map([["d.md", LN_BLOCK + "\n" + CP_BLOCK]])))).toBe(false);
});

test("checkInstallTarget flags wrong parent dir", () => {
  expect(fails(checkInstallTarget(new Map([["d.md", LN_BLOCK + "\n```bash\ncp -r x ~/.hermes/skills/other/cbrain\n```"]])))).toBe(true);
});

test("checkInstallTarget flags wrong basename under brain-ops/", () => {
  expect(fails(checkInstallTarget(new Map([["d.md", LN_BLOCK + "\n```bash\ncp -r x ~/.hermes/skills/brain-ops/wrong\n```"]])))).toBe(true);
});

test("checkInstallTarget flags nested cbrain/skills/", () => {
  expect(fails(checkInstallTarget(new Map([["d.md", LN_BLOCK + "\n```bash\ncp -r x ~/.hermes/skills/brain-ops/cbrain/skills\n```"]])))).toBe(true);
});

test("checkInstallTarget fails when copy command missing", () => {
  expect(fails(checkInstallTarget(new Map([["d.md", LN_BLOCK]])))).toBe(true);
});

test("checkInstallTarget fails when symlink command missing", () => {
  expect(fails(checkInstallTarget(new Map([["d.md", CP_BLOCK]])))).toBe(true);
});

test("checkInstallTarget rejects cp -r + ln -s in the same fenced block", () => {
  const same = "```bash\nmkdir -p ~/.hermes/skills/brain-ops\nln -s x ~/.hermes/skills/brain-ops/cbrain\ncp -r x ~/.hermes/skills/brain-ops/cbrain\n```";
  expect(fails(checkInstallTarget(new Map([["d.md", same]])))).toBe(true);
});

// ── Skill-pack install POLICY gate (copy default, symlink dev-only) ──

const POLICY_DOC = [
  "**方式 A：复制（默认推荐，用于稳定 Hermes）**",
  "```bash",
  "mkdir -p ~/.hermes/skills/brain-ops",
  'cp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain',
  "```",
  "**方式 B：符号链接（仅开发/试验环境，非生产默认）**",
  "```bash",
  "mkdir -p ~/.hermes/skills/brain-ops",
  'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain',
  "```",
  "symlink 风险：resolved target 位于 ~/.hermes/skills 外时，Hermes 可能记录 trusted-directory security warning；checkout 中的 skill 文件变化会立即影响 Hermes。",
].join("\n");

test("G: correct copy-default policy passes", () => {
  expect(fails(checkSkillPackInstallPolicy(new Map([["install.md", POLICY_DOC]])))).toBe(false);
});

test("A: symlink marked as default-recommended fails", () => {
  const doc = POLICY_DOC.replace("**方式 B：符号链接（仅开发/试验环境，非生产默认）**", "**方式 B：符号链接（默认推荐）**");
  expect(fails(checkSkillPackInstallPolicy(new Map([["install.md", doc]])))).toBe(true);
});

test("B: copy without default/production recommendation fails", () => {
  const doc = POLICY_DOC.replace("**方式 A：复制（默认推荐，用于稳定 Hermes）**", "**方式 A：复制：**");
  expect(fails(checkSkillPackInstallPolicy(new Map([["install.md", doc]])))).toBe(true);
});

test("C: missing trusted-directory warning fails", () => {
  const doc = POLICY_DOC.replace("trusted-directory security warning；", "");
  expect(fails(checkSkillPackInstallPolicy(new Map([["install.md", doc]])))).toBe(true);
});

test("D: missing checkout-drift risk fails", () => {
  const doc = POLICY_DOC.replace("checkout 中的 skill 文件变化会立即影响 Hermes。", "");
  expect(fails(checkSkillPackInstallPolicy(new Map([["install.md", doc]])))).toBe(true);
});

// Cases E (cp + ln same fenced block) and F (nested cbrain/skills target) are
// owned by checkInstallTarget and already covered by the existing tests above
// ("rejects cp -r + ln -s in the same fenced block" + "flags nested
// cbrain/skills/"). checkSkillPackInstallPolicy itself is covered by A-D + G.
