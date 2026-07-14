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

test("checkInstallTarget flags nested skills/ suffix", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/brain-ops/cbrain/skills/\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(true);
});

test("checkInstallTarget passes exact brain-ops/cbrain path", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/brain-ops/cbrain\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(false);
});

test("checkInstallTarget flags wrong basename under brain-ops/", () => {
  const docs = new Map([["install-onboarding.md", "cp -r x ~/.hermes/skills/brain-ops/wrong-target\n"]]);
  expect(fails(checkInstallTarget(docs))).toBe(true);
});
