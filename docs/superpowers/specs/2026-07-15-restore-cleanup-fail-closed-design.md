# Issue #345 Restore Cleanup Fail-Closed Design

**Issue:** #345  
**Status:** Approved for implementation by product owner  
**Date:** 2026-07-15

## 1. Problem and invariant

`cbrain restore` currently treats the database/vault swap as the end of the
restore. If removal of the exact managed `vault.pre-restore` tree fails, the
error is swallowed and the command still reports success. That leaves a later
restore blocked even though the newly restored data is already active.

The user-visible invariant is:

> A full restore exits zero only after the database and vault are installed and
> the exact managed post-restore artifacts have been verified absent.

Cleanup failure after a valid primary swap is not a rollback condition. The new
database and vault stay active; the command fails closed so an operator cannot
mistake an incomplete lifecycle for a clean success.

## 2. Cleanup state machine

The full-restore flow keeps the existing atomic swap and rollback behavior:

1. snapshot current database to `.rollback`;
2. install the backup database;
3. rename the current vault to the exact `.pre-restore` path;
4. rename the extracted vault to the active vault path;
5. finalize managed artifacts;
6. report success only when finalization is verified.

Managed-artifact cleanup uses a small deterministic policy:

- maximum three removal attempts;
- stabilization waits of 50 ms, 150 ms, and 300 ms after the corresponding
  attempt (500 ms maximum total wait);
- verify the exact directory entry is absent after every wait;
- re-scan the complete applicable artifact set after every wait, so an entry
  that materializes while another artifact settles cannot escape verification;
- an already-absent path succeeds without a removal attempt;
- no parent-directory scan, glob, or sibling deletion.

Removal also requires transaction ownership. The restore records whether this
run actually created/adopted `.pre-restore` and `.rollback`. If either exact
entry was absent at preflight and materializes later, it is verify-only: its
presence makes finalization incomplete, but restore never deletes or adopts it.
WAL/SHM remain exact database-managed artifacts. Database installation and its
failure rollback use the same ownership bit, so an unowned `.rollback` can
neither be deleted nor installed as the active database.

DB-only restore must claim its rollback name with an atomic exclusive primitive
(hard link on the same filesystem), not `lstat` followed by `rename`: POSIX
rename can overwrite a late file. The detailed command installation keeps its
owned rollback until unified finalization; ownership is not released early and
then reused to delete a later same-name entry.

Before the atomic staging-to-target rename succeeds, the original database has
never left its active path. Copy, validation, or rename failure therefore cleans
only this run's staging file and owned rollback claim; it must never unlink or
rename the active target. This avoids manufacturing a data-loss window while
claiming that the original database was unaffected.

Exact-entry absence is proved with `lstatSync`: only `ENOENT` means absent.
`existsSync` is not sufficient because it reports false for a broken symlink
whose directory entry still exists. Preflight and postcondition checks share
the same exact-entry helper.

The wait and filesystem operations are dependency-injected into a helper that
returns a closed structured result and never propagates raw filesystem errors.
Tests can therefore exercise transient and persistent failures without sleeping
or touching a live vault.

After the primary swap, the database rollback snapshot and WAL/SHM belong to the
completed transaction and are finalized even if vault-residual cleanup is
incomplete. The unified finalization result covers the exact `.pre-restore`,
`.rollback`, `-wal`, and `-shm` entries. Any entry that cannot be removed and
proved absent makes the result incomplete. DB-only restore uses the same final
postcondition for its applicable database artifacts.

`register` accepts an optional internal dependency seam for the finalizer and
restore temp-directory factory. Production uses the real implementations. Tests
invoke a real Commander action with injected failure; no environment-variable
fault hook is shipped.

## 3. Outcomes

### Clean

- restored database and active vault remain installed;
- `.pre-restore`, `.rollback`, WAL, and SHM are absent;
- command prints the existing success messages and exits zero.

### Cleanup incomplete

- restored database and active vault remain installed and are not rolled back;
- after the bounded attempts, no further deletion or rollback is attempted and
  whatever residual content still exists is left in place;
- command emits one fixed `RESTORE_CLEANUP_INCOMPLETE` diagnostic;
- diagnostic contains no path, vault content, filename sample, stack trace, or
  credential;
- command does not print database/vault success or the normal sync instruction;
- command sets a non-zero exit status;
- if `.pre-restore` or `.rollback` remains, the existing exact-entry preflight
  guard blocks a later restore until it is inspected and manually removed;
- a WAL/SHM cleanup failure makes the current restore non-zero and requires
  services to stay stopped, but ordinary WAL/SHM presence is not reclassified
  as a preflight residual and does not extend that guard.

Recursive removal can delete some children before the filesystem reports an
error. Therefore cleanup-incomplete guarantees preservation of the remaining
residual at the point attempts stop, not byte-for-byte preservation of the
original old vault. Avoiding partial recursive deletion would require an
additional full snapshot and is outside this bounded reliability fix.

The diagnostic tells the operator to keep services stopped, consult the restore
runbook, inspect the residual, and remove it only after deciding its contents
are no longer needed.

## 4. File Provider boundary

Restore owns only its exact `.pre-restore` and database transaction artifacts.
It never scans for or deletes numbered/misplaced sibling directories. Those are
observability and operator-cleanup candidates under #341. Documentation must
make this split explicit and forbid automatic deletion of such siblings.

## 5. Test contract

Tests are written red-first and cover:

1. exact residual cleanup succeeds and is verified;
2. first removal fails, the bounded retry succeeds, and attempts stay bounded;
3. persistent removal failure returns cleanup-incomplete, preserves the active
   restored vault and whatever old-vault content remains, and never exposes it;
4. partial recursive deletion followed by failure does not trigger rollback or
   further unbounded deletion;
5. rollback and WAL/SHM deletion failures independently fail the finalization;
6. a real Commander action with injected finalization failure sets exit code 1,
   emits only the fixed cleanup diagnostic, emits no success/sync message, and
   still removes its extraction temp directory through `finally`;
7. that same command test seeds distinct old and restored DB/vault markers and
   proves cleanup-incomplete leaves the restored DB and vault active and usable,
   keeps remaining old-vault content only in the residual, removes `.rollback`,
   and never enters the rollback path;
8. persistent failure records exactly three removal attempts and waits of
   `[50, 150, 300]` with no fourth attempt; transient success stops immediately
   without later attempts or waits;
9. normal full restore leaves no `.pre-restore`, `.rollback`, WAL, or SHM;
10. a synthetic File Provider-style path containing spaces is exercised through
   an argument-array subprocess boundary, not shell string interpolation;
11. broken-symlink residuals are detected by both preflight and postcondition;
12. an existing residual still blocks a later restore without deletion.
13. TOCTOU tests create non-empty `.pre-restore` and `.rollback` entries after
    preflight when no old vault/database existed; both remain verify-only,
    produce cleanup-incomplete, and are neither deleted nor adopted.
14. With an existing database, a late unowned `.rollback` makes the exclusive
    claim fail before swap; the current DB and late file remain unchanged and
    the command returns non-zero through `finally`.
15. An initially absent verify-only artifact that materializes during another
    artifact's stabilization wait is re-added to the postcondition and prevents
    false success.
16. Injected pre-swap rename failure records filesystem calls and proves the
    active target is never unlinked or restored from rollback; only owned
    staging/rollback artifacts are cleaned.

## 6. Non-goals

- no backup format or LanceDB restore change;
- no automatic deletion of unmanaged or numbered sibling directories;
- no recursive parent scan;
- no attempt to control File Provider conflict resolution;
- no #342 backfill retry;
- no broad restore-command refactor.
