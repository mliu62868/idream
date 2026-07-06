# Admin Announcement Action Confirmation Audit

Date: 2026-07-04

Scope:
- `/admin/announcements`
- `PATCH /api/v1/admin/announcements/:id`
- `DELETE /api/v1/admin/announcements/:id`

Finding:
- Announcement create already required exact title confirmation, but update/delete still accepted generic `ANNOUNCE` / `DELETE`.
- These actions affect the sitewide banner surface, so update/delete should bind to the exact announcement id.

Change:
- Announcement update now requires exact announcement id confirmation.
- Announcement delete now requires a JSON body with exact announcement id confirmation; bare DELETE no longer mutates.
- The admin action panel shows the announcement id as the required confirmation target and no longer advertises generic tokens.

Chrome Evidence:
- `update-generic-disabled.png`: `ANNOUNCE` keeps Confirm update disabled.
- `updated.png`: exact announcement id deactivates the banner.
- `delete-generic-disabled.png`: `DELETE` keeps Confirm delete disabled.
- `deleted.png`: exact announcement id deletes the row.
- `chrome-evidence.json`: records the announcement id, rejected/accepted confirmations, audit actions, and screenshot paths.

Verification:
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "admin announcements"`
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3198 PW_ADMIN_BASE_URL=http://127.0.0.1:3197 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin announcements UI"`
- Temporary Chrome evidence spec passed, then was removed.
