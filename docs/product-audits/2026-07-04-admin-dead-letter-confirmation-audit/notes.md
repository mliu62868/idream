# Admin Dead-letter Confirmation Audit

Date: 2026-07-04

Scope:
- `/admin/generation/dead-letter`
- `POST /api/v1/admin/generation/jobs/:id/requeue`
- `POST /api/v1/admin/generation/jobs/:id/discard`
- `POST /api/v1/admin/generation/dead-letter/requeue`
- `POST /api/v1/admin/generation/dead-letter/discard`

Finding:
- Dead-letter requeue/discard actions previously accepted generic `REQUEUE` and `DISCARD` confirmations.
- Discard can refund and mutate terminal job state, so the confirmation must bind to the selected job target.

Change:
- Single-job requeue/discard now require the exact job id.
- Batch requeue/discard now require the exact selected job id list, joined by commas in the same request order.
- The admin modal renders the same exact target confirmation and submits the typed value.

Chrome Evidence:
- `wrong-confirmation-disabled.png`: `DISCARD` leaves Confirm disabled.
- `discarded.png`: exact job id confirmation removes the row from Dead-letter.
- `chrome-evidence.json`: records the job id, accepted/rejected confirmation, final `refunded` status, refund delta, audit action, and screenshots.

Verification:
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "does not discard completed generation jobs|dead-letter operations console"`
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3198 PW_ADMIN_BASE_URL=http://127.0.0.1:3197 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin dead-letter queue"`
- Temporary Chrome evidence spec passed, then was removed.
