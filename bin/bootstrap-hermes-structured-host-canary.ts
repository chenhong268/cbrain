import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const ALLOWED_ENV = new Set([
  "HOME",
  "TMPDIR",
  "PATH",
  "LANG",
  "LC_ALL",
  "CBRAIN_CANARY_BOOT_ROOT",
  "CBRAIN_CANARY_SOURCE_ROOT",
  "CBRAIN_CANARY_HERMES_EXEC",
  "CBRAIN_CANARY_PARENT_MANAGED_DIR",
  "CBRAIN_CANARY_LIVE_HOME",
  "CBRAIN_CANARY_FAULT",
  "CBRAIN_CANARY_APPROVED_COMMIT",
]);
const LOCK_PATH = "/tmp/cbrain-hermes-structured-canary-v2.lock";
const EVIDENCE_RELATIVE = "tests/fixtures/hermes-structured-canary-evidence-manifest.json";

class BootstrapFatal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type BootstrapStage =
  | "ENV"
  | "LOCK"
  | "SNAPSHOT"
  | "WORKER"
  | "SNAPSHOT_CLEANUP"
  | "LOCK_RELEASE"
  | "RESULT_EMIT";
let bootstrapStage: BootstrapStage = "ENV";
type LockReleaseStage = "IDENTITY" | "TERM" | "TERM_WAIT" | "KILL" | "KILL_WAIT" | "PID_VERIFY" | "PROBE" | "DONE";
let lockReleaseStage: LockReleaseStage = "IDENTITY";
type WorkerStage = "PREPARE" | "SPAWN" | "IDENTITY" | "WAIT" | "STATUS" | "GROUP" | "OUTPUT" | "PARSE" | "DONE";
let workerStage: WorkerStage = "PREPARE";

function emitFatal(code: string): never {
  throw new BootstrapFatal(code);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) emitFatal("BOOTSTRAP_ENV_INCOMPLETE");
  return value;
}

function run(command: string[], cwd?: string): string {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) emitFatal("BOOTSTRAP_SNAPSHOT_FAILED");
  return result.stdout.toString();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function canonicalTreeDigest(rootPath: string, strict = false): {
  digest: string;
  file_count: number;
} {
  const root = resolve(rootPath);
  const entries: Array<{
    path: string;
    kind: "directory" | "file" | "symlink";
    mode: number;
    bytes: Uint8Array;
  }> = [];
  let fileCount = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (
        !strict &&
        (
        name === ".git" ||
        name === "__pycache__" ||
        name === ".DS_Store" ||
        name === ".env" ||
        name.startsWith(".env."))
      )
        continue;
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        entries.push({
          path: relative(root, path).split(sep).join("/"),
          kind: "directory",
          mode: stat.mode & 0o777,
          bytes: new Uint8Array(),
        });
        visit(path);
      } else if (stat.isSymbolicLink()) {
        fileCount += 1;
        entries.push({
          path: relative(root, path).split(sep).join("/"),
          kind: "symlink",
          mode: stat.mode & 0o777,
          bytes: new TextEncoder().encode(readlinkSync(path)),
        });
      } else if (stat.isFile() && (strict || !name.endsWith(".pyc"))) {
        fileCount += 1;
        entries.push({
          path: relative(root, path).split(sep).join("/"),
          kind: "file",
          mode: stat.mode & 0o777,
          bytes: readFileSync(path),
        });
      } else if (!stat.isFile()) {
        emitFatal("BOOTSTRAP_SPECIAL_FILE");
      }
    }
  };
  visit(root);
  const hash = createHash("sha256");
  for (const entry of entries) {
    const contentHash = createHash("sha256").update(entry.bytes).digest("hex");
    hash.update(`${entry.kind}\0${entry.path}\0${entry.mode.toString(8)}\0${entry.bytes.byteLength}\0${contentHash}\n`);
  }
  return { digest: hash.digest("hex"), file_count: fileCount };
}

function assertTreeSymlinksContained(rootPath: string): void {
  const root = realpathSync(rootPath);
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(resolve(directory, readlinkSync(path)));
        } catch {
          emitFatal("BOOTSTRAP_SYMLINK_UNVERIFIABLE");
        }
        const rel = relative(root, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) emitFatal("BOOTSTRAP_SYMLINK_ESCAPE");
      }
    }
  };
  visit(root);
}

