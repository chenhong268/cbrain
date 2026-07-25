import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performInit } from "../../src/cli/commands/brain.js";
import { CBrainDB } from "../../src/storage/sqlite.js";

// POSIX-only group: file-mode semantics (0600) are meaningful on darwin/linux,
// not on win32 (ACL-governed). Mirrors the describe.skip idiom in
// tests/cli/structured-cohort-adapter.test.ts but gates on POSIX, not darwin.
const describePosix = process.platform !== "win32" ? describe : describe.skip;

describe("performInit — cbrain.json permissions (#383)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cbrain-init-perms-"));
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  describePosix("creates cbrain.json with no group/other access (0600 under permissive/typical umasks)", () => {
    test("mode 0600 even under a fully permissive umask (000)", () => {
      // A permissive umask would normally leave a default-mode file group/
      // world-readable. The file is created with an explicit 0600 mode; umask
      // only clears bits, so under umask 000 the result is exactly 0600 and
      // group/other bits stay clear.
      const savedUmask = process.umask(0o000);
      try {
        const result = performInit(join(testDir, "brain"), false);
        expect(result.status).toBe("ok");
        expect(result.configPath).toBeDefined();
        const mode = statSync(result.configPath).mode & 0o777;
        expect(mode).toBe(0o600);
      } finally {
        process.umask(savedUmask);
      }
    });

    test("mode 0600 under a typical umask (022)", () => {
      const savedUmask = process.umask(0o022);
      try {
        const result = performInit(join(testDir, "brain"), false);
        expect(result.status).toBe("ok");
        expect(statSync(result.configPath).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(savedUmask);
      }
    });
  });

  test("force-init preserves owner-only creation and leaves unrelated vault/DB data intact", () => {
    const brainDir = join(testDir, "brain");
    const sentinelDir = join(brainDir, "vault", "records");
    const sentinel = join(sentinelDir, "keep-me.md");
    const dbPath = join(brainDir, "brain.sqlite");

    // Pre-existing config (triggers the --force overwrite path) + a sentinel
    // vault file and an anonymous DB row that must survive the re-init.
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(brainDir, "cbrain.json"), "{\"placeholder\":true}", "utf-8");
    writeFileSync(sentinel, "untouched user content", "utf-8");

    const seedDb = new CBrainDB(dbPath);
    seedDb.setConfig("cbrain-test-sentinel", "preserved");
    seedDb.close();

    const result = performInit(brainDir, true);
    expect(result.status).toBe("ok");

    // Unrelated user data is preserved — both the vault file and the DB row.
    expect(existsSync(sentinel)).toBe(true);
    const reopenDb = new CBrainDB(dbPath);
    const preserved = reopenDb.getAllConfig().some(
      (r) => r.key === "cbrain-test-sentinel" && r.value === "preserved",
    );
    reopenDb.close();
    expect(preserved).toBe(true);

    // The recreated config is owner-only on POSIX; on win32 the mode argument
    // is a no-op (ACL-governed), so only assert where mode bits are meaningful.
    if (process.platform !== "win32") {
      expect(statSync(result.configPath).mode & 0o777).toBe(0o600);
    }
  });

  test("init succeeds on every platform (no throw from the hardening step)", () => {
    const result = performInit(join(testDir, "brain"), false);
    expect(result.status).toBe("ok");
    expect(existsSync(result.configPath)).toBe(true);
  });
});
