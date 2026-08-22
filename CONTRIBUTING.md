# Contributing to CBrain

Thanks for your interest in contributing to CBrain!

## Development Setup

```bash
# Clone and install
git clone https://github.com/user/cbrain.git
cd cbrain
bun install

# Run full gate (typecheck src + tests + biome lint + tests)
bun run check
```

## How to Contribute

### Bug Reports

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your OS, Bun version, and CBrain version

### Feature Requests

Open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Why it fits CBrain's scope (personal knowledge brain for AI Agents)

### Pull Requests

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Write tests first (TDD)
4. Implement your changes
5. Ensure full gate passes: `bun run check` (typecheck src + tests + biome lint + bun test)
6. Commit with conventional format: `feat: add X`, `fix: Y`, etc.
7. Open a PR against `main` and put `Closes #<issue-number>` in its description
8. Let the merged PR close the code issue; a side-branch commit is not delivery evidence

### Closing Code Issues

A code issue is complete only when its fix is reachable from `main`. Prefer a
PR targeting `main` with `Closes #<issue-number>` so GitHub records that
relationship when the PR merges. Do not manually close an issue merely because
a local or side-branch commit exists.

If an exceptional workflow requires manual closure, fetch the current remote
state and require this command to exit `0` before closing:

```bash
git fetch origin main
git merge-base --is-ancestor <fix-commit> origin/main
```

Record the full fix commit in the closing comment. A non-zero exit means the
fix is not in `main`; keep the issue open.

## Code Style

- TypeScript strict mode
- Immutable patterns — create new objects, don't mutate
- Files < 400 lines, functions < 50 lines
- No comments unless the WHY is non-obvious

## Project Structure

```
src/
  cli/        # CLI commands (commander)
  mcp/        # MCP server
  core/       # Business logic (ingest, search, graph, enrich, sync)
  storage/    # SQLite + LanceDB adapters
  embedding/  # Embedding providers
  utils/      # Shared utilities
skills/       # Agent skill files (markdown)
tests/        # Test files mirror src/ structure
```

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add timeline query support
fix: correct Chinese tokenizer offset
docs: update README with MCP config
refactor: extract slug generation to utils
test: add graph traversal edge cases
chore: bump dependencies
```

## Testing

- 80%+ coverage required
- Write tests first (TDD: RED → GREEN → REFACTOR)
- Unit tests for utilities and core logic
- Integration tests for storage and search
- CLI tests use `execSync` against the actual binary
