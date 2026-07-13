import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { runRecallOutputBoundaryCanary } from "../../bin/check-recall-output-boundary-canary.js";

test("isolated HTTP canary validates all three structured recall/query tools", async () => {
  const result = await runRecallOutputBoundaryCanary();

  expect(result.ok).toBe(true);
  expect(result.calls).toBe(3);
  expect(result.directSchemasAdvertised).toBe(2);
  expect(result.defaultAuditCount).toBe(0);
  expect(result.temporaryStateRemoved).toBe(true);
  expect(result.outputModeRestored).toBe(true);
});

test("isolated HTTP canary removes temporary state when startup fails", async () => {
  for (const failAt of ["after-root", "after-lance", "after-env", "after-server"] as const) {
    const originalMode = process.env.CBRAIN_OUTPUT_BOUNDARY;
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("cbrain-recall-canary-")));
    await expect(runRecallOutputBoundaryCanary({ failAt })).rejects.toThrow("injected canary startup failure");
    const after = readdirSync(tmpdir()).filter(
      (name) => name.startsWith("cbrain-recall-canary-") && !before.has(name),
    );
    expect(after).toEqual([]);
    expect(process.env.CBRAIN_OUTPUT_BOUNDARY).toBe(originalMode);
  }
});
