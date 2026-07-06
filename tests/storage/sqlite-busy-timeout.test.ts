import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CBrainDB } from "../../src/storage/sqlite.js";

const SET_WAL_RE = /PRAGMA\s+journal_mode\s*=\s*['"]?wal/i;

function withJournalModeSetCounter(fn: () => void): number {
  const orig = Database.prototype.exec;
  let calls = 0;
  const spy = function (this: Database, ...args: Parameters<typeof orig>) {
    if (typeof args[0] === "string" && SET_WAL_RE.test(args[0])) calls++;
    return orig.apply(this, args);
  } as typeof orig;
  Database.prototype.exec = spy;
  try {
    fn();
  } finally {
    Database.prototype.exec = orig;
  }
  return calls;
}

/**
 * #307: CBrainDB 不得对已 WAL 的 DB 重复执行 `PRAGMA journal_mode = WAL`。
 *
 * SQLite 在执行该 PRAGMA 时（即使 DB 已是 WAL、属 no-op）仍会尝试获取 EXCLUSIVE
 * 锁来「切换」，而 busy_handler 不保护该 PRAGMA —— 遇到 checkpoint 窗口就立即抛
 * "database is locked"。fsck CLI reopen WAL DB 时偶发撞上，表现为
 * fsck.blackbox `--repair-stale-fts` test flaky。
 *
 * 修复：先读 journal_mode（普通读，受 busy_timeout 保护可重试），仅在非 wal 时才设。
 */
test("CBrainDB reopen of an already-WAL DB does not re-issue PRAGMA journal_mode = WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbrain-journalmode-"));
  const dbPath = join(dir, "brain.sqlite");
  try {
    // 1) 首次 open：新 DB（rollback）必须设一次 WAL
    const firstCalls = withJournalModeSetCounter(() => {
      const init = new CBrainDB(dbPath);
      init.close();
    });
    expect(firstCalls, "fresh rollback DB must set WAL exactly once").toBe(1);

    // 2) 再次 open：DB 已 WAL，修复后不应再执行 `PRAGMA journal_mode = WAL`
    const reopenCalls = withJournalModeSetCounter(() => {
      const reopen = new CBrainDB(dbPath, { skipMigrate: true });
      reopen.close();
    });
    expect(reopenCalls, "already-WAL DB must NOT re-issue journal_mode = WAL (avoids EXCLUSIVE grab)").toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
