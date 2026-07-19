# Permanent Anti-Overengineering Development Gate Implementation Plan

> **For agentic workers:** Execute this plan inline. Do not add product code,
> automated enforcement or new governance surfaces.

**Goal:** Make the approved anti-overengineering contract part of CBrain's
normal issue, implementation and review workflow.

**Architecture:** Add one concise policy section to the existing project agent
protocol and focused decision prompts to the three existing GitHub templates.
The gate remains human-reviewed Markdown; it has no runtime or CI component.

**Tech Stack:** Markdown, existing documentation consistency checks.

## Constraints

- Change only `AGENTS.md`, the three existing GitHub templates, this plan and the
  approved spec clarification.
- Preserve the existing privacy, architecture and release-governance rules.
- Do not add a checker, workflow, script, database state, command or public API.
- Keep the templates short enough to be used rather than bypassed.
- Use one implementation commit because the four surfaces form one review
  contract and must not drift independently.

## Task 1: Add the permanent project protocol

**File:** `AGENTS.md`

1. Add a `永久反过度工程化门禁` section after the existing decision gate.
2. Record evidence-first and smallest-solution questions.
3. Record the six complexity triggers and the two-consumer rule.
4. Record issue scope, compatibility retirement and delivery subtraction rules.
5. Record the process complexity budget so approved work is not rediscovered.
6. State that the gate is human review, not executable enforcement, and that
   reliability, privacy and rollback guarantees must not be weakened.

## Task 2: Align existing contribution templates

**Files:**

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

1. Bug reports ask for evidence, root-cause boundary, smallest safe fix and
   explicit non-goals.
2. Feature requests ask for production evidence, smallest solution, named real
   consumers and any triggered approval.
3. Pull requests report complexity delta, avoided scope, temporary-retirement
   obligations and the subtraction-review verdict.
4. Make verification proportional: full checks for product code and the docs
   gate for documentation-only changes.

## Task 3: Verify and deliver

1. Run `bun run check:docs`.
2. Run `git diff --check`.
3. Confirm the diff contains no executable product or CI files.
4. Scan changed public text for private names, home paths, credentials and vault
   content.
5. Ask an adversarial reviewer to look for loopholes, template bloat,
   contradictions and accidental weakening of safety rules.
6. Address actionable findings and rerun the checks.
7. Commit as `docs: enforce anti-overengineering review contract`.
