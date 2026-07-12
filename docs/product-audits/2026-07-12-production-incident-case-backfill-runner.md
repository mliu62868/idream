# Production Incident and Case Backfill Runner

Date: 2026-07-12

## Scope and authority

The unified runner covers three production domains:

- `generation_incident_v1`: historical Generation Attempts to Incident correlation.
- `customer_case_v1`: Support Requests to typed Customer Cases and immutable Evidence.
- `review_case_v1`: Content Reports and Appeals to typed Review Cases and immutable Evidence.

The runner owns operational lifecycle and evidence: dry-run/apply mode, source high-water mark, keyset cursor, bounded batches, persistent pause/resume, crash continuation, idempotent rerun, per-item checksum, and final before/after/coverage/mismatch report with a canonical `reportHash`. Domain services only classify source records and apply one idempotent transformation.

## Migration readiness

No schema migration is required for this runner. It reuses the additive `AdminBackfillRun` and `AdminBackfillItem` tables already present in the production schema, including the existing mode/status checks, positive batch-size check, and unique `(runId, entityType, entityId)` item identity. The PostgreSQL integration gate exercises those production tables directly.

Fresh/repeat migration rehearsal remains a release-level Gate; this change neither adds nor alters a migration. Production execution must use a dedicated snapshot after that rehearsal has passed.

## Operator commands

Run from the repository root. New runs default to dry-run; the explicit flag is retained below for audit clarity.

```bash
bun --cwd packages/main run admin:backfill:operations -- --domain generation_incident_v1 --dry-run --continuous --actor-id <operator-id>
bun --cwd packages/main run admin:backfill:operations -- --domain customer_case_v1 --apply --batch-size 250 --continuous --actor-id <operator-id>
bun --cwd packages/main run admin:backfill:operations -- --domain review_case_v1 --apply --batch-size 250 --continuous --actor-id <operator-id>
```

A non-continuous invocation processes one batch and persists a paused run. Resume only from persisted options:

```bash
bun --cwd packages/main run admin:backfill:operations -- --run-id <admin-backfill-run-id> --continuous
```

Do not provide domain, mode, actor, cursor, stop-at, or batch-size again when resuming. They are bound to the persisted run and options hash.

Exit codes are operationally significant:

- `0`: batch/run completed without mismatches, or paused cleanly after a batch.
- `1`: invalid arguments or infrastructure failure.
- `2`: the persisted report contains one or more mismatches; cutover must stop.

## Readiness and rollback procedure

1. Complete fresh, repeat, previous-app, and forward-fix migration rehearsal on the release candidate.
2. Run all three domains in dry-run mode against the dedicated production snapshot.
3. Inspect `AdminBackfillRun.before`, `after`, `summary`, `report`, and `reportHash`, plus every `AdminBackfillItem` classified `unavailable` or `mismatch`.
4. Resolve or explicitly reclassify every mismatch. A nonzero mismatch count or CLI exit `2` is a no-go.
5. Execute apply mode in bounded batches. Resume the same `runId` after interruption; do not start a replacement run to skip evidence.
6. Repeat each apply as a new run and verify zero duplicate Incident occurrences, Cases, Evidence, Audit records, or target-state changes.
7. Run §19.4 reconciliation and shadow checks. Cutover requires the dedicated snapshot to report zero unknown mismatches and all documented invariants green.

The mutation path is additive and idempotent. Operational rollback is to pause the durable run, preserve its run/items/report evidence, correct the source or transformation, and resume. Existing authority records are not destructively rewritten by the runner.

## Automated evidence

The focused PostgreSQL/process gate covers dry-run isolation, per-batch pause/resume, high-water keyset traversal, completed-run replay, idempotent apply rerun, mismatch exit `2`, all three domain transformations, and a database-triggered crash after the domain side effect but before item persistence followed by exact continuation without duplicate domain effects.

This is code and local integration evidence only. It must not be represented as proof that a production snapshot has already been backfilled or that the final production zero-mismatch Gate has passed.
