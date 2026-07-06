# Explore Grid Status Audit

Date: 2026-07-05

## Scope

Adversarial review of the Explore character grid loading, empty, error, and retry states from the user's point of view.

## Finding

The shared grid had visible loading/error/empty text, but those states did not expose a stable product-test contract or explicit live-region semantics. Chrome also exposed a contradictory failure state: when a fresh search failed after cards were already loaded, the page showed `Could not load characters.` while still rendering the previous character cards.

## Fix

- `CharacterGrid` now exposes loading and empty states as `data-testid="character-grid-status"` with `role="status"` and `aria-live="polite"`.
- `CharacterGrid` now exposes load failures as `data-testid="character-grid-status"` with `role="alert"` and `aria-live="assertive"` plus Retry.
- `ExploreWorkspace` now clears stale cards and cursor metadata when a fresh non-pagination character load fails. Pagination failures can still preserve the current list.
- Focused E2E now covers initial failure, Retry to empty results, and the stale-card regression when a later search request fails.

## Chrome Evidence

- `01-explore-ready.png` / `01-explore-ready.json`: baseline Explore render with 16 character cards, two search inputs, no horizontal overflow.
- `02-explore-forced-error.png` / `02-explore-forced-error.json`: forced server outage exposed the alert semantics and the stale-card contradiction that was then patched.
- `03-explore-clean-empty.png` / `03-explore-clean-empty.json`: post-patch clean empty search result with 0 character links, `role="status"`, `aria-live="polite"`, no horizontal overflow.

Chrome wrapper dev logs for the final clean empty-state pass contained only React DevTools/HMR development messages.

## Verification

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3264 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 BULLMQ_PREFIX=idream:e2e:3264-explore-grid bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "explore character grid"
bun run --cwd packages/main lint -- src/components/ourdream/CharacterGrid.tsx src/components/ourdream/ExploreWorkspace.tsx src/e2e/ui-workflows.e2e.ts
bun run typecheck
```

Results:

- Focused Explore grid E2E: 1/1 passed.
- Lint: passed.
- Typecheck: 6/6 packages passed.
