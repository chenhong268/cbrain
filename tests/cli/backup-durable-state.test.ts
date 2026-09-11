import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CBrainDB } from "../../src/storage/sqlite.js";
import { SqliteProvenanceStore } from "../../src/storage/provenance-store.js";
import { performInit } from "../../src/cli/commands/brain.js";

// Exercise the actual archive commands, never the user's profile or database.
test("backup/restore preserves vault, versions, trust history and feedback (#484)", () => {
  const root = mkdtempSync(join(tmpdir(), "cbrain-durable-roundtrip-"));
  const profile = join(root, "profile");
  let db: CBrainDB | undefined;
  try {
    expect(performInit(profile, false).status).not.toBe("error");
    const configPath = join(profile, "cbrain.json");
    const configBefore = readFileSync(configPath, "utf8");
    const dbPath = join(profile, "brain.sqlite");
    const notePath = join(profile, "vault", "records", "anonymous.md");
    const body = "---\ntitle: 主题D\ntype: record\n---\n匿名原文与个人思考。\n";
    writeFileSync(notePath, body);
    db = new CBrainDB(dbPath);
    for (const [slug, title] of [["records/anonymous", "主题D"], ["entities/a", "实体A"], ["entities/b", "实体B"]]) {
      db.upsertPage({ slug: slug!, title: title!, type: slug!.startsWith("records") ? "record" : "entity/person", filePath: `${slug}.md`, contentHash: "fixture" });
    }
    db.createVersion("records/anonymous", "匿名旧版正文", "title: 主题D");
    db.createVersion("records/anonymous", body);
    const linkId = Number(db.rawDb.prepare("INSERT INTO links (from_slug, to_slug, relation, source_type, trust_state, source_page_slug, evidence) VALUES ('entities/a', 'entities/b', 'knows', 'manual', 'trusted', 'records/anonymous', '匿名出处')").run().lastInsertRowid);
    const provenance = new SqliteProvenanceStore(db.rawDb);
    provenance.insertProvenanceHistory("link", linkId, "candidate", "trusted", "explicit_input", "匿名确认");
    db.insertFeedback(null, "records/anonymous", "relevant", "匿名反馈");
    db.addAlias("entities/a", "别名甲");
    const snapshot = (database: CBrainDB) => ({
      versions: database.rawDb.prepare("SELECT page_slug, version, content, frontmatter FROM versions ORDER BY version").all(),
      links: database.rawDb.prepare("SELECT from_slug, to_slug, relation, trust_state, source_page_slug, evidence FROM links").all(),
      history: database.rawDb.prepare("SELECT target_type, target_id, old_trust_state, new_trust_state, source_category, reason FROM provenance_history").all(),
      feedback: database.rawDb.prepare("SELECT slug, signal, note FROM query_feedback").all(),
      aliases: database.rawDb.prepare("SELECT page_slug, alias FROM aliases").all(),
    });
    const expected = snapshot(db);
    db.close(); db = undefined;
    const cli = join(import.meta.dir, "../../src/cli/index.ts");
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], {
      cwd: profile, env: { ...process.env, CBRAIN_CONFIG: configPath }, encoding: "utf8", timeout: 15_000,
    });
    const backups = join(root, "backups");
    run("backup", "-o", backups);
    const archives = readdirSync(backups).filter(name => name.endsWith(".zip"));
    expect(archives).toHaveLength(1);
    const archive = join(backups, archives[0]!);
    const members = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
    expect(members).toContain("brain.sqlite");
    expect(members).toMatch(/vault\/(?:\.\/)?records\/anonymous\.md/);
    expect(members).not.toContain("cbrain.json");
    db = new CBrainDB(dbPath);
    db.rawDb.exec("DELETE FROM versions; DELETE FROM provenance_history; DELETE FROM query_feedback; DELETE FROM aliases; UPDATE links SET trust_state = 'rejected'");
    expect(snapshot(db)).not.toEqual(expected);
    db.close(); db = undefined;
    writeFileSync(notePath, "被修改的匿名正文");
    run("restore", archive, "--force");
    db = new CBrainDB(dbPath);
    expect(snapshot(db)).toEqual(expected);
    expect(readFileSync(notePath, "utf8")).toBe(body);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
