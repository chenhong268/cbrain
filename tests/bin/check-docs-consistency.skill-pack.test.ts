import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { checkManifestVersion, checkInstallTarget } from "../../bin/check-docs-consistency.js";

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
