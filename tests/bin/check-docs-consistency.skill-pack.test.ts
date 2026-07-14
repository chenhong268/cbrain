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

test("checkInstallTarget passes when both cp -r and ln -s target canonical", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/brain-ops/cbrain\nln -s x ~/.hermes/skills/brain-ops/cbrain\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(false);
});

test("checkInstallTarget flags wrong parent dir", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/other/cbrain\nln -s x ~/.hermes/skills/brain-ops/cbrain\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(true);
});

test("checkInstallTarget flags wrong basename under brain-ops/", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/brain-ops/wrong-target\nln -s x ~/.hermes/skills/brain-ops/cbrain\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(true);
});

test("checkInstallTarget flags nested cbrain/skills/", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/brain-ops/cbrain/skills\nln -s x ~/.hermes/skills/brain-ops/cbrain\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(true);
});

test("checkInstallTarget fails when copy command missing", () => {
  const docs = new Map([["install-onboarding.md", "ln -s x ~/.hermes/skills/brain-ops/cbrain\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(true);
});

test("checkInstallTarget fails when symlink command missing", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/brain-ops/cbrain\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(true);
});
