#!/usr/bin/python3
"""Private macOS supervisor for the isolated Hermes structured canary."""

import ctypes
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import selectors
import signal
import stat
import subprocess
import sys
import time


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32),
        ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32),
        ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32),
        ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32),
        ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64),
        ("start_usec", ctypes.c_uint64),
    ]


LIBPROC = ctypes.CDLL("/usr/lib/libproc.dylib")
SUPERVISOR_LOCK_PATH = "/tmp/cbrain-hermes-structured-canary-supervisor-v1.lock"
SUPERVISOR_TIMEOUT_SECONDS = 900.0
TEST_SUPERVISOR_TIMEOUT_SECONDS = 0.25
STDOUT_LIMIT_BYTES = 2_000_000
STDERR_LIMIT_BYTES = 1_000_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SENSITIVE_OUTPUT = re.compile(
    r"(?:/Users/|/home/|/private/|/tmp/|[A-Za-z]:\\|Bearer\s+|api[_-]?key\s*[:=]|-----BEGIN|eyJ[a-zA-Z0-9_-]{8,}\.)",
    re.IGNORECASE,
)


def identity(pid: int):
    info = ProcBsdInfo()
    size = LIBPROC.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size != ctypes.sizeof(info):
        return None
    return (info.pid, info.ppid, info.pgid, info.start_sec * 1_000_000 + info.start_usec)


def identity_text(value) -> str:
    return ":".join(str(part) for part in value)


