# Admin Announcement Create Confirmation Audit

Date: 2026-07-04

## Scope

Admin announcement creation on `/admin/announcements`, including API rejection for generic confirmation and the public banner rendered on `/`.

## Flow Captured

1. Empty confirmation: title/body/link/reason are present, but `Create` remains disabled.
2. Wrong confirmation: typing generic `ANNOUNCE` keeps `Create` disabled, and a direct API request with the same generic confirmation returns 400 without creating `announcements`.
3. Ready state: typing the exact announcement title enables `Create`.
4. Created state: the announcement row appears in the admin table and the active item persists to AppSetting.
5. Public banner: the home page renders the active banner with its internal Help Desk link.

## UX Findings

- Public announcement creation now has a target-specific pause before a sitewide banner can go live.
- The confirmation target is the actual title the operator just authored, so generic tokens from other announcement actions cannot create a banner.
- The public screenshot includes the existing promotional modal; that modal is outside this slice, while the top announcement banner and link are visible and verified.

## Accessibility Notes

- The new confirmation field has an accessible name: `Announcement create confirmation`.
- The disabled/enabled button state is visible and covered by the focused browser test. A full accessibility claim would still require keyboard-only and screen-reader announcement checks.

## Evidence

- `01-announcement-create-confirmation-empty.png`
- `02-announcement-create-confirmation-wrong.png`
- `03-announcement-create-confirmation-ready.png`
- `04-announcement-created.png`
- `05-public-announcement-banner.png`
- `chrome-evidence.json`
