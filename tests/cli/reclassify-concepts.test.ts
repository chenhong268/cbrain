import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dir, "..", "..", "src", "cli", "reclassify-concepts.ts");

describe("reclassify-concepts vault resolution (#192)", () => {
  test("source contains no hardcoded absolute/local path (structural check only)", () => {
    const src = readFileSync(SCRIPT, "utf-8");
    // Structural patterns — no real identifier is named here.
    expect(src).not.toMatch(/\/Users\//);            // no hardcoded home path
    expect(src).not.toMatch(/~\//);                  // no hardcoded ~/home
    expect(src).not.toMatch(/Library\//);            // no macOS-local Library segment
  });

  test("exits cleanly with a safe diagnostic when no vault is resolvable", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cbrain-reclassify-no-vault-"));
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CBRAIN_VAULT;
    delete env.CBRAIN_CONFIG;

    const r = spawnSync("bun", ["run", SCRIPT, "--dry-run"], { encoding: "utf-8", cwd, env });
    rmSync(cwd, { recursive: true });

    expect(r.status).not.toBe(0);
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    expect(out).toMatch(/vault path not set|CBRAIN_VAULT|cbrain init/i);
    // The diagnostic must not leak any absolute/local path.
    expect(out).not.toMatch(/\/Users\//);
    expect(out).not.toMatch(/Library\//);
  });

  test("explicit CBRAIN_VAULT runs --dry-run over a synthetic vault (happy path)", () => {
    const vault = mkdtempSync(join(tmpdir(), "cbrain-reclassify-vault-"));
    const conceptDir = join(vault, "brain/concepts/concept");
    mkdirSync(conceptDir, { recursive: true });
    // Filenames carry domain keywords from the script's own lists (no real names/orgs).
    writeFileSync(join(conceptDir, "多巴胺.md"), "---\ntype: concept/concept\nslug: brain/concepts/concept/duo-ba-an\n---\n\n神经科学相关");
    writeFileSync(join(conceptDir, "医保集采.md"), "---\ntype: concept/concept\nslug: brain/concepts/concept/yi-bao\n---\n\n药品合规相关");
    const srcDopamine = join(conceptDir, "多巴胺.md");
    const srcYibao = join(conceptDir, "医保集采.md");

    const r = spawnSync("bun", ["run", SCRIPT, "--dry-run"], {
      encoding: "utf-8",
      cwd: vault,
      env: { ...process.env, CBRAIN_VAULT: vault },
    });

    // Dry-run must not move/write anything.
    expect(existsSync(srcDopamine)).toBe(true);
    expect(existsSync(srcYibao)).toBe(true);
    expect(existsSync(join(vault, "brain/concepts/psychology/多巴胺.md"))).toBe(false);
    expect(existsSync(join(vault, "brain/concepts/pharma/医保集采.md"))).toBe(false);

    expect(r.status).toBe(0);
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    expect(out).toContain("DRY RUN");
    // Reclassification was computed (psychology/pharma targets) without writing.
    expect(out).toMatch(/psychology|pharma/);

    rmSync(vault, { recursive: true });
  });
});
