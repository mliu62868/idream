# Admin Featured Curation Confirmation Audit

Date: 2026-07-04

## Scope

Admin Featured curation on `/admin/content`, including the server API and the public Feed effect.

## Flow Captured

1. Empty confirmation: `Save featured` stays disabled while IDs and reason are present but the typed target is missing.
2. Wrong confirmation: typing generic `FEATURED` keeps `Save featured` disabled, and a direct API request with that value returns 400 without writing `feed.featured`.
3. Ready state: typing the exact normalized ID list enables `Save featured`.
4. Saved state: the admin table refreshes with the selected featured characters and audit log stores the operator reason plus resulting IDs.
5. Public Feed: `/feed` renders the selected featured characters before the normal popular list.

## UX Findings

- The operator now has a clear pause before changing public merchandising order.
- The confirmation copy matches the actual target instead of a generic action word, so accidental copy/paste from another admin flow does not submit.
- Clearing the list is still possible through the explicit `CLEAR` confirmation path.

## Accessibility Notes

- The new confirmation control has an accessible name, so the focused E2E and assistive technology can identify it as `Featured confirmation`.
- The disabled/enabled state is visible in the button state. Further keyboard-only and screen-reader announcement testing would still be needed for a full accessibility claim.

## Evidence

- `01-featured-confirmation-empty.png`
- `02-featured-confirmation-wrong.png`
- `03-featured-confirmation-ready.png`
- `04-featured-saved.png`
- `05-public-feed-featured-first.png`
- `chrome-evidence.json`
