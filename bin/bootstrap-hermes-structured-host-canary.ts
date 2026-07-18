import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const ALLOWED_ENV = new Set([
  "HOME", "TMPDIR", "PATH", "LANG", "LC_ALL",
  "CBRAIN_CANARY_BOOT_ROOT", "CBRAIN_CANARY_SOURCE_ROOT",
  "CBRAIN_CANARY_HERMES_EXEC", "CBRAIN_CANARY_PARENT_MANAGED_DIR",
  "CBRAIN_CANARY_FAULT",
]);
const LOCK_PATH = "/tmp/cbrain-hermes-structured-canary.lock";

function emitFatal(code: string): never {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, status: "fatal", code })}\n`);
  process.exit(2);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) emitFatal("BOOTSTRAP_ENV_INCOMPLETE");
  return value;
}

function run(command: string[], cwd?: string): string {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) emitFatal("BOOTSTRAP_SNAPSHOT_FAILED");
  return result.stdout.toString();
}

function processStart(pid: number): string | null {
  const result = Bun.spawnSync({
    cmd: ["/bin/ps", "-p", String(pid), "-o", "lstart="],
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

function acquireLock(): void {
  try {
    mkdirSync(LOCK_PATH, { mode: 0o700 });
  } catch {
    try {
      const owner = JSON.parse(readFileSync(join(LOCK_PATH, "owner.json"), "utf8")) as { pid?: unknown; started?: unknown };
      const pid = Number(owner.pid);
      if (Number.isSafeInteger(pid) && pid > 0 && typeof owner.started === "string" && processStart(pid) === owner.started) {
        emitFatal("CANARY_LOCK_HELD");
      }
      rmSync(LOCK_PATH, { recursive: true, force: true });
      mkdirSync(LOCK_PATH, { mode: 0o700 });
    } catch {
      emitFatal("CANARY_LOCK_UNVERIFIABLE");
    }
  }
  const started = processStart(process.pid);
  if (!started) emitFatal("CANARY_OWNER_UNVERIFIABLE");
  const ownerPath = join(LOCK_PATH, "owner.json");
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, started }));
  chmodSync(ownerPath, 0o600);
}

function setTreeReadOnly(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) setTreeReadOnly(resolve(path, name));
    chmodSync(path, 0o555);
  } else if (stat.isFile()) {
    chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
  } else {
    emitFatal("BOOTSTRAP_SPECIAL_FILE");
  }
}

function setTreeWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) setTreeWritable(resolve(path, name));
  } else if (stat.isFile()) {
    chmodSync(path, 0o600);
  }
}

for (const key of Object.keys(process.env)) {
  if (!ALLOWED_ENV.has(key)) emitFatal("BOOTSTRAP_ENV_NOT_CLOSED");
}
if (process.env.CBRAIN_CANARY_FAULT === "bootstrap") emitFatal("INJECTED_BOOTSTRAP_FAULT");

const bootRoot = required("CBRAIN_CANARY_BOOT_ROOT");
const sourceRoot = resolve(required("CBRAIN_CANARY_SOURCE_ROOT"));
const hermesExecutable = resolve(required("CBRAIN_CANARY_HERMES_EXEC"));
if (!isAbsolute(bootRoot) || !isAbsolute(sourceRoot) || !isAbsolute(hermesExecutable)) emitFatal("BOOTSTRAP_PATH_INVALID");
const managed = process.env.CBRAIN_CANARY_PARENT_MANAGED_DIR;
if (managed) {
  try {
    lstatSync(managed);
    emitFatal("BOOTSTRAP_MANAGED_SCOPE_PRESENT");
  } catch (error) {
    if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
  }
}

acquireLock();
const snapshotRoot = join(bootRoot, "cbrain-snapshot");
const snapshotSource = join(snapshotRoot, "source");
const snapshotBin = join(snapshotRoot, "bin");
const workerCwd = join(bootRoot, "worker-cwd");
let snapshotCreated = false;
try {
  if (run(["git", "status", "--porcelain", "--untracked-files=all"], sourceRoot).trim() !== "") {
    emitFatal("BOOTSTRAP_SOURCE_DIRTY");
  }
  const checkpoint = run(["git", "rev-parse", "HEAD"], sourceRoot).trim();
  if (!/^[a-f0-9]{40}$/.test(checkpoint)) emitFatal("BOOTSTRAP_CHECKPOINT_INVALID");
  const listing = run(["git", "ls-tree", "-r", "--full-tree", checkpoint], sourceRoot)
    .split("\n")
    .filter((line) => line && !line.slice(line.indexOf("\t") + 1).startsWith("docs/"));
  if (listing.length < 1) emitFatal("BOOTSTRAP_CHECKPOINT_EMPTY");
  const checkpointDigest = createHash("sha256").update(`${listing.join("\n")}\n`).digest("hex");

  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  mkdirSync(snapshotBin, { recursive: true, mode: 0o700 });
  mkdirSync(workerCwd, { recursive: true, mode: 0o700 });
  run(["git", "clone", "--quiet", "--no-checkout", sourceRoot, snapshotSource]);
  run(["git", "checkout", "--quiet", checkpoint], snapshotSource);
  rmSync(join(snapshotSource, ".git"), { recursive: true, force: true });
  rmSync(join(snapshotSource, "docs"), { recursive: true, force: true });
  run(["/bin/cp", "-cR", join(sourceRoot, "node_modules"), join(snapshotSource, "node_modules")]);
  const copiedBun = join(snapshotBin, "bun");
  copyFileSync(process.execPath, copiedBun);
  chmodSync(copiedBun, 0o755);
  setTreeReadOnly(snapshotRoot);
  snapshotCreated = true;

  const worker = join(snapshotSource, "bin", "check-hermes-structured-host-canary.ts");
  const result = Bun.spawnSync({
    cmd: [copiedBun, "--no-env-file", "--config=/dev/null", `--cwd=${workerCwd}`, worker],
    cwd: workerCwd,
    env: {
      HOME: required("HOME"),
      TMPDIR: required("TMPDIR"),
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CBRAIN_CANARY_SNAPSHOT_ROOT: snapshotRoot,
      CBRAIN_CANARY_ORIGINAL_HERMES: hermesExecutable,
      CBRAIN_CANARY_CHECKPOINT_DIGEST: checkpointDigest,
      CBRAIN_CANARY_CHECKPOINT_BLOB_COUNT: String(listing.length),
      CBRAIN_CANARY_FAULT: process.env.CBRAIN_CANARY_FAULT ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  const stdout = result.stdout.toString().trim();
  if (stdout.length > 2_000_000 || /(?:\/Users\/|\/home\/|[A-Za-z]:\\|Bearer\s+|api[_-]?key\s*[:=])/i.test(stdout)) {
    emitFatal("CANARY_OUTPUT_REJECTED");
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(stdout) as Record<string, unknown>; } catch { emitFatal("CANARY_OUTPUT_INVALID"); }
  const keys = Object.keys(parsed).sort();
  const completeKeys = ["case_metrics", "report", "runtime", "schema_version", "size_pairs", "status"].sort();
  const fatalKeys = ["code", "schema_version", "status"].sort();
  const validKeys = keys.join("\0") === completeKeys.join("\0") || keys.join("\0") === fatalKeys.join("\0");
  if (!validKeys || ![0, 1, 2].includes(result.exitCode)) emitFatal("CANARY_OUTPUT_INVALID");
  process.stdout.write(`${stdout}\n`);
  process.exitCode = result.exitCode;
} finally {
  if (snapshotCreated) {
    setTreeWritable(snapshotRoot);
    rmSync(snapshotRoot, { recursive: true, force: true });
  }
  rmSync(LOCK_PATH, { recursive: true, force: true });
}
