import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface LiveProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  started: string;
  command: string;
}

export interface LiveServiceFingerprint {
  algorithm: "sha256-live-service-state-v2";
  relevant_process_count: number;
  launchd_job_count: number;
  artifact_count: number;
  digest: string;
}

export interface LiveLaunchdIdentity {
  label_digest: string;
  pid: number | null;
  last_exit_status: number | null;
}

export interface LiveArtifactIdentity {
  path_digest: string;
  content_digest: string;
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function isRelevantLiveProcess(command: string): boolean {
  return (
    /(?:^|\s)(?:\S*\/)?hermes(?:\s|$)/i.test(command) ||
    /\s-m\s+hermes_cli\.main(?:\s|$)/i.test(command) ||
    /\/src\/cli\/index\.(?:ts|js)\s+serve(?:\s|$)/i.test(command) ||
    /(?:^|\s)(?:\S*\/)?cbrain\s+serve(?:\s|$)/i.test(command)
  );
}

export function buildLiveServiceFingerprint(
  processes: readonly LiveProcessIdentity[],
  jobs: readonly LiveLaunchdIdentity[] = [],
  artifacts: readonly LiveArtifactIdentity[] = [],
): LiveServiceFingerprint {
  const relevant = processes
    .filter((process) => isRelevantLiveProcess(process.command))
    .map((process) => {
      if (![process.pid, process.ppid, process.pgid].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("invalid live process identity");
      }
      return {
        pid: process.pid,
        ppid: process.ppid,
        pgid: process.pgid,
        started: process.started,
        command_digest: createHash("sha256").update(process.command).digest("hex"),
      };
    })
    .sort((a, b) => a.pid - b.pid || a.command_digest.localeCompare(b.command_digest));
  const normalizedJobs = [...jobs].sort((left, right) => left.label_digest.localeCompare(right.label_digest));
  const normalizedArtifacts = [...artifacts].sort((left, right) => left.path_digest.localeCompare(right.path_digest));
  return {
    algorithm: "sha256-live-service-state-v2",
    relevant_process_count: relevant.length,
    launchd_job_count: normalizedJobs.length,
    artifact_count: normalizedArtifacts.length,
    digest: createHash("sha256")
      .update(
        canonicalJson({
          relevant,
          jobs: normalizedJobs,
          artifacts: normalizedArtifacts,
        }),
      )
      .digest("hex"),
  };
}

function readLiveProcesses(): LiveProcessIdentity[] {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/);
    if (!match) return [];
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        started: match[4],
        command: match[5],
      },
    ];
  });
}