function processStart(pid: number): string | null {
  const result = Bun.spawnSync({
    cmd: ["/bin/ps", "-p", String(pid), "-o", "lstart="],
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() || null : null;
}

function processGroupIsEmpty(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

interface LockLease {
  pid: number;
  started: string;
}

async function acquireLock(): Promise<LockLease> {
  const script = [
    "import fcntl, os, sys",
    "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
    "try:",
    "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except BlockingIOError:",
    "    print('LOCK_HELD', flush=True)",
    "    sys.exit(73)",
    "print('LOCK_ACQUIRED', flush=True)",
    "parent = int(sys.argv[2])",
    "import time",
    "while os.getppid() == parent:",
    "    time.sleep(0.1)",
  ].join("\n");
  const child = Bun.spawn({
    cmd: ["/usr/bin/python3", "-I", "-c", script, LOCK_PATH, String(process.pid)],
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const started = processStart(child.pid);
  if (!started) {
    child.kill("SIGKILL");
    emitFatal("CANARY_OWNER_UNVERIFIABLE");
  }
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lock handshake timeout")), 2_000)),
  ]);
  const handshake = first.value ? new TextDecoder().decode(first.value).trim() : "";
  if (handshake !== "LOCK_ACQUIRED") {
    await child.exited.catch(() => {});
    if (handshake === "LOCK_HELD") emitFatal("CANARY_LOCK_HELD");
    emitFatal("CANARY_LOCK_UNVERIFIABLE");
  }
  reader.releaseLock();
  child.unref();
  return { pid: child.pid, started };
}

async function releaseLock(lease: LockLease): Promise<void> {
  try {
    lockReleaseStage = "IDENTITY";
    if (processStart(lease.pid) !== lease.started) emitFatal("CANARY_LOCK_OWNERSHIP_DRIFT");
    lockReleaseStage = "TERM";
    const term = Bun.spawnSync({ cmd: ["/bin/kill", "-TERM", String(lease.pid)], stdout: "pipe", stderr: "pipe" });
    if (term.exitCode !== 0 && processStart(lease.pid) !== null) emitFatal("CANARY_LOCK_RELEASE_FAILED");
    lockReleaseStage = "TERM_WAIT";
    for (let attempt = 0; attempt < 40 && processStart(lease.pid) === lease.started; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    if (processStart(lease.pid) === lease.started) {
      lockReleaseStage = "KILL";
      Bun.spawnSync({ cmd: ["/bin/kill", "-KILL", String(lease.pid)], stdout: "pipe", stderr: "pipe" });
      lockReleaseStage = "KILL_WAIT";
      for (let attempt = 0; attempt < 40 && processStart(lease.pid) === lease.started; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    }
    lockReleaseStage = "PID_VERIFY";
    if (processStart(lease.pid) !== null) emitFatal("CANARY_LOCK_RELEASE_FAILED");
    lockReleaseStage = "PROBE";
    const probe = Bun.spawnSync({
      cmd: [
        "/usr/bin/python3",
        "-I",
        "-c",
        "import fcntl, os, sys; fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600); fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
        LOCK_PATH,
      ],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (probe.exitCode !== 0) emitFatal("CANARY_LOCK_RELEASE_FAILED");
    lockReleaseStage = "DONE";
  } catch (error) {
    if (error instanceof BootstrapFatal) throw error;
    emitFatal("CANARY_LOCK_RELEASE_FAILED");
  }
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

async function main(): Promise<number> {
  for (const key of Object.keys(process.env)) {
    if (!ALLOWED_ENV.has(key)) emitFatal("BOOTSTRAP_ENV_NOT_CLOSED");
  }
  if (process.env.CBRAIN_CANARY_FAULT === "bootstrap") emitFatal("INJECTED_BOOTSTRAP_FAULT");

  const bootRoot = required("CBRAIN_CANARY_BOOT_ROOT");
  const sourceRoot = resolve(required("CBRAIN_CANARY_SOURCE_ROOT"));
  const hermesExecutable = resolve(required("CBRAIN_CANARY_HERMES_EXEC"));
  if (!isAbsolute(bootRoot) || !isAbsolute(sourceRoot) || !isAbsolute(hermesExecutable))
    emitFatal("BOOTSTRAP_PATH_INVALID");
  if (readdirSync(sourceRoot).some((name) => name === ".env" || name.startsWith(".env."))) {
    emitFatal("BOOTSTRAP_SOURCE_ENV_PRESENT");
  }
  const managed = process.env.CBRAIN_CANARY_PARENT_MANAGED_DIR;
  for (const candidate of [managed, "/etc/hermes"].filter((value): value is string => Boolean(value))) {
    try {
      lstatSync(candidate);
      emitFatal("BOOTSTRAP_MANAGED_SCOPE_PRESENT");
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
  }

  bootstrapStage = "LOCK";
  const lockLease = await acquireLock();
  if (process.env.CBRAIN_CANARY_FAULT === "lock_hold") await new Promise<never>(() => {});
  const snapshotRoot = join(bootRoot, "cbrain-snapshot");
  const snapshotSource = join(snapshotRoot, "source");
  const snapshotBin = join(snapshotRoot, "bin");
  const workerCwd = join(bootRoot, "worker-cwd");
  let snapshotCreated = false;
  let finalOutput = "";
  let finalStatus = 2;
  let pendingError: unknown;
  let pendingErrorStage: BootstrapStage | null = null;
  try {
    bootstrapStage = "SNAPSHOT";
    if (run(["git", "status", "--porcelain", "--untracked-files=all"], sourceRoot).trim() !== "") {
      emitFatal("BOOTSTRAP_SOURCE_DIRTY");
    }
    const checkpoint = run(["git", "rev-parse", "HEAD"], sourceRoot).trim();
    if (!/^[a-f0-9]{40}$/.test(checkpoint)) emitFatal("BOOTSTRAP_CHECKPOINT_INVALID");
    const approvedCommit = required("CBRAIN_CANARY_APPROVED_COMMIT");
    if (!/^[a-f0-9]{40}$/.test(approvedCommit)) emitFatal("BOOTSTRAP_APPROVAL_INVALID");
    const ancestor = Bun.spawnSync({
      cmd: ["git", "merge-base", "--is-ancestor", approvedCommit, checkpoint],
      cwd: sourceRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (ancestor.exitCode !== 0) emitFatal("BOOTSTRAP_APPROVAL_INVALID");
    const postApprovalPaths = run(["git", "diff", "--name-only", approvedCommit, checkpoint], sourceRoot)
      .split("\n")
      .filter(Boolean);
    if (postApprovalPaths.some((path) => !path.startsWith("docs/"))) emitFatal("BOOTSTRAP_APPROVAL_DRIFT");
    const approvedManifest = run(["git", "show", `${approvedCommit}:${EVIDENCE_RELATIVE}`], sourceRoot);
    if (approvedManifest !== readFileSync(join(sourceRoot, EVIDENCE_RELATIVE), "utf8")) {
      emitFatal("BOOTSTRAP_APPROVAL_DRIFT");
    }
    const listing = run(["git", "ls-tree", "-r", "--full-tree", checkpoint], sourceRoot)
      .split("\n")
      .filter((line) => {
        if (!line) return false;
        const path = line.slice(line.indexOf("\t") + 1);
        return !path.startsWith("docs/") && path !== EVIDENCE_RELATIVE;
      });
    if (listing.length < 1) emitFatal("BOOTSTRAP_CHECKPOINT_EMPTY");
    const checkpointDigest = createHash("sha256")
      .update(`${listing.join("\n")}\n`)
      .digest("hex");
    const expectedEvidence = JSON.parse(readFileSync(join(sourceRoot, EVIDENCE_RELATIVE), "utf8")) as Record<
      string,
      unknown
    >;
    const nodeModules = canonicalTreeDigest(join(sourceRoot, "node_modules"));
    assertTreeSymlinksContained(join(sourceRoot, "node_modules"));
    const observedBootstrapEvidence = {
      checkpoint_tree_digest: checkpointDigest,
      checkpoint_blob_count: listing.length,
      bun_binary_digest: sha256(process.execPath),
      bun_version: Bun.version,
      node_modules_tree_digest: nodeModules.digest,
      node_modules_file_count: nodeModules.file_count,
      package_manifest_digest: sha256(join(sourceRoot, "package.json")),
      lockfile_digest: sha256(join(sourceRoot, "bun.lock")),
      hermes_runtime_manifest_digest: sha256(
        join(sourceRoot, "tests/fixtures/hermes-structured-host-runtime-manifest.json"),
      ),
      tokenizer_blob_digest: sha256(join(sourceRoot, "tests/fixtures/cl100k_base.tiktoken")),
    };
    const expectedBootstrapEvidence = Object.fromEntries(
      Object.keys(observedBootstrapEvidence).map((key) => [key, expectedEvidence[key]]),
    );
    if (canonicalJson(observedBootstrapEvidence) !== canonicalJson(expectedBootstrapEvidence)) {
      emitFatal("BOOTSTRAP_EVIDENCE_MISMATCH");
    }

    mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
    mkdirSync(snapshotBin, { recursive: true, mode: 0o700 });
    mkdirSync(workerCwd, { recursive: true, mode: 0o700 });
    run(["git", "clone", "--quiet", "--no-checkout", sourceRoot, snapshotSource]);
    run(["git", "checkout", "--quiet", checkpoint], snapshotSource);
    rmSync(join(snapshotSource, ".git"), { recursive: true, force: true });
    rmSync(join(snapshotSource, "docs"), { recursive: true, force: true });
    run(["/bin/cp", "-cRp", join(sourceRoot, "node_modules"), join(snapshotSource, "node_modules")]);
    const copiedBun = join(snapshotBin, "bun");
    copyFileSync(process.execPath, copiedBun);
    chmodSync(copiedBun, 0o755);
    const copiedNodeModules = canonicalTreeDigest(join(snapshotSource, "node_modules"));
    assertTreeSymlinksContained(snapshotRoot);
    if (
      canonicalJson(copiedNodeModules) !== canonicalJson(nodeModules) ||
      sha256(copiedBun) !== observedBootstrapEvidence.bun_binary_digest
    ) {
      emitFatal("BOOTSTRAP_COPY_DRIFT");
    }
    const resolutionProbe = JSON.parse(
      run(
        [
          copiedBun,
          "--no-env-file",
          "--config=/dev/null",
          "-e",
          'console.log(JSON.stringify([import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"), import.meta.resolve("./src/mcp/context.ts")]))',
        ],
        snapshotSource,
      ),
    ) as unknown;
    if (
      !Array.isArray(resolutionProbe) ||
      resolutionProbe.length !== 2 ||
      !resolutionProbe.every((value) => {
        if (typeof value !== "string" || !value.startsWith("file://")) return false;
        return value.includes(snapshotSource);
      })
    )
      emitFatal("BOOTSTRAP_IMPORT_ESCAPE");
    setTreeReadOnly(snapshotRoot);
    snapshotCreated = true;
    const executionNodeModules = canonicalTreeDigest(join(snapshotSource, "node_modules"));
    const executionSource = canonicalTreeDigest(snapshotSource, true);

    const liveModule = await import(join(snapshotSource, "bin/lib/hermes-canary-live-fingerprint.ts"));
    const preLiveFingerprint = liveModule.captureStableLiveServiceFingerprint(
      realpathSync(required("CBRAIN_CANARY_LIVE_HOME")),
    );

    bootstrapStage = "WORKER";
    workerStage = "PREPARE";
    const worker = join(snapshotSource, "bin", "check-hermes-structured-host-canary.ts");
    const workerExitStatus = join(bootRoot, "worker-exit-status");
    const workerOutput = join(bootRoot, "worker-output");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let childStarted: string | null = null;
    let pendingInterrupt: Error | null = null;
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => {
        pendingInterrupt ??= new Error("canary bootstrap interrupted");
        if (child && childStarted && processStart(child.pid) === childStarted) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            child.kill(signal);
          }
        }
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    workerStage = "SPAWN";
    child = Bun.spawn({
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
        CBRAIN_CANARY_SOURCE_NODE_MODULES_DIGEST: nodeModules.digest,
        CBRAIN_CANARY_SOURCE_NODE_MODULES_FILE_COUNT: String(nodeModules.file_count),
        CBRAIN_CANARY_EXECUTION_NODE_MODULES_DIGEST: executionNodeModules.digest,
        CBRAIN_CANARY_EXECUTION_NODE_MODULES_FILE_COUNT: String(executionNodeModules.file_count),
        CBRAIN_CANARY_EXECUTION_SOURCE_DIGEST: executionSource.digest,
        CBRAIN_CANARY_EXECUTION_SOURCE_FILE_COUNT: String(executionSource.file_count),
        CBRAIN_CANARY_FAULT: process.env.CBRAIN_CANARY_FAULT ?? "",
        CBRAIN_CANARY_LIVE_HOME: required("CBRAIN_CANARY_LIVE_HOME"),
        CBRAIN_CANARY_PRE_LIVE_FINGERPRINT: Buffer.from(JSON.stringify(preLiveFingerprint)).toString("base64"),
        HERMES_MANAGED_DIR: join(bootRoot, "missing-managed"),
      },
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    workerStage = "IDENTITY";
    childStarted = processStart(child.pid);
    if (!childStarted) emitFatal("CANARY_WORKER_IDENTITY_UNAVAILABLE");
    let exitCode: number;
    try {
      workerStage = "WAIT";
      const deadline = Date.now() + 600_000;
      while (!existsSync(workerExitStatus)) {
        if (pendingInterrupt) emitFatal("CANARY_WORKER_INTERRUPTED");
        if (Date.now() >= deadline) emitFatal("CANARY_WORKER_TIMEOUT");
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      workerStage = "STATUS";
      let exitStatus: string;
      try {
        exitStatus = readFileSync(workerExitStatus, "utf8").trim();
      } catch {
        emitFatal("CANARY_WORKER_STATUS_MISSING");
      }
      if (!/^[012]$/.test(exitStatus)) emitFatal("CANARY_WORKER_STATUS_INVALID");
      exitCode = Number(exitStatus);
      for (let attempt = 0; attempt < 40 && processStart(child.pid) === childStarted; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    } catch (error) {
      if (processStart(child.pid) === childStarted) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          Bun.spawnSync({ cmd: ["/bin/kill", "-TERM", String(child.pid)], stdout: "pipe", stderr: "pipe" });
        }
        for (let attempt = 0; attempt < 40 && processStart(child.pid) === childStarted; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
      }
      if (processStart(child.pid) === childStarted) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          Bun.spawnSync({ cmd: ["/bin/kill", "-KILL", String(child.pid)], stdout: "pipe", stderr: "pipe" });
        }
        for (let attempt = 0; attempt < 40 && processStart(child.pid) === childStarted; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
      }
      throw error;
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
    workerStage = "GROUP";
    if (!processGroupIsEmpty(child.pid)) emitFatal("CANARY_WORKER_GROUP_REMAINED");
    workerStage = "OUTPUT";
    let stdout: string;
    try {
      stdout = readFileSync(workerOutput, "utf8").trim();
    } catch {
      emitFatal("CANARY_WORKER_OUTPUT_MISSING");
    }
    if (stdout.length > 2_000_000 || /(?:\/Users\/|\/home\/|[A-Za-z]:\\|Bearer\s+|api[_-]?key\s*[:=])/i.test(stdout)) {
      emitFatal("CANARY_OUTPUT_REJECTED");
    }
    workerStage = "PARSE";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      emitFatal("CANARY_OUTPUT_INVALID");
    }
    const keys = Object.keys(parsed).sort();
    const completeKeys = ["case_metrics", "report", "runtime", "schema_version", "size_pairs", "status"].sort();
    const fatalKeys = ["code", "schema_version", "status"].sort();
    const validKeys = keys.join("\0") === completeKeys.join("\0") || keys.join("\0") === fatalKeys.join("\0");
    if (!validKeys || ![0, 1, 2].includes(exitCode)) emitFatal("CANARY_OUTPUT_INVALID");
    finalOutput = stdout;
    finalStatus = exitCode;
    workerStage = "DONE";
  } catch (error) {
    pendingError = error;
    pendingErrorStage = bootstrapStage;
  } finally {
    let snapshotCleanupFailed = false;
    bootstrapStage = "SNAPSHOT_CLEANUP";
    try {
      if (snapshotCreated) {
        setTreeWritable(snapshotRoot);
        rmSync(snapshotRoot, { recursive: true, force: true });
      }
    } catch {
      snapshotCleanupFailed = true;
    }
    bootstrapStage = "LOCK_RELEASE";
    await releaseLock(lockLease);
    if (snapshotCleanupFailed) emitFatal("CANARY_SNAPSHOT_CLEANUP_FAILED");
  }
  if (pendingErrorStage !== null) {
    bootstrapStage = pendingErrorStage;
    throw pendingError;
  }
  bootstrapStage = "RESULT_EMIT";
  process.stdout.write(`${finalOutput}\n`);
  return finalStatus;
}

try {
  process.exitCode = await main();
} catch (error) {
  const code =
    error instanceof BootstrapFatal
      ? error.code
      : bootstrapStage === "LOCK_RELEASE"
        ? `CANARY_LOCK_RELEASE_${lockReleaseStage}_FAILED`
        : bootstrapStage === "WORKER"
          ? `CANARY_WORKER_${workerStage}_FAILED`
        : `CANARY_BOOTSTRAP_${bootstrapStage}_FATAL`;
  process.stdout.write(`${JSON.stringify({ schema_version: 1, status: "fatal", code })}\n`);
  process.exitCode = 2;
}
