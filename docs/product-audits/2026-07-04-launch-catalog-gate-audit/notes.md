# Launch Catalog Gate Audit

Date: 2026-07-04

## Finding

Adversarial launch review found a gate omission: `probe:catalog` existed and the product docs required it before demos/launch, but `check:launch` did not require `PUBLIC_CATALOG_PROBE_REPORT`. A dirty public catalog could therefore fail the catalog probe while still being invisible to the final launch gate.

## Change

- Added `public-catalog-live-probe` to `packages/main/src/server/launch-readiness.ts`.
- The gate now requires `PUBLIC_CATALOG_PROBE_REPORT`, validates report freshness, and fails when public characters, public collections, public creators, distinct images, or catalog issue totals are not launchable.
- Added `PUBLIC_CATALOG_PROBE_REPORT` and `PUBLIC_CATALOG_PROBE_MAX_AGE_MINUTES` to `packages/main/.env.production.example`.
- Updated `docs/product/PRODUCTION_SECRET_CHECKLIST.md` and `docs/architecture/10-operations.md`.
- Added focused Vitest coverage for missing, failing, stale, empty, and passing catalog evidence.

## Evidence

- `public-catalog-probe.json`: `ok=true`, 16 public characters, 3 public collections, 13 public creators, 16 distinct images, 0 issues.
- `check-launch-current-root.json`: current shell remains red at `7 pass / 50 fail / 2 warn`; `public-catalog-live-probe` fails because `PUBLIC_CATALOG_PROBE_REPORT` is not set in the shell.
- `check-launch-production-example-fresh.json`: production example remains red at `31 pass / 34 fail / 0 warn`; `public-catalog-live-probe` passes, remaining failures are production env/provider/live-probe blockers.

## Verification

```bash
bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json
bun run --cwd packages/main test src/server/launch-readiness.test.ts
bun run typecheck
bun run check:launch -- --json
bun run check:launch:direct -- --launch-env-file packages/main/.env.production.example --json
```