function readLiveLaunchdJobs(processes: readonly LiveProcessIdentity[]): {
  identities: LiveLaunchdIdentity[];
  labels: string[];
} {
  const output = execFileSync("/bin/launchctl", ["list"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const relevantPids = new Set(processes.filter((item) => isRelevantLiveProcess(item.command)).map((item) => item.pid));
  const labels: string[] = [];
  const identities = output.split("\n").flatMap((line) => {
    const match = line.match(/^(\d+|-)\s+(-?\d+|-)\s+(.+)$/);
    const pid = match?.[1] === "-" ? null : Number(match?.[1]);
    if (!match || (!/(?:cbrain|hermes)/i.test(match[3]) && (pid === null || !relevantPids.has(pid)))) return [];
    labels.push(match[3]);
    return [
      {
        label_digest: createHash("sha256").update(match[3]).digest("hex"),
        pid,
        last_exit_status: match[2] === "-" ? null : Number(match[2]),
      },
    ];
  });
  return { identities, labels };
}

function liveArtifact(path: string): LiveArtifactIdentity {
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("live artifact is not a file");
  const content = stat.isSymbolicLink()
    ? Buffer.concat([Buffer.from(`symlink\0${readlinkSync(path)}\0`), readFileSync(realpathSync(path))])
    : readFileSync(path);
  return {
    path_digest: createHash("sha256").update(path).digest("hex"),
    content_digest: createHash("sha256").update(content).digest("hex"),
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode & 0o777,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
  };
}

export function extractLiveCommandFileCandidates(
  command: string,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const candidates = new Set<string>();
  for (const match of command.matchAll(/(?:^|\s)(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    const optionPath = token.match(/^--(?:config|env-file|dotenv)=(\/.*)$/)?.[1];
    const path = optionPath ?? token;
    if (path.startsWith("/") && exists(path)) candidates.add(path);
  }
  return [...candidates];
}

function readLiveArtifacts(
  processes: readonly LiveProcessIdentity[],
  home: string,
  launchdLabels: readonly string[],
): LiveArtifactIdentity[] {
  if (!isAbsolute(home) || !statSync(home).isDirectory()) throw new Error("live home is invalid");
  const candidates = new Set<string>();
  for (const path of [resolve(home, ".hermes", "config.yaml"), resolve(home, ".hermes", ".env")]) {
    if (existsSync(path)) candidates.add(path);
  }
  const launchdDirectories = [
    resolve(home, "Library", "LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
    "/System/Library/LaunchAgents",
    "/System/Library/LaunchDaemons",
  ];
  for (const directory of [resolve(home, ".hermes", "config"), ...launchdDirectories]) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (name === "__pycache__" || name.endsWith(".pyc")) continue;
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      const launchdDirectory = launchdDirectories.includes(directory);
      const matchesLaunchd =
        /(?:cbrain|hermes)/i.test(name) || launchdLabels.some((label) => name === `${label}.plist`);
      if (stat.isFile() && (!launchdDirectory || matchesLaunchd)) candidates.add(path);
    }
  }
  for (const process of processes.filter((item) => isRelevantLiveProcess(item.command))) {
    for (const token of extractLiveCommandFileCandidates(process.command)) {
      const stat = lstatSync(token);
      if (stat.isFile() || stat.isSymbolicLink()) {
        candidates.add(token);
        let directory = dirname(realpathSync(token));
        for (let depth = 0; depth < 6; depth += 1) {
          const envPath = resolve(directory, ".env");
          if (existsSync(envPath) && lstatSync(envPath).isFile()) candidates.add(envPath);
          const parent = dirname(directory);
          if (parent === directory) break;
          directory = parent;
        }
      }
    }
  }
  for (const candidate of [...candidates]) {
    const stat = lstatSync(candidate);
    const basename = candidate.slice(candidate.lastIndexOf("/") + 1);
    const configLike =
      candidate.endsWith(".plist") ||
      candidate.endsWith(".yaml") ||
      candidate.endsWith(".yml") ||
      candidate.endsWith(".json") ||
      basename === ".env" ||
      basename.startsWith(".env.");
    if (!configLike || !stat.isFile() || stat.size > 1024 * 1024) continue;
    const referencedPaths = new Set<string>();
    if (candidate.endsWith(".plist")) {
      const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", candidate], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      const plist = JSON.parse(json) as Record<string, unknown>;
      const argumentsList = Array.isArray(plist.ProgramArguments)
        ? plist.ProgramArguments.filter((value): value is string => typeof value === "string")
        : [];
      if (typeof plist.Program === "string") argumentsList.unshift(plist.Program);
      for (const argument of argumentsList) {
        const optionPath = argument.match(/^--(?:config|env-file|dotenv)=(\/.*)$/)?.[1];
        const referenced = optionPath ?? argument;
        if (referenced.startsWith("/")) referencedPaths.add(referenced);
      }
      const environment = plist.EnvironmentVariables;
      if (environment && typeof environment === "object" && !Array.isArray(environment)) {
        for (const [key, value] of Object.entries(environment)) {
          if (/(?:CONFIG|ENV|MANAGED|HOME)$/i.test(key) && typeof value === "string" && value.startsWith("/")) {
            referencedPaths.add(value);
          }
        }
      }
    }
    for (const referenced of referencedPaths) {
      if (existsSync(referenced)) {
        const referencedStat = lstatSync(referenced);
        if (referencedStat.isFile() || referencedStat.isSymbolicLink()) candidates.add(referenced);
      }
    }
  }
  return [...candidates].sort().map(liveArtifact);
}

function readCompleteLiveFingerprint(liveHome: string): LiveServiceFingerprint {
  const processes = readLiveProcesses();
  const launchd = readLiveLaunchdJobs(processes);
  return buildLiveServiceFingerprint(
    processes,
    launchd.identities,
    readLiveArtifacts(processes, liveHome, launchd.labels),
  );
}

export function captureStableLiveServiceFingerprint(liveHome: string): LiveServiceFingerprint {
  const first = readCompleteLiveFingerprint(liveHome);
  const second = readCompleteLiveFingerprint(liveHome);
  if (canonicalJson(first) !== canonicalJson(second)) throw new Error("live service inventory was not stable");
  return first;
}
