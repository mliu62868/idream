# App Search Status Audit

Date: 2026-07-05

Scope: Chrome end-to-end verification for the app-shell global search suggestion panel on `/generate?characterId=melissa-burke`.

## Finding

Before the fix, a no-result global search query rendered visible feedback inside the suggestion panel:

- Text: `No suggestions found`
- Search input type: `search`
- Search input `aria-controls`: `app-search-suggestions`
- Search input `aria-describedby`: `null`
- Panel `role`: `listbox`
- Feedback `role`: `null`
- Feedback `aria-live`: `null`
- Feedback `data-testid`: `null`
- Console errors/warnings: `0`

The result was visible, but not connected to the input and not exposed as a live status.

## Fix Verification

After the fix, the same Chrome flow produces:

- Text: `No suggestions found`
- Search input type: `search`
- Search input `aria-controls`: `app-search-suggestions`
- Search input `aria-describedby`: `app-search-status`
- Panel `role`: `listbox`
- Feedback `role`: `status`
- Feedback `aria-live`: `polite`
- Feedback `data-testid`: `app-search-status`
- Console errors/warnings: `0`

Focused global search E2E now covers character suggestions, guide-route suggestions, and the empty-suggestions status contract.

## Artifacts

- `01-current-no-suggestions-status.png`
- `current-app-search-evidence.json`
- `current-app-search-console-logs.json`
- `02-fixed-no-suggestions-status.png`
- `fixed-app-search-evidence.json`
- `fixed-app-search-console-logs.json`
