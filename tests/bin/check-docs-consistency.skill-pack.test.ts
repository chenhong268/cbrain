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
// HIGH1+2: policy closes loop INSIDE docs/install-onboarding.md Step 7, split
// into a copy subsection + symlink subsection. symlink risks are checked ONLY
// in the symlink subsection (copy's pros must not substitute), and commands
// are checked ONLY inside real fenced blocks (prose cp/ln cannot pose). The
// mutation tests below guard both invariants.

const STEP7_FILE = "docs/install-onboarding.md";

const POLICY_DOC = [
  "## 第七步：验证 Hermes 技能包（可选）",
  "",
  "**方式 A：复制（默认推荐，用于稳定 Hermes）**",
  "",
  "```bash",
  "mkdir -p ~/.hermes/skills/brain-ops",
  'cp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain',
  "```",
  "",
  "- 优点：部署审核过的确定快照；文件落在 Hermes trusted root 内；checkout 后续修改不会自动进入真实 Agent。",
  "- 代价：升级后变 stale，需重新部署。",
  "",
  "**方式 B：符号链接（仅开发/试验环境，非生产默认）**",
  "",
  "```bash",
  "mkdir -p ~/.hermes/skills/brain-ops",
  'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain',
  "```",
  "",
  "- 风险：symlink resolved target 落在 Hermes trusted directory（~/.hermes/skills）之外时，Hermes 可能记录安全告警；",
  "- 风险：checkout 中的 skill 文件变化会立即影响 Hermes，把尚未发布的修改静默带进真实 Agent；",
  "- 适合本地开发联调。",
  "",
  "4. 安装后验证（应报 current）：",
  "",
  "## 第八步：启动服务",
].join("\n");

const step7 = (doc: string): Map<string, string> => new Map([[STEP7_FILE, doc]]);
const expectFail = (doc: string): void => {
  expect(fails(checkSkillPackInstallPolicy(step7(doc)))).toBe(true);
};
const expectPass = (doc: string): void => {
  expect(fails(checkSkillPackInstallPolicy(step7(doc)))).toBe(false);
};

test("G: correct copy-default policy in Step 7 passes", () => expectPass(POLICY_DOC));

test("A: symlink marked as default-recommended fails", () => {
  expectFail(POLICY_DOC.replace("**方式 B：符号链接（仅开发/试验环境，非生产默认）**", "**方式 B：符号链接（默认推荐）**"));
});

test("B: copy without default/production recommendation fails", () => {
  expectFail(POLICY_DOC.replace("**方式 A：复制（默认推荐，用于稳定 Hermes）**", "**方式 A：复制：**"));
});

test("C: missing trusted-directory/root warning in symlink subsection fails", () => {
  expectFail(POLICY_DOC.replace("- 风险：symlink resolved target 落在 Hermes trusted directory（~/.hermes/skills）之外时，Hermes 可能记录安全告警；\n", ""));
});

test("D: missing checkout-drift risk in symlink subsection fails", () => {
  expectFail(POLICY_DOC.replace("- 风险：checkout 中的 skill 文件变化会立即影响 Hermes，把尚未发布的修改静默带进真实 Agent；\n", ""));
});

test("copy subsection must precede symlink subsection", () => {
  const swapped = [
    "## 第七步：验证 Hermes 技能包（可选）",
    "**方式 B：符号链接（仅开发/试验环境）**",
    "```bash",
    'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    "```",
    "- 风险：symlink resolved target 落 trusted directory 之外，Hermes 可能告警；checkout 变化立即静默影响。",
    "**方式 A：复制（默认推荐，稳定 Hermes）**",
    "```bash",
    'cp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    "```",
    "4. 安装后验证：",
    "## 第八步",
  ].join("\n");
  expectFail(swapped);
});

test("missing Step 7 heading fails", () => {
  expectFail(POLICY_DOC.replace("## 第七步：验证 Hermes 技能包（可选）", "## 其他步"));
});

test("missing install-onboarding.md fails", () => {
  expect(fails(checkSkillPackInstallPolicy(new Map([["docs/other.md", POLICY_DOC]])))).toBe(true);
});

test("anti-aggregation: policy split across docs still fails", () => {
  const badInstall = [
    "## 第七步：验证 Hermes 技能包（可选）",
    "**方式 B：符号链接（默认推荐）**",
    "```bash",
    'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain',
    "```",
    "## 第八步",
  ].join("\n");
  expect(fails(checkSkillPackInstallPolicy(new Map([[STEP7_FILE, badInstall], ["docs/other.md", POLICY_DOC]])))).toBe(true);
});

// ── HIGH1 mutation: copy pros must NOT substitute for symlink risks ──
test("mutation: delete both symlink risks (keep copy pros with trusted-root + checkout-no-auto) fails", () => {
  const mut = POLICY_DOC
    .replace("- 风险：symlink resolved target 落在 Hermes trusted directory（~/.hermes/skills）之外时，Hermes 可能记录安全告警；\n", "")
    .replace("- 风险：checkout 中的 skill 文件变化会立即影响 Hermes，把尚未发布的修改静默带进真实 Agent；\n", "");
  expectFail(mut);
});

test("mutation: symlink checkout risk phrased as 'will not affect' fails (positive-only)", () => {
  const mut = POLICY_DOC.replace(
    "- 风险：checkout 中的 skill 文件变化会立即影响 Hermes，把尚未发布的修改静默带进真实 Agent；",
    "- 风险：checkout 中的 skill 文件变化不会影响 Hermes；",
  );
  expectFail(mut);
});

// ── HIGH2 mutations: commands must live INSIDE real fenced blocks ──
test("mutation: cp -r moved out of the copy fence (into prose) fails", () => {
  const mut = POLICY_DOC.replace(
    'mkdir -p ~/.hermes/skills/brain-ops\ncp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain\n```',
    'mkdir -p ~/.hermes/skills/brain-ops\n```\ncp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain（正文，非 fence）',
  );
  expectFail(mut);
});

test("mutation: ln -s moved out of the symlink fence (into prose) fails", () => {
  const mut = POLICY_DOC.replace(
    'mkdir -p ~/.hermes/skills/brain-ops\nln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain\n```',
    'mkdir -p ~/.hermes/skills/brain-ops\n```\nln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain（正文，非 fence）',
  );
  expectFail(mut);
});

test("mutation: ln -s leaking into the copy fenced block fails", () => {
  const mut = POLICY_DOC.replace(
    'cp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain\n```',
    'cp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain\nln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain\n```',
  );
  expectFail(mut);
});

test("mutation: cp -r leaking into the symlink fenced block fails", () => {
  const mut = POLICY_DOC.replace(
    'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain\n```',
    'ln -s "<pack>" ~/.hermes/skills/brain-ops/cbrain\ncp -r "<pack>" ~/.hermes/skills/brain-ops/cbrain\n```',
  );
  expectFail(mut);
});
