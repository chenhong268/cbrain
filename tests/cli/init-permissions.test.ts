import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performInit } from "../../src/cli/commands/brain.js";

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

  describePosix("creates cbrain.json owner-only (0600) regardless of umask", () => {
    test("mode 0600 even under a fully permissive umask (000)", () => {
      // A permissive umask would normally leave the file group/world-readable.
      // chmod-after-write is umask-independent, so the result must still be 0600.
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

  test("force-init preserves owner-only creation and leaves unrelated vault data intact", () => {
    const brainDir = join(testDir, "brain");
    const sentinelDir = join(brainDir, "vault", "records");
    const sentinel = join(sentinelDir, "keep-me.md");

    // Pre-existing config (triggers the --force overwrite path) + a sentinel
    // vault file that must survive the re-init untouched.
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(brainDir, "cbrain.json"), "{\"placeholder\":true}", "utf-8");
    writeFileSync(sentinel, "untouched user content", "utf-8");

    const result = performInit(brainDir, true);
    expect(result.status).toBe("ok");

    // Unrelated user data is preserved.
    expect(existsSync(sentinel)).toBe(true);

    // The recreated config is owner-only on POSIX; on win32 chmod is a no-op,
    // so only assert the contract where mode bits are meaningful.
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
