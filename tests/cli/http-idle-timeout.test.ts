import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard: Bun.serve's default idleTimeout (10s) kills long sync /
// large-file ingest requests (re-indexing = embedding + NER + LanceDB writes)
// → Hermes MCP client gets RemoteDisconnected → judged "unavailable". The
// HTTP-MCP server MUST disable it. Bun caps a positive idleTimeout at 255s —
// still too short for big batches — so the disable sentinel (0) is required.
describe("HTTP MCP server idle timeout", () => {
  test("createHttpServer disables Bun.serve idleTimeout so long requests survive", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/http/server.ts"), "utf-8");
    // The Bun.serve call must set idleTimeout: 0 (disable).
    expect(source).toMatch(/Bun\.serve\(\{[\s\S]*?idleTimeout:\s*0/);
    // No positive idleTimeout anywhere (a positive value would re-apply a
    // ceiling that long reindex jobs can still blow past).
    expect(source).not.toMatch(/idleTimeout:\s*[1-9]/);
  });
});
