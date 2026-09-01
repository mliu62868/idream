# Admin navigation fix regression — 2026-08-31

## Result

- 1272×841: persistent desktop sidebar is visible; the drawer trigger is absent.
- Platform Operations menu: `clientHeight=581`, `scrollHeight=581`; Presets and Workflow Diagnostics are both visible without scrolling.
- 390×844: document `clientWidth=390`, `scrollWidth=390`; no page-level horizontal overflow.
- Mobile dead-letter rows render as decision cards. Failure reason, replay authority, ledger state, cost, and updated time precede Requeue / Discard.
- Keyboard Escape and pointer opening were rechecked; Chrome console contained no errors.
- Support loading: the list endpoint was not the bottleneck (`34ms` through Admin, `26ms` in Main; saved views `508ms` / `504ms`). The earlier 20-second observation was inflated by repeated full-DOM snapshots. The remaining multi-second delay is shared dev-mode Admin SSR, not Support list loading.

## Evidence

- `01-desktop-1272-dead-letter.png`
- `02-desktop-platform-menu.png`
- `03-mobile-dead-letter-context.png`
- `04-mobile-dead-letter-viewport.png`

## Automated verification

- Focused behavior tests: 36 passed.
- Full Admin suite: 1034 passed, 2 pre-existing dirty-worktree failures.
- TypeScript: passed.
- Production build: passed.
- ESLint: 0 errors, 7 pre-existing warnings.
