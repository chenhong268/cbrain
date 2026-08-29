import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/ops/verify-cbrain-http-mcp-migration.sh");

type PsMode = "harmless-label" | "second-writer";

function runVerifier(psMode: PsMode) {
  const root = mkdtempSync(join(tmpdir(), "cbrain-migration-verifier-"));
  const fakeBin = join(root, "bin");
  const config = join(root, "config.yaml");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(config, "mcp_servers: {}\n");

  const command = (name: string, body: string) => {
    const path = join(fakeBin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };

  command("launchctl", `
case "$1" in
  list) printf '%s\\n' '101 0 ai.cbrain.serve' ;;
esac`);
  command("lsof", "printf '%s\\n' 'cbrain 101 user 3u IPv4 0t0 TCP 127.0.0.1:3399 (LISTEN)'");
  command("curl", `
case " $* " in
  *" -D /tmp/cbrain-v-h "*) printf '%s\\n' 'mcp-session-id: anonymous-session' > /tmp/cbrain-v-h ;;
esac
printf '200'`);
  command("python3", `
case "$*" in
  *"get('command')"*) printf '\\n' ;;
  *"get('url')"*) printf '%s\\n' 'http://127.0.0.1:3399/mcp' ;;
  *"get('cbrain')"*) printf '%s\\n' 'no' ;;
esac`);
  command("ps", `
case "$FAKE_PS_MODE" in
  harmless-label)
    printf '%s\\n' '101 1 /anonymous/bin/bun run --smol /anonymous/cbrain/repo/src/cli/index.ts serve --http --port 3399'
    printf '%s\\n' '202 101 /bin/bash -c sleep\\ 3\\;\\ true ai.cbrain.serve'
    ;;
  second-writer)
    printf '%s\\n' '101 1 /anonymous/bin/bun run --smol /anonymous/cbrain/repo/src/cli/index.ts serve --http --port 3399'
    printf '%s\\n' '202 1 /anonymous/bin/bun run --smol /anonymous/cbrain/other/src/cli/index.ts serve --http --port 3400'
    ;;
esac`);

  try {
    return Bun.spawnSync({
      cmd: ["/bin/bash", SCRIPT],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        CBRAIN_REQUIRED_MCP_CONFIGS: config,
        CBRAIN_OPTIONAL_MCP_CONFIGS: "",
        FAKE_PS_MODE: psMode,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("HTTP MCP migration verifier — writer inventory", () => {
  test("ignores a harmless shell command whose label mentions cbrain serve", () => {
    const result = runVerifier("harmless-label");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("=== SUMMARY: 11 passed, 0 failed ===");
  });

  test("rejects a second real HTTP writer without exposing its command or path", () => {
    const result = runVerifier("second-writer");
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(1);
    expect(output).toContain("cbrain serve processes=2");
    expect(output).toContain("PID=101 PPID=1 type=cbrain-cli-http");
    expect(output).toContain("PID=202 PPID=1 type=cbrain-cli-http");
    expect(output).not.toContain("/anonymous/");
  });
});