def scan_registrations(registry: str, token: str, registered: dict) -> bool:
    for name in os.listdir(registry):
        if name.startswith("ack.") or (name.startswith(".request.") and name.endswith(".tmp")):
            continue
        match = re.fullmatch(r"request\.([1-9][0-9]*)\.([1-9][0-9]*)", name)
        if match is None:
            return False
        path = os.path.join(registry, name)
        try:
            request_fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                request_stat = os.fstat(request_fd)
                if (
                    not stat.S_ISREG(request_stat.st_mode)
                    or request_stat.st_uid != os.getuid()
                    or request_stat.st_nlink != 1
                    or not 1 <= request_stat.st_size <= 512
                ):
                    return False
                raw = os.read(request_fd, 513)
                if len(raw) != request_stat.st_size:
                    return False
            finally:
                os.close(request_fd)
            payload = json.loads(
                raw.decode("ascii"),
                object_pairs_hook=reject_duplicate_keys,
                parse_constant=reject_non_finite,
            )
        except (OSError, json.JSONDecodeError, UnicodeError, ValueError):
            return False
        if not isinstance(payload, dict) or set(payload) != {"token", "pid", "start_us"}:
            return False
        pid = int(match.group(1))
        start_us = int(match.group(2))
        if payload.get("token") != token or payload.get("pid") != pid or payload.get("start_us") != start_us:
            return False
        registration_key = (pid, start_us)
        previous = registered.get(registration_key)
        if previous is not None:
            if previous[3] != payload["start_us"]:
                return False
        else:
            observed = identity(pid)
            if observed is None or observed[3] != payload["start_us"]:
                return False
            registered[registration_key] = observed
        ack = os.path.join(registry, f"ack.{pid}.{start_us}")
        try:
            fd = os.open(ack, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        except FileExistsError:
            try:
                ack_stat = os.lstat(ack)
            except OSError:
                return False
            if not stat.S_ISREG(ack_stat.st_mode) or ack_stat.st_uid != os.getuid() or ack_stat.st_nlink != 1:
                return False
    return True


def same_birth(expected) -> bool:
    observed = identity(expected[0])
    return observed is not None and observed[3] == expected[3]


def terminate_registered(registered: dict) -> bool:
    active = [expected for expected in registered.values() if same_birth(expected)]
    for expected in active:
        try:
            os.kill(expected[0], signal.SIGTERM)
        except ProcessLookupError:
            pass
    for _ in range(100):
        if not any(same_birth(expected) for expected in active):
            return True
        time.sleep(0.02)
    for expected in active:
        if not same_birth(expected):
            continue
        try:
            os.kill(expected[0], signal.SIGKILL)
        except ProcessLookupError:
            pass
    for _ in range(100):
        if not any(same_birth(expected) for expected in active):
            return True
        time.sleep(0.02)
    return not any(same_birth(expected) for expected in active)


def fatal(code: str) -> int:
    print(json.dumps({"schema_version": 1, "status": "fatal", "code": code}, separators=(",", ":")))
    return 2


def reject_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def reject_non_finite(_value):
    raise ValueError("non-finite JSON number")


def drain_pipes(selector, buffers: dict, limits: dict, timeout: float) -> bool:
    for key, _events in selector.select(timeout):
        try:
            chunk = os.read(key.fd, 65_536)
        except BlockingIOError:
            continue
        if not chunk:
            selector.unregister(key.fileobj)
            continue
        name = key.data
        buffers[name].extend(chunk)
        if len(buffers[name]) > limits[name]:
            return False
    return True


FATAL_CODES = {
    "BOOTSTRAP_APPROVAL_DRIFT", "BOOTSTRAP_APPROVAL_INVALID", "BOOTSTRAP_CHECKPOINT_EMPTY",
    "BOOTSTRAP_CHECKPOINT_INVALID", "BOOTSTRAP_COPY_DRIFT", "BOOTSTRAP_ENV_INCOMPLETE",
    "BOOTSTRAP_ENV_NOT_CLOSED", "BOOTSTRAP_EVIDENCE_MISMATCH", "BOOTSTRAP_IMPORT_ESCAPE",
    "BOOTSTRAP_MANAGED_SCOPE_PRESENT", "BOOTSTRAP_PATH_INVALID", "BOOTSTRAP_SNAPSHOT_FAILED",
    "BOOTSTRAP_SOURCE_DIRTY", "BOOTSTRAP_SOURCE_ENV_PRESENT", "BOOTSTRAP_SPECIAL_FILE",
    "BOOTSTRAP_SYMLINK_ESCAPE", "BOOTSTRAP_SYMLINK_UNVERIFIABLE",
    "BOOTSTRAP_WRAPPER_IDENTITY_UNAVAILABLE", "CANARY_BOOTSTRAP_INTERRUPTED", "CANARY_LOCK_HELD",
    "CANARY_LOCK_OWNERSHIP_DRIFT", "CANARY_LOCK_RELEASE_FAILED", "CANARY_LOCK_UNVERIFIABLE",
    "CANARY_OUTPUT_INVALID", "CANARY_OUTPUT_REJECTED", "CANARY_OWNER_UNVERIFIABLE",
    "CANARY_ROLLBACK_PROOF_INVALID",
    "CANARY_SNAPSHOT_CLEANUP_FAILED", "CANARY_WORKER_GROUP_REMAINED",
    "CANARY_WORKER_IDENTITY_UNAVAILABLE", "CANARY_WORKER_INTERRUPTED",
    "CANARY_WORKER_OUTPUT_MISSING", "CANARY_WORKER_STATUS_INVALID", "CANARY_WORKER_STATUS_MISSING",
    "CANARY_WORKER_TIMEOUT", "CANARY_WRAPPER_ORPHANED", "INJECTED_BOOTSTRAP_FAULT",
    "INJECTED_LOCK_TERM_FAULT",
} | {f"CANARY_{stage}_FATAL" for stage in (
    "ENV", "HERMES_SNAPSHOT", "MATRIX", "LIVE_POST", "EVIDENCE", "SERIALIZATION",
)} | {f"CANARY_BOOTSTRAP_{stage}_FATAL" for stage in (
    "ENV", "LOCK", "SNAPSHOT", "SNAPSHOT_CLEANUP", "RESULT_EMIT",
)} | {f"CANARY_LOCK_RELEASE_{stage}_FAILED" for stage in (
    "IDENTITY", "TERM", "TERM_WAIT", "KILL", "KILL_WAIT", "PID_VERIFY", "PROBE", "DONE",
)} | {f"CANARY_WORKER_{stage}_FAILED" for stage in (
    "PREPARE", "SPAWN", "IDENTITY", "WAIT", "STATUS", "GROUP", "OUTPUT", "PARSE", "DONE",
)}
SHA256 = re.compile(r"[a-f0-9]{64}")
CASE_KEYS = {
    "case_id", "mode", "tool", "branch", "runtime_identity_verified", "advertised_tool_verified",
    "advertised_schema_verified", "cbrain_invocation_count", "cbrain_call_verified",
    "mcp_session_verified", "session_cleanup_verified", "case_cleanup_verified", "semantic_config_verified",
    "host_projection_verified", "round_trip_verified", "result_title_present", "result_body_present",
    "empty_contract_verified", "error_contract_verified", "legacy_raw_present", "default_audit_present",
    "expected_audit_contract", "audit_contract_verified", "audit_redaction_exercised",
    "sensitive_input_sent", "direct_error_sensitive_echo_observed", "error_redaction_exercised",
    "audit_sensitive_exposed", "surface_internal_exposed", "expected_projection_kind",
    "observed_projection_kind", "projection_contract_verified", "text_structured_consistent", "token_method",
    "result_text_tokens", "structured_content_tokens", "wrapper_total_tokens", "wrapper_total_code_units",
}
BOOLEAN_CASE_KEYS = CASE_KEYS - {
    "case_id", "mode", "tool", "branch", "cbrain_invocation_count", "expected_audit_contract",
    "expected_projection_kind", "observed_projection_kind", "text_structured_consistent", "token_method",
    "result_text_tokens", "structured_content_tokens", "wrapper_total_tokens", "wrapper_total_code_units",
}
MANIFEST_KEYS = {
    "algorithm", "checkpoint_tree_digest", "checkpoint_blob_count", "bun_binary_digest", "bun_version",
    "node_modules_tree_digest", "node_modules_file_count", "package_manifest_digest", "lockfile_digest",
    "hermes_runtime_manifest_digest", "tokenizer_blob_digest", "fixture_schema_digest",
    "semantic_config_template_digest", "tool_schema_digest",
}
REASON_CODES = {
    "CASE_MATRIX_INCOMPLETE", "CASE_CONTRACT_FAILED", "SIZE_EVIDENCE_INVALID", "SIZE_GROWTH_EXCEEDED",
    "HOST_NOT_VERIFIED", "SNAPSHOT_NOT_VERIFIED", "TOKENIZER_NOT_OFFLINE", "LIVE_FINGERPRINT_DRIFT",
    "CLEANUP_NOT_VERIFIED", "EVIDENCE_DIGEST_MISMATCH", "SEMANTIC_SCOPE_MISSTATED",
    "ROLLBACK_NOT_EXECUTABLE",
}


def is_int(value) -> bool:
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def valid_manifest(value) -> bool:
    if not isinstance(value, dict) or set(value) != MANIFEST_KEYS:
        return False
    digests = MANIFEST_KEYS - {"algorithm", "checkpoint_blob_count", "node_modules_file_count", "bun_version"}
    return (
        value["algorithm"] == "sha256-canonical-json-v1"
        and is_int(value["checkpoint_blob_count"])
        and value["checkpoint_blob_count"] > 0
        and is_int(value["node_modules_file_count"])
        and value["node_modules_file_count"] > 0
        and isinstance(value["bun_version"], str)
        and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", value["bun_version"]) is not None
        and all(isinstance(value[key], str) and SHA256.fullmatch(value[key]) for key in digests)
    )


def valid_case(value) -> bool:
    if not isinstance(value, dict) or set(value) != CASE_KEYS:
        return False
    expected_id = f'{value.get("mode")}:{value.get("tool")}:{value.get("branch")}'
    if value.get("case_id") != expected_id:
        return False
    if value.get("mode") not in ("legacy", "structured") or value.get("tool") not in (
        "query", "deep_recall", "cbrain_recall",
    ) or value.get("branch") not in ("normal", "empty", "include_raw", "error"):
        return False
    if not all(type(value[key]) is bool for key in BOOLEAN_CASE_KEYS):
        return False
    if not all(is_int(value[key]) for key in (
        "cbrain_invocation_count", "result_text_tokens", "structured_content_tokens",
        "wrapper_total_tokens", "wrapper_total_code_units",
    )):
        return False
    return (
        value["expected_audit_contract"] in (
            "none", "query_locator_metadata", "deep_locator_metadata", "frontdoor_routing_metadata",
        )
        and value["expected_projection_kind"] in (
            "legacy_result_only", "result_plus_structured", "mcp_error_only",
        )
        and value["observed_projection_kind"] in (
            "legacy_result_only", "result_plus_structured", "mcp_error_only",
        )
        and (type(value["text_structured_consistent"]) is bool or value["text_structured_consistent"] is None)
        and value["token_method"] == "tiktoken_cl100k_base_exact"
    )


def case_contract_passes(value) -> bool:
    success_with_answer = value["branch"] in ("normal", "include_raw")
    structured_success = value["mode"] == "structured" and value["branch"] != "error"
    if value["mode"] != "structured" or value["branch"] != "include_raw":
        expected_audit = "none"
    elif value["tool"] == "query":
        expected_audit = "query_locator_metadata"
    elif value["tool"] == "deep_recall":
        expected_audit = "deep_locator_metadata"
    else:
        expected_audit = "frontdoor_routing_metadata"
    if value["mode"] != "legacy":
        expected_legacy_raw = False
    elif value["tool"] == "deep_recall":
        expected_legacy_raw = value["branch"] == "include_raw"
    else:
        expected_legacy_raw = value["branch"] != "error"
    if value["branch"] == "error":
        expected_projection = "mcp_error_only"
    elif value["mode"] == "structured":
        expected_projection = "result_plus_structured"
    else:
        expected_projection = "legacy_result_only"
    mandatory_true = (
        "runtime_identity_verified", "advertised_tool_verified", "advertised_schema_verified",
        "cbrain_call_verified", "mcp_session_verified", "session_cleanup_verified",
        "case_cleanup_verified", "semantic_config_verified", "host_projection_verified",
        "round_trip_verified", "audit_contract_verified", "projection_contract_verified",
    )
    error_contract = (
        value["sensitive_input_sent"]
        and value["error_redaction_exercised"] == value["direct_error_sensitive_echo_observed"]
    ) if value["branch"] == "error" else (
        not value["sensitive_input_sent"]
        and not value["direct_error_sensitive_echo_observed"]
        and not value["error_redaction_exercised"]
    )
    return (
        all(value[key] for key in mandatory_true)
        and value["cbrain_invocation_count"] == 1
        and (not success_with_answer or (value["result_title_present"] and value["result_body_present"]))
        and (value["branch"] != "empty" or value["empty_contract_verified"])
        and (value["branch"] != "error" or value["error_contract_verified"])
        and value["legacy_raw_present"] is expected_legacy_raw
        and not value["default_audit_present"]
        and value["expected_audit_contract"] == expected_audit
        and (expected_audit == "none" or value["audit_redaction_exercised"])
        and error_contract
        and not value["audit_sensitive_exposed"]
        and not value["surface_internal_exposed"]
        and value["expected_projection_kind"] == expected_projection
        and value["observed_projection_kind"] == expected_projection
        and value["text_structured_consistent"] is (True if structured_success else None)
    )


def valid_measurement(value, order: str, include_contracts: bool) -> bool:
    keys = {"order", "legacy_tokens", "structured_tokens", "legacy_code_units", "structured_code_units"}
    if include_contracts:
        keys |= {"legacy_contract_verified", "structured_contract_verified"}
    return (
        isinstance(value, dict) and set(value) == keys and value.get("order") == order
        and all(is_int(value[key]) for key in ("legacy_tokens", "structured_tokens", "legacy_code_units", "structured_code_units"))
        and (not include_contracts or (type(value["legacy_contract_verified"]) is bool and type(value["structured_contract_verified"]) is bool))
    )


def valid_size_pair(value) -> bool:
    keys = {
        "pair_id", "tool", "branch", "ab", "ba", "worst_structured_tokens", "best_legacy_tokens",
        "growth_tokens", "ratio", "absolute_gate_passed", "relative_or_floor_gate_passed",
    }
    if not isinstance(value, dict) or set(value) != keys:
        return False
    return (
        value["tool"] in ("query", "deep_recall", "cbrain_recall")
        and value["branch"] in ("normal", "empty")
        and value["pair_id"] == f'{value["tool"]}:{value["branch"]}'
        and valid_measurement(value["ab"], "legacy_then_structured", False)
        and valid_measurement(value["ba"], "structured_then_legacy", True)
        and all(is_int(value[key]) for key in ("worst_structured_tokens", "best_legacy_tokens", "growth_tokens"))
        and (
            value["ratio"] is None
            or (
                type(value["ratio"]) in (int, float)
                and math.isfinite(value["ratio"])
                and 0 <= value["ratio"] <= MAX_SAFE_INTEGER
            )
        )
        and type(value["absolute_gate_passed"]) is bool
        and type(value["relative_or_floor_gate_passed"]) is bool
    )


def size_pair_contract(value):
    observation_contracts_valid = (
        value["ba"]["legacy_contract_verified"] and value["ba"]["structured_contract_verified"]
    )
    worst_structured = max(value["ab"]["structured_tokens"], value["ba"]["structured_tokens"])
    best_legacy = min(value["ab"]["legacy_tokens"], value["ba"]["legacy_tokens"])
    growth = max(0, worst_structured - best_legacy)
    ratio = None if best_legacy == 0 else worst_structured / best_legacy
    absolute_pass = growth <= 128
    relative_or_floor_pass = (
        worst_structured <= best_legacy * 1.25
        if best_legacy >= 128
        else worst_structured <= best_legacy + 32
    )
    formula_valid = (
        value["worst_structured_tokens"] == worst_structured
        and value["best_legacy_tokens"] == best_legacy
        and value["growth_tokens"] == growth
        and value["ratio"] == ratio
        and value["absolute_gate_passed"] is absolute_pass
        and value["relative_or_floor_gate_passed"] is relative_or_floor_pass
    )
    return (formula_valid, observation_contracts_valid, absolute_pass and relative_or_floor_pass)


def canonical_evidence_digest(manifest) -> str:
    encoded = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def claims_rollback_ready(raw: str) -> bool:
    try:
        payload = json.loads(
            raw,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_non_finite,
        )
    except (json.JSONDecodeError, TypeError, ValueError):
        return False
    report = payload.get("report") if isinstance(payload, dict) else None
    return (
        isinstance(report, dict)
        and report.get("rollback_command_id") == "cbrain-structured-cohort-rollback-v1"
    )


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def git_output(source_root: str, args: list[str]) -> bytes:
    result = subprocess.run(
        ["/usr/bin/git", *args],
        cwd=source_root,
        env={"HOME": "/var/empty", "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=5,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("closed git verification failure")
    return result.stdout


def verify_rollback_proof(
    bun: str,
    source_root: str,
    approved_commit: str,
    owned_root: str,
    deadline: float,
) -> bool:
    try:
        if git_output(source_root, ["status", "--porcelain", "--untracked-files=all"]).strip():
            return False
        head = git_output(source_root, ["rev-parse", "HEAD"]).decode("ascii").strip()
        if re.fullmatch(r"[a-f0-9]{40}", head) is None:
            return False
        git_output(source_root, ["merge-base", "--is-ancestor", approved_commit, head])
        changed = git_output(source_root, ["diff", "--name-only", approved_commit, head]).decode("utf-8").splitlines()
        if any(not path.startswith("docs/") for path in changed):
            return False
        manifest_relative = "tests/fixtures/hermes-structured-canary-evidence-manifest.json"
        approved_manifest = git_output(source_root, ["show", f"{approved_commit}:{manifest_relative}"])
        manifest_path = os.path.join(source_root, manifest_relative)
        with open(manifest_path, "rb") as handle:
            current_manifest = handle.read()
        if current_manifest != approved_manifest:
            return False
        manifest = json.loads(approved_manifest)
        listing = []
        for line in git_output(source_root, ["ls-tree", "-r", "--full-tree", head]).decode("utf-8").splitlines():
            path = line.split("\t", 1)[1]
            if not path.startswith("docs/") and path != manifest_relative:
                listing.append(line)
        checkpoint = hashlib.sha256(("\n".join(listing) + "\n").encode("utf-8")).hexdigest()
        if (
            checkpoint != manifest.get("checkpoint_tree_digest")
            or len(listing) != manifest.get("checkpoint_blob_count")
            or file_sha256(os.path.realpath(bun)) != manifest.get("bun_binary_digest")
        ):
            return False
        proof_entry = os.path.join(source_root, "bin", "prove-structured-cohort-rollback.ts")
        if os.path.realpath(proof_entry) != proof_entry or not stat.S_ISREG(os.lstat(proof_entry).st_mode):
            return False
        proof_home = os.path.join(owned_root, "proof-home")
        proof_cwd = os.path.join(owned_root, "proof-cwd")
        os.mkdir(proof_home, 0o700)
        os.mkdir(proof_cwd, 0o700)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        result = subprocess.run(
            [bun, "--no-env-file", "--config=/dev/null", f"--cwd={proof_cwd}", proof_entry],
            cwd=proof_cwd,
            env={
                "HOME": proof_home,
                "TMPDIR": os.path.join(owned_root, "tmp"),
                "PATH": "/usr/bin:/bin",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
            },
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=min(15.0, remaining),
            check=False,
        )
        expected = json.dumps(
            {
                "schema_version": 1,
                "status": "verified",
                "command_id": "cbrain-structured-cohort-rollback-v1",
            },
            separators=(",", ":"),
        )
        return result.returncode == 0 and result.stderr == b"" and result.stdout.decode("utf-8").strip() == expected
    except Exception:
        return False


def report_is_consistent(payload, rollback_proof_verified: bool) -> bool:
    report = payload["report"]
    runtime = payload["runtime"]
    cases = payload["case_metrics"]
    pairs = payload["size_pairs"]
    reasons = []
    if not all(case_contract_passes(item) for item in cases):
        reasons.append("CASE_CONTRACT_FAILED")
    pair_contracts = [size_pair_contract(item) for item in pairs]
    if not all(formula_valid for formula_valid, _observations_valid, _within in pair_contracts):
        return False
    if not all(observations_valid for _formula_valid, observations_valid, _within in pair_contracts):
        reasons.append("SIZE_EVIDENCE_INVALID")
    elif not all(within for _formula_valid, _observations_valid, within in pair_contracts):
        reasons.append("SIZE_GROWTH_EXCEEDED")
    if not runtime["real_hermes_host"]:
        reasons.append("HOST_NOT_VERIFIED")
    if not runtime["hermes_snapshot_verified"] or not runtime["cbrain_snapshot_verified"]:
        reasons.append("SNAPSHOT_NOT_VERIFIED")
    if not runtime["tokenizer_offline_verified"]:
        reasons.append("TOKENIZER_NOT_OFFLINE")
    if not runtime["live_fingerprint_unchanged"]:
        reasons.append("LIVE_FINGERPRINT_DRIFT")
    if not runtime["cleanup_verified"]:
        reasons.append("CLEANUP_NOT_VERIFIED")
    if not runtime["semantic_answer_quality_not_measured"]:
        reasons.append("SEMANTIC_SCOPE_MISSTATED")
    digest_mismatch = canonical_evidence_digest(report["evidence_manifest"]) != report["evidence_generation_digest"]
    reported_evidence_mismatch = "EVIDENCE_DIGEST_MISMATCH" in report["reason_codes"]
    if digest_mismatch or reported_evidence_mismatch:
        reasons.append("EVIDENCE_DIGEST_MISMATCH")
    host_compatible = len(reasons) == 0
    rollout_ready = (
        rollback_proof_verified
        and report["rollback_command_id"] == "cbrain-structured-cohort-rollback-v1"
    )
    if not rollout_ready:
        reasons.append("ROLLBACK_NOT_EXECUTABLE")
    return (
        report["reason_codes"] == reasons
        and report["host_compatibility"] == ("compatible" if host_compatible else "incompatible")
        and report["rollout_readiness"] == ("ready" if rollout_ready else "blocked")
        and report["verdict"] == ("go" if host_compatible and rollout_ready else "no-go")
        and report["matrix"] == {
            "expected_cases": 24,
            "completed_cases": 24,
            "size_repetition_executions": 12,
        }
    )


def valid_report(value) -> bool:
    keys = {
        "verdict", "host_compatibility", "rollout_readiness", "rollback_command_id", "reason_codes", "matrix",
        "evidence_manifest", "evidence_generation_digest", "semantic_answer_quality_not_measured",
    }
    if not isinstance(value, dict) or set(value) != keys:
        return False
    matrix = value.get("matrix")
    return (
        value["verdict"] in ("go", "no-go")
        and value["host_compatibility"] in ("compatible", "incompatible")
        and value["rollout_readiness"] in ("ready", "blocked")
        and value["rollback_command_id"] in (None, "cbrain-structured-cohort-rollback-v1")
        and isinstance(value["reason_codes"], list)
        and len(set(value["reason_codes"])) == len(value["reason_codes"])
        and all(code in REASON_CODES for code in value["reason_codes"])
        and isinstance(matrix, dict)
        and set(matrix) == {"expected_cases", "completed_cases", "size_repetition_executions"}
        and matrix["expected_cases"] == 24
        and is_int(matrix["completed_cases"])
        and is_int(matrix["size_repetition_executions"])
        and valid_manifest(value["evidence_manifest"])
        and isinstance(value["evidence_generation_digest"], str)
        and SHA256.fullmatch(value["evidence_generation_digest"]) is not None
        and value["semantic_answer_quality_not_measured"] is True
    )


def valid_runtime(value) -> bool:
    keys = {
        "cbrain_version", "hermes_version", "tokenizer_version", "real_hermes_host",
        "hermes_snapshot_verified", "cbrain_snapshot_verified", "tokenizer_offline_verified",
        "live_relevant_process_count", "live_fingerprint_unchanged", "cleanup_verified",
        "semantic_answer_quality_not_measured",
    }
    if not isinstance(value, dict) or set(value) != keys:
        return False
    return (
        all(isinstance(value[key], str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", value[key]) for key in (
            "cbrain_version", "hermes_version", "tokenizer_version",
        ))
        and is_int(value["live_relevant_process_count"])
        and all(type(value[key]) is bool for key in keys - {
            "cbrain_version", "hermes_version", "tokenizer_version", "live_relevant_process_count",
        })
        and value["real_hermes_host"] is True
        and value["semantic_answer_quality_not_measured"] is True
    )


def validated_public_result(raw: str, exit_status: int, rollback_proof_verified: bool = False):
    if len(raw) > 2_000_000 or SENSITIVE_OUTPUT.search(raw):
        return None
    try:
        payload = json.loads(
            raw,
            object_pairs_hook=reject_duplicate_keys,
            parse_constant=reject_non_finite,
        )
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    if not isinstance(payload, dict) or type(payload.get("schema_version")) is not int or payload["schema_version"] != 1:
        return None
    if payload.get("status") == "fatal":
        if set(payload) != {"schema_version", "status", "code"}:
            return None
        code = payload.get("code")
        if code not in FATAL_CODES or exit_status != 2:
            return None
        return raw
    if payload.get("status") != "complete" or set(payload) != {
        "schema_version", "status", "runtime", "case_metrics", "size_pairs", "report"
    }:
        return None
    report = payload.get("report")
    cases = payload.get("case_metrics")
    pairs = payload.get("size_pairs")
    if (
        not valid_report(report) or not valid_runtime(payload.get("runtime"))
        or not isinstance(cases, list) or len(cases) != 24 or not all(valid_case(item) for item in cases)
        or len({item["case_id"] for item in cases}) != 24
        or not isinstance(pairs, list) or len(pairs) != 6 or not all(valid_size_pair(item) for item in pairs)
        or len({item["pair_id"] for item in pairs}) != 6
        or not report_is_consistent(payload, rollback_proof_verified)
    ):
        return None
    expected_status = 0 if report["verdict"] == "go" else 1
    return raw if exit_status == expected_status else None


def process_group_empty(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        return False


def terminate_group(child: subprocess.Popen, expected) -> bool:
    pgid = expected[2]
    if pgid != child.pid:
        return False
    if process_group_empty(pgid):
        return True
    if identity(child.pid) == expected:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            return True
    for _ in range(100):
        child.poll()
        if process_group_empty(pgid):
            return True
        time.sleep(0.02)
    # A process group cannot be reused while any original member remains. It is
    # therefore safe to escalate using the recorded PGID even if its leader has
    # already exited after TERM.
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    for _ in range(100):
        child.poll()
        if process_group_empty(pgid):
            return True
        time.sleep(0.02)
    return process_group_empty(pgid)


def remove_owned_root(root: str, expected) -> bool:
    parent, name = os.path.split(root)
    if parent != "/tmp" or not re.fullmatch(r"cbrain-hermes-structured-bootstrap\.[a-f0-9]{24}", name):
        return False

    def empty_directory(directory_fd: int):
        os.fchmod(directory_fd, 0o700)
        for entry in os.listdir(directory_fd):
            observed = os.stat(entry, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(observed.st_mode):
                child_fd = os.open(
                    entry,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=directory_fd,
                )
                try:
                    opened = os.fstat(child_fd)
                    if (opened.st_dev, opened.st_ino) != (observed.st_dev, observed.st_ino):
                        return False
                    if not empty_directory(child_fd):
                        return False
                finally:
                    os.close(child_fd)
                current = os.stat(entry, dir_fd=directory_fd, follow_symlinks=False)
                if (current.st_dev, current.st_ino) != (observed.st_dev, observed.st_ino):
                    return False
                os.rmdir(entry, dir_fd=directory_fd)
            else:
                os.unlink(entry, dir_fd=directory_fd)
        return True

    parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            root_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        except FileNotFoundError:
            return False
        try:
            observed = os.fstat(root_fd)
            if (observed.st_dev, observed.st_ino) != expected or not empty_directory(root_fd):
                return False
        finally:
            os.close(root_fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != expected:
            return False
        os.rmdir(name, dir_fd=parent_fd)
        return True
    finally:
        os.close(parent_fd)


def main() -> int:
    if len(sys.argv) != 7:
        return fatal("CANARY_SUPERVISOR_ARGUMENT_INVALID")
    wrapper_pid_text, bun, hermes, source_root, approved_commit, fault = sys.argv[1:]
    if not wrapper_pid_text.isdigit() or int(wrapper_pid_text) < 2:
        return fatal("CANARY_SUPERVISOR_ARGUMENT_INVALID")
    if not all(os.path.isabs(path) for path in (bun, hermes, source_root)):
        return fatal("CANARY_SUPERVISOR_ARGUMENT_INVALID")
    if not re.fullmatch(r"[a-f0-9]{40}", approved_commit):
        return fatal("CANARY_SUPERVISOR_ARGUMENT_INVALID")

    wrapper_pid = int(wrapper_pid_text)
    if os.getppid() != wrapper_pid:
        return fatal("CANARY_SUPERVISOR_IDENTITY_UNAVAILABLE")
    wrapper = identity(wrapper_pid)
    self_identity = identity(os.getpid())
    if wrapper is None or self_identity is None or os.getppid() != wrapper_pid:
        return fatal("CANARY_SUPERVISOR_IDENTITY_UNAVAILABLE")

    interrupted = 0

    def on_signal(signum, _frame):
        nonlocal interrupted
        interrupted = interrupted or signum

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, on_signal)

    lock_fd = None
    root = None
    root_identity = None
    child = None
    child_identity = None
    registry = None
    registration_token = secrets.token_hex(32)
    registered = {}
    result = ""
    output_buffers = {"stdout": bytearray(), "stderr": bytearray()}
    output_limits = {"stdout": STDOUT_LIMIT_BYTES, "stderr": STDERR_LIMIT_BYTES}
    pipe_selector = selectors.DefaultSelector()
    status = 2
    orphaned = False
    cleanup_ok = False
    group_cleanup_ok = True
    failure_code = None
    try:
        lock_fd = os.open(SUPERVISOR_LOCK_PATH, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        lock_stat = os.fstat(lock_fd)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid != os.getuid() or lock_stat.st_nlink != 1:
            raise RuntimeError("closed supervisor lock identity failure")
        os.fchmod(lock_fd, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            failure_code = "CANARY_LOCK_HELD"
            raise RuntimeError("closed supervisor lock failure")
        timeout_seconds = (
            TEST_SUPERVISOR_TIMEOUT_SECONDS if fault == "supervisor_timeout" else SUPERVISOR_TIMEOUT_SECONDS
        )
        deadline = time.monotonic() + timeout_seconds
        for _ in range(16):
            candidate_root = f"/tmp/cbrain-hermes-structured-bootstrap.{secrets.token_hex(12)}"
            try:
                os.mkdir(candidate_root, 0o700)
                root = candidate_root
                break
            except FileExistsError:
                continue
        if root is None:
            raise RuntimeError("closed root allocation failure")
        root_stat = os.lstat(root)
        root_identity = (root_stat.st_dev, root_stat.st_ino)
        home = os.path.join(root, "home")
        cwd = os.path.join(root, "cwd")
        temp = os.path.join(root, "tmp")
        for path in (home, cwd, temp):
            os.mkdir(path, 0o700)
        registry = os.path.join(root, "process-registry")
        os.mkdir(registry, 0o700)
        env = {
            "HOME": home, "TMPDIR": temp, "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "CBRAIN_CANARY_BOOT_ROOT": root, "CBRAIN_CANARY_SOURCE_ROOT": source_root,
            "CBRAIN_CANARY_HERMES_EXEC": hermes, "CBRAIN_CANARY_PARENT_MANAGED_DIR": os.environ.get("HERMES_MANAGED_DIR", ""),
            "CBRAIN_CANARY_LIVE_HOME": os.environ.get("HOME", ""), "CBRAIN_CANARY_FAULT": fault,
            "CBRAIN_CANARY_APPROVED_COMMIT": approved_commit,
            "CBRAIN_CANARY_WRAPPER_IDENTITY": identity_text(self_identity),
            "CBRAIN_CANARY_PROCESS_REGISTRY": registry,
            "CBRAIN_CANARY_REGISTRATION_TOKEN": registration_token,
        }
        command = [bun, "--no-env-file", "--config=/dev/null", f"--cwd={cwd}", os.path.join(source_root, "bin/bootstrap-hermes-structured-host-canary.ts")]
        child = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            bufsize=0,
        )
        for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
            os.set_blocking(stream.fileno(), False)
            pipe_selector.register(stream, selectors.EVENT_READ, name)
        child_identity = identity(child.pid)
        if child_identity is None or child_identity[1] != os.getpid() or child_identity[2] != child.pid:
            failure_code = "CANARY_SUPERVISOR_CHILD_IDENTITY_INVALID"
        else:
            while child.poll() is None:
                if not scan_registrations(registry, registration_token, registered):
                    failure_code = "CANARY_PROCESS_REGISTRATION_INVALID"
                    break
                if os.getppid() != wrapper_pid or identity(wrapper[0]) != wrapper:
                    orphaned = True
                    break
                if interrupted:
                    break
                if time.monotonic() >= deadline:
                    failure_code = "CANARY_SUPERVISOR_TIMEOUT"
                    break
                if not drain_pipes(pipe_selector, output_buffers, output_limits, 0.05):
                    failure_code = "CANARY_OUTPUT_LIMIT_EXCEEDED"
                    break
            if child.poll() is not None:
                status = child.returncode
                while pipe_selector.get_map():
                    if not drain_pipes(pipe_selector, output_buffers, output_limits, 0):
                        failure_code = "CANARY_OUTPUT_LIMIT_EXCEEDED"
                        break
                    if not pipe_selector.select(0):
                        break
            if os.getppid() != wrapper_pid or identity(wrapper[0]) != wrapper:
                orphaned = True
        if not orphaned and not interrupted and failure_code is None:
            try:
                candidate = bytes(output_buffers["stdout"]).decode("utf-8", errors="strict").strip()
            except UnicodeDecodeError:
                candidate = ""
            rollback_proof_verified = False
            if claims_rollback_ready(candidate):
                rollback_proof_verified = verify_rollback_proof(
                    bun, source_root, approved_commit, root, deadline,
                )
                if not rollback_proof_verified:
                    failure_code = "CANARY_ROLLBACK_PROOF_INVALID"
            if failure_code is None:
                result = validated_public_result(candidate, status, rollback_proof_verified) or ""
                if not result:
                    failure_code = "CANARY_OUTPUT_INVALID"
    except Exception:
        failure_code = failure_code or "CANARY_SUPERVISOR_RUNTIME_FAILED"
    finally:
        for key in list(pipe_selector.get_map().values()):
            try:
                pipe_selector.unregister(key.fileobj)
            except Exception:
                pass
            try:
                key.fileobj.close()
            except Exception:
                pass
        pipe_selector.close()
        if registry is not None:
            try:
                if not scan_registrations(registry, registration_token, registered):
                    group_cleanup_ok = False
            except Exception:
                group_cleanup_ok = False
        if not terminate_registered(registered):
            group_cleanup_ok = False
        if child is not None and child_identity is not None:
            try:
                group_cleanup_ok = terminate_group(child, child_identity)
            except Exception:
                group_cleanup_ok = False
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                group_cleanup_ok = False
        elif child is not None:
            group_cleanup_ok = False
            try:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=2)
            except Exception:
                pass
        if registry is not None:
            try:
                if not scan_registrations(registry, registration_token, registered):
                    group_cleanup_ok = False
            except Exception:
                group_cleanup_ok = False
        if not terminate_registered(registered):
            group_cleanup_ok = False
        if root is not None and root_identity is not None:
            try:
                cleanup_ok = remove_owned_root(root, root_identity)
            except Exception:
                cleanup_ok = False
        elif root is None:
            cleanup_ok = True
        if lock_fd is not None:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
            except OSError:
                group_cleanup_ok = False
            lock_fd = None

    if orphaned:
        return 2
    if interrupted:
        return 128 + interrupted
    if not cleanup_ok:
        return fatal("CANARY_OUTER_CLEANUP_FAILED")
    if not group_cleanup_ok:
        return fatal("CANARY_SUPERVISOR_CHILD_CLEANUP_FAILED")
    if failure_code:
        return fatal(failure_code)
    if not result:
        return fatal("CANARY_OUTPUT_MISSING")
    print(result)
    return status if status in (0, 1, 2) else 2


if __name__ == "__main__":
    try:
        exit_code = main()
    except Exception:
        exit_code = fatal("CANARY_SUPERVISOR_FATAL")
    raise SystemExit(exit_code)
