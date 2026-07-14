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
// HIGH2: policy must close-loop INSIDE docs/install-onboarding.md Step 7.
// No aggregation across docs; another doc's keywords cannot supply a miss.

const STEP7_FILE = "docs/install-onboarding.md";

const POLICY_DOC = [
  "## 第七步：验证 Hermes 技能包（可选）",
  "",
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
  "symlink 风险：resolved target 位于 Hermes trusted directory（~/.hermes/skills）外时，Hermes 可能记录安全告警；checkout 中的 skill 文件变化会立即影响 Hermes。",
  "",
  "## 第八步：启动服务",
].join("\n");

test("G: correct copy-default policy in Step 7 passes", () => {
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, POLICY_DOC]])))).toBe(false);
});

test("A: symlink marked as default-recommended fails", () => {
  const doc = POLICY_DOC.replace("**方式 B：符号链接（仅开发/试验环境，非生产默认）**", "**方式 B：符号链接（默认推荐）**");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, doc]])))).toBe(true);
});

test("B: copy without default/production recommendation fails", () => {
  const doc = POLICY_DOC.replace("**方式 A：复制（默认推荐，用于稳定 Hermes）**", "**方式 A：复制：**");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, doc]])))).toBe(true);
});

test("C: missing trusted-directory/root warning fails", () => {
  const doc = POLICY_DOC.replace("resolved target 位于 Hermes trusted directory（~/.hermes/skills）外时，Hermes 可能记录安全告警；", "");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, doc]])))).toBe(true);
});

test("D: missing checkout-drift risk fails", () => {
  const doc = POLICY_DOC.replace("checkout 中的 skill 文件变化会立即影响 Hermes。", "");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, doc]])))).toBe(true);
});

test("copy section must precede symlink section", () => {
  const swapped = [
    "## 第七步：验证 Hermes 技能包（可选）",
    "**方式 B：符号链接（仅开发/试验环境）**",
    "```bash",
    'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    "```",
    "**方式 A：复制（默认推荐，稳定 Hermes）**",
    "```bash",
    'cp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    "```",
    "trusted directory 外会告警；checkout 变化立即影响。",
    "## 第八步",
  ].join("\n");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, swapped]])))).toBe(true);
});

test("cp and ln in the same fenced block within Step 7 fails (separate-blocks contract)", () => {
  const sameBlock = [
    "## 第七步：验证 Hermes 技能包（可选）",
    "**方式 A：复制（默认推荐，稳定 Hermes）**；**方式 B：符号链接（仅开发/试验环境）**",
    "```bash",
    'cp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    "```",
    "trusted directory 外告警；checkout 变化立即影响。",
    "## 第八步",
  ].join("\n");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, sameBlock]])))).toBe(true);
});

test("missing Step 7 heading fails", () => {
  const noHeading = POLICY_DOC.replace("## 第七步：验证 Hermes 技能包（可选）\n\n", "## 其他步\n\n");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, noHeading]])))).toBe(true);
});

test("missing install-onboarding.md fails", () => {
  expect(fails(checkSkillPackInstallPolicy(new Map([["docs/other.md", POLICY_DOC]])))).toBe(true);
});

test("anti-aggregation: policy split across docs still fails (only install-onboarding Step 7 counts)", () => {
  const badInstall = [
    "## 第七步：验证 Hermes 技能包（可选）",
    "**方式 B：符号链接（默认推荐）**",
    "```bash",
    'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    "```",
    "## 第八步",
  ].join("\n");
  const docs = new Map([
    [STEP7_FILE, badInstall],
    ["docs/other.md", POLICY_DOC],
  ]);
  expect(fails(checkSkillPackInstallPolicy(docs))).toBe(true);
});
