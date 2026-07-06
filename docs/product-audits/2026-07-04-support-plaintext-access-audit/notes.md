# Support Plaintext Access Audit

Date: 2026-07-04

## Scope

Adversarial operations check for the backend plaintext-view capability described in `docs/product/ADMIN_CONSOLE_PLAN.md`: support/admin staff with `support.plaintext.view` should have a usable operator entry, but every view must still require a per-target support consent grant or legal hold, an audit reason, and typed confirmation.

## Before

Code search found the backend gate and tests, but no admin UI caller:

- `POST /api/v1/admin/support/plaintext/view` existed and enforced permission, target lookup, active `SupportConsentGrant` or `LegalHold`, scope-limited fields, and `support.plaintext.view` audit logs.
- `AdminConsoleClient.tsx` listed the permission key and rendered Support Requests, but did not expose a plaintext access form.
- The only visible plaintext-related admin copy was Chat Ops' `Recent chat sessions (no plaintext)`.

This left an operations gap: the product had a guarded backend capability but no way for support staff to complete the workflow from the control plane.

## Fix

- Added a `Plaintext access` panel to `/admin/support`.
- The panel supports `generation_job` and `media` targets, matching the server contract.
- Operators must enter target id, ticket id or legal hold id, reason, and confirmation (`targetId` or `VIEW`).
- Results render only the fields returned by the server. Consent-scoped views therefore show authorized fields only.
- The server remains the final gate; no client-side shortcut or new backend permission path was added.
- Added Chinese admin translations for the new controls.
- Follow-up Chrome hardening: plaintext form controls now have stable `name` attributes, the request handler reads the submitted `FormData` at action time, the primary button calls the same request path directly, and the success/error status is exposed as a polite `role="status"` live region.

## Evidence

- `bun run --filter @idream/main lint`: passed.
- `bun run --filter @idream/main typecheck`: passed.
- Focused browser E2E: `PW_BASE_URL=http://127.0.0.1:3152 PW_ADMIN_BASE_URL=http://127.0.0.1:3153 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin support plaintext panel"` passed.
- E2E DB proof: a support user viewed a failed generation job through an active `SupportConsentGrant` scoped to `["prompt"]`; UI showed the prompt, did not show `negativePrompt`, and `AdminAuditLog.after` contained `ticketId` + `viewedFields` but not the prompt text.
- Backend gate regression: `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "support plaintext gate"` passed.
- Chrome end-to-end check: support dev login reached `/admin/support`, the `Plaintext access` panel rendered without layout overlap, a consent-scoped fixture was entered, `View plaintext` submitted, `Plaintext access logged.` appeared, the result showed only `prompt`, the seeded `negativePrompt` remained absent from the page, and Chrome console warnings/errors were `[]`. Screenshots: `screenshots/02-chrome-plaintext-panel-ready.png`, `screenshots/03-chrome-plaintext-form-filled.png`, `screenshots/04-chrome-plaintext-result.png`.
- Chrome DB proof: audit row `support.plaintext.view` for `chrome-plaintext-job-1783178323223-247373` recorded `ticketId=SUP-CP78323316`, `viewedFields=["prompt"]`, and the serialized audit payload did not contain either `Chrome consent scoped prompt 1783178323223-247373` or `Chrome redacted negative 1783178323223-247373`.

## Chrome Note

An initial rerun accidentally reused a stale admin dev server on `3001`, then an older Chrome tab stopped dispatching pointer/keyboard events to this form after several failed automation attempts. The accepted evidence above comes from a fresh admin dev server pair (`3152`/`3153`) and a fresh Chrome tab against the patched panel.

## Cleanup

Manual Chrome fixture `chrome-plaintext-job-1783178323223-247373`, owner `cmr6ic02f0000j7l7cl090g22`, consent grant `SUP-CP78323316`, and the matching audit row were deleted after evidence capture (`remaining=0` for audit/grant/job/user). The earlier fixture `chrome-plaintext-job-1783167883823-888543` was already deleted in the first pass.
