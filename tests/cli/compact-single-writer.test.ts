import { describe, test, expect, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanceDBManager } from "../../src/storage/lancedb.js";
import { handleCompact } from "../../src/cli/commands/maintenance.js";
import type { LockProbe } from "../../src/cli/commands/reindex.js";

const SRC = readFileSync(join(import.meta.dir, "../../src/cli/commands/maintenance.ts"), "utf-8");

/** Lance stub: records calls; compact returns the documented result shape. */
function makeLance(opts: { connectThrows?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    stub: {
      connect: mock(async () => {
        calls.push("connect");
        if (opts.connectThrows) throw new Error("MUST NOT CONNECT");
      }),
      compact: mock(async () => {
        calls.push("compact");
        return {
          tables: ["chunks", "insights"],
          fragmentsRemoved: 3,
          fragmentsAdded: 1,
          bytesRemoved: 100,
          filesRemoved: 2,
        };
      }),
      close: mock(async () => { calls.push("close"); }),
    } as unknown as LanceDBManager,
  };
}

const blocking: LockProbe = { blockingOwner: () => ({ kind: "serve", pid: 4242 }) };
const open: LockProbe = { blockingOwner: () => null };

describe("cbrain compact — single-writer guard (#234)", () => {
  test("refuses when a live writer holds the index; never connects/compacts", async () => {
    const { stub, calls } = makeLance({ connectThrows: true });
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = await handleCompact(
      { lance: stub, lancePath: "/tmp/lance", lockProbe: blocking },
      () => 0,
      (m) => logs.push(m),
      (m) => errs.push(m),
    );
    expect(exit).toBe(1);
    expect(calls).not.toContain("connect");
    expect(calls).not.toContain("compact");
    // Diagnostic names the writer + points to the safe entry, no risky guidance.
    const joined = errs.join("\n");
    expect(joined).toContain("已拒绝");
    expect(joined).toContain("4242");
    expect(joined).toContain("cbrain-maintenance.sh");
    expect(logs).toHaveLength(0);
  });

  test("proceeds when no writer is active; reports tables/fragments/disk", async () => {
    const { stub } = makeLance();
    const logs: string[] = [];
    let measured = 0;
    const exit = await handleCompact(
      { lance: stub, lancePath: "/tmp/lance", lockProbe: open },
      () => { measured += 1; return measured === 1 ? 2_000_000 : 1_000_000; },
      (m) => logs.push(m),
      () => {},
    );
    expect(exit).toBe(0);
    const joined = logs.join("\n");
    expect(joined).toContain("chunks");            // tables
    expect(joined).toContain("3 removed");         // fragmentsRemoved
    expect(joined).toContain("saved");             // disk delta
  });

  test("diagnostics never leak local absolute paths", async () => {
    const { stub } = makeLance({ connectThrows: true });
    const logs: string[] = [];
    const errs: string[] = [];
    await handleCompact(
      { lance: stub, lancePath: "/tmp/lance", lockProbe: blocking },
      () => 0,
      (m) => logs.push(m),
      (m) => errs.push(m),
    );
    const blob = JSON.stringify([...logs, ...errs]);
    expect(blob).not.toMatch(/\/Users\/|\/home\/[a-z]/i);
  });

  test("refuses without touching lance (no connect, no close — early return)", async () => {
    const { stub, calls } = makeLance({ connectThrows: true });
    const exit = await handleCompact(
      { lance: stub, lancePath: "/tmp/lance", lockProbe: blocking },
      () => 0,
      () => {},
      () => {},
    );
    expect(exit).toBe(1);
    expect(calls).not.toContain("connect");
    expect(calls).not.toContain("close");
  });

  test("closes lance after a successful compact (finally runs on the proceed path)", async () => {
    const { stub, calls } = makeLance();
    const exit = await handleCompact(
      { lance: stub, lancePath: "/tmp/lance", lockProbe: open },
      () => 1_000_000,
      () => {},
      () => {},
    );
    expect(exit).toBe(0);
    expect(calls).toContain("connect");
    expect(calls).toContain("close");
  });

  test("maintenance.ts no longer kills serve processes (kill-serve hack removed)", () => {
    expect(SRC).toContain("export async function handleCompact");
    expect(SRC).not.toContain("pgrep -f 'cbrain.*serve'");
    expect(SRC).not.toMatch(/kill\s+\$\{?pids/);
  });
});
