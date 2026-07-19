# Permanent Anti-Overengineering Development Gate

Date: 2026-07-19
Status: approved direction; written spec pending review

## 1. Problem

CBrain's strategic direction remains valid, but capability growth has begun to
outpace product closure. Reliability and security work has produced necessary
defensive complexity, while release proof, compatibility layers and
not-yet-consumed frameworks have also increased maintenance cost.

A temporary feature freeze does not solve this by itself. CBrain needs a
permanent decision rule that distinguishes necessary complexity from
speculative complexity before implementation starts and repeats that check at
delivery.

The rule must not become another software subsystem. It is a human review
contract carried by the existing development protocol and GitHub templates.

## 2. Goals

- Require every issue to justify why the smallest local change is insufficient.
- Stop speculative frameworks, public surface growth and persistent state from
  entering implementation without an explicit decision.
- Preserve complexity that is necessary for privacy, state consistency,
  rollback and deterministic recovery.
- Make temporary compatibility mechanisms carry an observable retirement path.
- Require delivery review to remove code that does not serve the approved goal.

## 3. Non-goals

- No complexity scoring service, linter, CI checker or new release gate.
- No hard rejection based only on lines of code, file count or test ratio.
- No broad refactor of existing large files.
- No retroactive removal of public APIs without usage evidence and compatibility
  review.
- No weakening of privacy, rollback, data-integrity or fail-closed behavior in
  the name of simplicity.

## 4. Alternatives considered

### A. Review convention only

Codex informally asks whether a change is too complex. This is cheap but easy to
forget and leaves no stable contract for issue authors or implementers.

### B. Lightweight permanent gate — selected

Add a concise permanent section to `AGENTS.md` and focused questions to the
existing bug, feature and pull-request templates. Codex applies the questions
at design and final review. No executable enforcement is added.

### C. Automated complexity enforcement

Add scripts that reject changes using LOC, dependency, API or module counts.
This creates a new governance subsystem, encourages metric gaming and cannot
distinguish necessary security code from speculative abstraction. Rejected.

## 5. Permanent gate

### 5.1 Evidence before capability

Every issue must identify a concrete user-visible failure, operating incident,
measured bottleneck or contractual gap. A roadmap aspiration alone is not
sufficient evidence for implementation.

For exploratory work, the first deliverable is the smallest measurement or
prototype that can validate the assumption. It must not silently become a
production framework.

### 5.2 Smallest-solution proof

Before implementation, the issue must answer:

1. What happens if nothing is changed?
2. What is the smallest local change that addresses the evidence?
3. Why is anything larger necessary now?
4. Which proposed parts can be deferred until a second real use case exists?

If the smallest solution satisfies the acceptance criteria, the larger design
is rejected.

### 5.3 Complexity triggers

Any one of the following pauses default implementation and requires an explicit
Codex recommendation plus user approval:

- a new MCP tool/action, CLI command/flag or HTTP endpoint;
- a new database table, migration, durable state family, background loop or
  process;
- a change to a public default, privacy boundary or compatibility contract;
- one issue changing more than three independent subsystems;
- an estimate above 300 net new production lines;
- a registry, plugin layer, generic framework or abstraction with only one
  existing production consumer.

These are review triggers, not automatic rejection thresholds. They must not be
implemented as a checker or gamed by moving code between files.

### 5.4 Two-consumer rule

A reusable abstraction requires at least two existing, named production
consumers with materially shared behavior. Tests, hypothetical roadmap items
and future callers do not count.

With one consumer, prefer a local function or a deliberately narrow module. A
second consumer may justify extraction later.

### 5.5 Single-behavior issue budget

An issue should normally contain:

- one user-observable behavior change;
- one coherent state transition;
- one independently reversible delivery.

Combining a new public interface, persistent schema and background executor in
one issue requires decomposition unless they are inseparable for correctness.
Unrelated cleanup is excluded even when the touched file needs cleanup.

### 5.6 Compatibility and retirement

Every new alias, compatibility branch, feature flag or temporary fallback must
state:

- why it is required;
- how use will be observed without collecting private inputs;
- the earliest safe removal release or condition;
- the issue responsible for removal or reassessment.

If use cannot be observed, the mechanism cannot be claimed to be temporary and
must be reviewed as permanent complexity.

### 5.7 Delivery subtraction review

Before approval, Codex must answer in the review summary:

- What code or proposed behavior was removed or avoided?
- Does every new abstraction have two real consumers?
- Are tests protecting external behavior or freezing implementation details?
- Did the change add an interface, state family or compatibility path that the
  current user workflow does not need?
- Is the product benefit worth the ongoing maintenance and release cost?

The allowed verdicts are `approve`, `simplify`, `split` and `reject`. A green
test suite is necessary but does not override a `simplify` or `split` verdict.

## 6. Work-type guidance

### Reliability and security fixes

Fail-closed checks, ownership validation, rollback and state reconciliation may
legitimately exceed the normal size trigger. Their review must still show that
the complexity closes a reproduced failure and is isolated from normal hot
paths where possible.

### Tests and release proof

Tests should assert public contracts and reproduced failure modes. AST/source
shape checks, mutation matrices and frozen evidence chains require a stated
threat model; they must not expand to cover arbitrary obfuscation or
hypothetical attackers.

Host-specific proof belongs in release-only paths. It must not be copied into
the steady-state service or default developer workflow without new evidence.

### Refactoring

Large-file cleanup is performed only when an approved issue already touches the
responsibility being extracted. There is no standalone rewrite merely to
improve line counts.

## 7. Repository integration

The implementation changes only these existing governance surfaces:

- `AGENTS.md`: permanent anti-overengineering protocol and decision triggers.
- `.github/ISSUE_TEMPLATE/bug_report.md`: root cause, smallest fix and explicit
  non-goals.
- `.github/ISSUE_TEMPLATE/feature_request.md`: evidence, smallest alternative,
  complexity triggers and consumer proof.
- `.github/PULL_REQUEST_TEMPLATE.md`: complexity delta, avoided scope,
  retirement obligations and subtraction review.

No product source, test runner, CI workflow, database schema or runtime config
changes as part of this protocol.

## 8. Immediate application

- Issue #358 reuses the existing watcher, sync, health and bulk-resume
  boundaries. It does not add a tool, action, database table or HTTP endpoint.
- Issue #359 removes duplicate payload fields; it does not redesign the output
  envelope.
- The real-vault replay work starts as a local private fixture runner plus an
  aggregate report, not an evaluation platform.
- Structured rollout reuses the rollback and canary capability already merged;
  it does not add another proof layer.
- Recommendation and judgment frameworks remain frozen until a second real
  production consumer exists.

## 9. Acceptance

The protocol is complete when:

1. the permanent rule is visible in `AGENTS.md`;
2. bug, feature and PR templates ask only the decisions needed by this design;
3. no executable checker or product code is added;
4. existing privacy and development-governance rules remain unchanged;
5. the documentation consistency gate passes.
