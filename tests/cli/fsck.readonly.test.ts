import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { runFsck } from "../../src/cli/commands/fsck.js";
import { resolveTrustedVaultBoundary } from "../../src/core/maintenance/misplaced-vault-artifacts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function hashFile(p: string): Promise<string> {
  const buf = await readFile(p);
  return createHash("sha256").update(buf).digest("hex");
}

function dirSnapshot(root: string): string {
  // snapshot file names + mtimes under root (recursive), sorted and joined
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(`${p}:${statSync(p).mtimeMs}`);
    }
  };
  walk(root);
  return out.sort().join("|");
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test("fsck is read-only: DB hash + vault mtimes + lance dir unchanged", async () => {
  dir = mkdtempSync(join(tmpdir(), "cbrain-fsck-ro-"));
  const dbPath = join(dir, "t.sqlite");
  const vaultPath = join(dir, "vault");
  const lancePath = join(dir, "lance");

  mkdirSync(join(vaultPath, "entities"), { recursive: true });
  mkdirSync(lancePath);
  mkdirSync(join(dir, ".obsidian"));
  writeFileSync(join(dir, "anonymous-empty.md"), "");

  const mdContent = "---\nslug: test-readonly-e\ntitle: t\ntype: entity\n---\nbody";
  writeFileSync(join(vaultPath, "entities", "e.md"), mdContent);

  // Seed a page via real insertPage API (camelCase fields)
  const db = new CBrainDB(dbPath);
  db.insertPage({
    slug: "test-readonly-e",
    type: "entity",
    title: "t",
    filePath: "entities/e.md",
    contentHash: createHash("sha256").update(mdContent).digest("hex"),
  });

  const beforeDb = await hashFile(dbPath);
  const beforeVault = dirSnapshot(vaultPath);
  const beforeLance = dirSnapshot(lancePath);
  const beforeCandidate = statSync(join(dir, "anonymous-empty.md")).mtimeMs;
  db.close();

  // Reopen and run fsck
  const db2 = new CBrainDB(dbPath);
  const vaultBoundary = resolveTrustedVaultBoundary({ configRoot: dir, vaultPath });
  expect(vaultBoundary).toBeDefined();
  await runFsck({ vaultPath, lancePath, db: db2, vaultBoundary });
  await runFsck({ vaultPath, lancePath, db: db2, vaultBoundary, layer: "vault", includeLocalDetails: true });
  db2.close();

  expect(await hashFile(dbPath)).toBe(beforeDb);
  expect(dirSnapshot(vaultPath)).toBe(beforeVault);
  expect(dirSnapshot(lancePath)).toBe(beforeLance);
  expect(statSync(join(dir, "anonymous-empty.md")).mtimeMs).toBe(beforeCandidate);
});
