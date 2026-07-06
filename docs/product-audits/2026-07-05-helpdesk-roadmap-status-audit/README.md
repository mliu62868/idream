# Help Desk Roadmap Status Audit

Date: 2026-07-05

## Scope

Adversarial Chrome review of the public Help Desk roadmap voting panel.

## Findings

- The roadmap list had submission/vote status feedback, but the list loading/empty/error states were not a separate stable contract.
- Chrome also exposed three old public roadmap fixture items with `Chrome ...` audit copy.

## Fix

- Roadmap list loading/empty/error states now use `data-testid="feedback-list-status"`.
- Loading and empty states use `role="status"` with `aria-live="polite"`.
- Load failures use `role="alert"` with `aria-live="assertive"` and inline `Retry`.
- The roadmap header now exposes `Refresh roadmap items` so users can manually reload stale votes.
- `probe:catalog` now checks public Help Desk roadmap feedback items for fixture markers.
- The three local public fixture feedback items were removed.

## Evidence

- `01-roadmap-ready.png` / `.json`: Chrome first exposed public roadmap fixture copy.
- `public-catalog-probe-before.json`: strengthened probe failed with 5 launch-blocking issues across 3 feedback items.
- `02-roadmap-clean-ready.png` / `.json`: after cleanup, Chrome showed 3 clean roadmap items, fixture matches `[]`, no horizontal overflow.
- `03-roadmap-refresh-error.png` / `.json`: with the dev server stopped, Chrome refresh exposed `feedback-list-status` as `role="alert"` + `aria-live="assertive"` with `Retry` and no stale item cards.
- `04-roadmap-recovered.png` / `.json`: after server restart, Chrome recovered to 3 clean roadmap items with warning/error logs `[]`.
- `public-catalog-probe-after.json`: after cleanup, probe passed with 16 public characters, 3 public collections, 13 public creators, 3 public feedback items, 16 distinct images, and 0 issues.

The Chrome dev server reconnect auto-recovered the panel after restart before the Retry button could be clicked. The focused E2E covers the actual Retry click.

## Verification

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3268 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 BULLMQ_PREFIX=idream:e2e:3268-helpdesk-roadmap bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "help desk submits a tracked support request"
bun run --filter @idream/main probe:catalog -- --report .tmp/public-catalog-probe-helpdesk-after.json
bun run --filter @idream/main test -- src/server/launch-readiness.test.ts
bun run --cwd packages/main lint -- src/components/ourdream/HelpDeskWorkspace.tsx src/e2e/ui-workflows.e2e.ts src/server/probe-public-catalog.ts src/server/launch-readiness.ts src/server/launch-readiness.test.ts
bun run typecheck
```

Results:

- Focused Help Desk E2E: 1/1 passed.
- Public catalog probe after cleanup: passed, 0 issues.
- Launch readiness tests: 61/61 passed.
- Lint: passed.
- Typecheck: 6/6 packages passed.
