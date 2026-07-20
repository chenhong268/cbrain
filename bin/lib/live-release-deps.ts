/**
 * Real LiveReleaseDeps — wires the pure verifier core to macOS launchd / lsof /
 * libproc / HTTP / skill-pack. Read-only by construction: every operation is a
 * read (launchctl print/list, lsof, libproc proc_pidinfo, HTTP GET, readFileSync,
 * skill-pack compareTarget). No writes, no spawns of mutating commands.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { compareTarget } from "../../src/cli/commands/skill-pack.js";
import type {
  HealthFailure,
  HealthResult,
  LiveReleaseDeps,
  ProcessIdentity,
  ReadManifest,
  ReadManifestFailure,
  ReadVersion,
  ReadVersionFailure,
  ServiceEvidence,
  TargetResult,
  WriterProcess,
} from "./live-release-verify.js";

function sh(cmd: string, args: readonly string[]): string {
  return execFileSync(cmd, args as string[], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

/** libproc birth identity (start_sec*1e6+start_usec), or null if the PID is gone. */
function processStartUsec(pid: number): string | null {
  const script = [
    "import ctypes, sys",
    "class B(ctypes.Structure):",
    "    _fields_ = [('flags', ctypes.c_uint32), ('status', ctypes.c_uint32), ('xstatus', ctypes.c_uint32), ('pid', ctypes.c_uint32), ('ppid', ctypes.c_uint32), ('uid', ctypes.c_uint32), ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32), ('rgid', ctypes.c_uint32), ('svuid', ctypes.c_uint32), ('svgid', ctypes.c_uint32), ('rfu', ctypes.c_uint32), ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32), ('nfiles', ctypes.c_uint32), ('pgid', ctypes.c_uint32), ('pjobc', ctypes.c_uint32), ('tdev', ctypes.c_uint32), ('tpgid', ctypes.c_uint32), ('nice', ctypes.c_int32), ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]",
    "b = B()",
    "lib = ctypes.CDLL('/usr/lib/libproc.dylib')",
    "n = lib.proc_pidinfo(int(sys.argv[1]), 3, 0, ctypes.byref(b), ctypes.sizeof(b))",
    "if n != ctypes.sizeof(b):",
    "    sys.exit(1)",
    "print(f'{b.start_sec * 1000000 + b.start_usec}')",
  ].join("\n");
  try {
    const out = execFileSync("/usr/bin/python3", ["-I", "-c", script, String(pid)], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const value = out.trim();
    return /^\d+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function malformedEvidence(label: string): ServiceEvidence {
  return { label, pid: 0, program: "", programArguments: [], workingDirectory: "", lastExitStatus: null };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

export function buildRealDeps(ownVerifierPath: string): LiveReleaseDeps {
  return {
    ownVerifierPath,
    listCbrainServiceOwners(): readonly string[] {
      let out: string;
      try {
        out = sh("/bin/launchctl", ["list"]);
      } catch {
        return [];
      }
      return out.split("\n").flatMap((line) => {
        const match = line.match(/^(?:\d+|-)\s+(?:-?\d+|-)\s+(.+)$/);
        return match && /cbrain/i.test(match[1]) && /serve/i.test(match[1]) ? [match[1].trim()] : [];
      });
    },
    readServiceEvidence(label: string): ServiceEvidence {
      const uid = process.getuid?.() ?? 501;
      let out: string;
      try {
        out = sh("/bin/launchctl", ["print", `gui/${uid}/${label}`]);
      } catch {
        return malformedEvidence(label);
      }
      const program = out.match(/^\tprogram = (.+)$/m)?.[1] ?? "";
      const workingDirectoryRaw = out.match(/^\tworking directory = (.+)$/m)?.[1] ?? "";
      const pid = Number(out.match(/^\tpid = (\d+)$/m)?.[1] ?? "0");
      const lastExitRaw = out.match(/^\tlast exit code = (.+)$/m)?.[1] ?? "";
      const lastExitStatus = /never exited/i.test(lastExitRaw) ? null : Number(lastExitRaw) || null;
      const argsBlock = out.match(/^\targuments = \{\n([\s\S]*?)^\t\}/m)?.[1] ?? "";
      const programArguments = argsBlock
        .split("\n")
        .map((line) => line.replace(/^\t+/, ""))
        .filter((line) => line.length > 0);
      return {
        label,
        pid,
        program,
        programArguments,
        workingDirectory: workingDirectoryRaw.length > 0 ? safeRealpath(workingDirectoryRaw) : "",
        lastExitStatus,
      };
    },
    readProcessIdentity(pid: number): ProcessIdentity | null {
      const startUsec = processStartUsec(pid);
      return startUsec === null ? null : { pid, startUsec };
    },
    readProcessCwd(pid: number): string | null {
      let out: string;
      try {
        out = sh("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      } catch {
        return null;
      }
      const name = out.split("\n").find((line) => line.startsWith("n"))?.slice(1);
      if (!name) return null;
      const resolved = safeRealpath(name);
      return resolved.length > 0 ? resolved : null;
    },
    readListenerOwner(port: number): { pid: number; count: number } {
      let out: string;
      try {
        out = sh("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
      } catch {
        return { pid: 0, count: 0 };
      }
      const pids = out
        .split("\n")
        .slice(1)
        .map((line) => line.split(/\s+/)[1])
        .filter((p): p is string => /^\d+$/.test(p))
        .map(Number);
      return { pid: pids[0] ?? 0, count: pids.length };
    },
    listWriterProcesses(): readonly WriterProcess[] {
      let out: string;
      try {
        out = sh("/bin/ps", ["-axo", "pid=,command="]);
      } catch {
        return [];
      }
      return out.split("\n").flatMap((line) => {
        const m = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!m) return [];
        const command = m[2];
        if (!/cbrain/i.test(command) || !/(?:^|\s)serve(?:\s|$)/i.test(command)) return [];
        return [{ pid: Number(m[1]) }];
      });
    },
    resolveEntrypoint(programArguments, workingDirectory): string | null {
      for (const token of programArguments) {
        if (!/cli\/index\.(ts|js)$/i.test(token)) continue;
        const resolved = resolve(workingDirectory, token);
        try {
          const real = realpathSync(resolved);
          if (real.startsWith(`${workingDirectory}/`)) return real;
        } catch {
          // entrypoint not found / unreadable → keep scanning
        }
      }
      return null;
    },
    readCallerCwd(): string {
      const resolved = safeRealpath(process.cwd());
      return resolved.length > 0 ? resolved : process.cwd();
    },
    fetchHealthVersion(url: string, timeoutMs: number): HealthResult | HealthFailure {
      let raw = "";
      let status = "";
      try {
        const out = sh("/usr/bin/curl", [
          "-sS",
          "--max-time",
          String(Math.max(1, Math.ceil(timeoutMs / 1000))),
          "-o",
          "-",
          "-w",
          "\n%{http_code}",
          url,
        ]);
        const lines = out.split("\n");
        status = (lines.pop() ?? "").trim();
        raw = lines.join("\n");
      } catch {
        return { ok: false, code: "HTTP_UNAVAILABLE" };
      }
      if (!/^2\d\d$/.test(status)) return { ok: false, code: "HTTP_UNAVAILABLE" };
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return { ok: false, code: "HTTP_RESPONSE_INVALID" };
      }
      const version = (data as { version?: unknown })?.version;
      if (typeof version !== "string" || version.length === 0) {
        return { ok: false, code: "HTTP_RESPONSE_INVALID" };
      }
      return { ok: true, version };
    },
    readPackageVersion(root: string): ReadVersion | ReadVersionFailure {
      try {
        const data = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { version?: unknown };
        const version = data?.version;
        if (typeof version !== "string" || version.length === 0) return { ok: false };
        return { ok: true, version };
      } catch {
        return { ok: false };
      }
    },
    readManifestVersion(root: string): ReadManifest | ReadManifestFailure {
      try {
        const data = JSON.parse(readFileSync(`${root}/skills/MANIFEST.json`, "utf8")) as {
          packVersion?: unknown;
          files?: unknown;
        };
        const version = data?.packVersion;
        const files = data?.files;
        if (typeof version !== "string" || version.length === 0) return { ok: false };
        if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) return { ok: false };
        return { ok: true, version, files: files as readonly string[] };
      } catch {
        return { ok: false };
      }
    },
    verifySkillTarget(rootSkillsDir: string, targetDir: string): TargetResult {
      try {
        const comparison = compareTarget(rootSkillsDir, targetDir);
        return { path: targetDir, status: comparison.status };
      } catch {
        return { path: targetDir, status: "unverified" };
      }
    },
  };
}
