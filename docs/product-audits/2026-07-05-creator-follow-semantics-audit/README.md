# Creator Follow Semantics Audit

Date: 2026-07-05

Scope: Chrome end-to-end verification for the Creator Profile Follow toggle on `/creators/seed-creator-some1cool`.

## Finding

Before the fix, the creator profile Follow control was a stateful toggle but rendered without pressed state:

- Text: `Follow`
- Tag: `BUTTON`
- `aria-pressed`: `null`
- Console errors/warnings: `0`

The same component also exposed `creator-profile-status` without live-region semantics when status text was present.

## Fix Verification

After the fix, the same Chrome flow produces:

- Before toggle: `Follow`, `aria-pressed="false"`
- After toggle: `Following`, `aria-pressed="true"`
- Console errors/warnings after clean dev-server restart: `0`

The creator profile status fallback now also uses `role="status"` with `aria-live="polite"`.

## Artifacts

- `01-current-follow-toggle-no-pressed.png`
- `current-chrome-evidence.json`
- `current-console-logs.json`
- `02-fixed-follow-toggle-pressed.png`
- `fixed-chrome-evidence.json`
- `fixed-console-logs.json`
