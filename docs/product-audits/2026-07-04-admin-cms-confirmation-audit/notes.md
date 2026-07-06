# Admin CMS Confirmation Audit

Date: 2026-07-04

Scope:
- `/admin/cms`
- `POST /api/v1/admin/cms/pages`
- `PATCH /api/v1/admin/cms/pages`
- `POST /api/v1/admin/cms/pages/publish`

Finding:
- CMS writes previously accepted generic `CMS` for create/update and generic `PUBLISH` for status changes.
- These are broad admin actions against public routes, so the typed confirmation should bind to the exact page path being changed.

Change:
- CMS create, update, publish, and unpublish now require confirmation equal to the page path.
- The create form now has an inline confirmation field and keeps `Create draft` disabled until the operator types the exact path.
- The publish/unpublish panel now rejects `PUBLISH` client-side and only enables after the exact page path is entered.

Chrome Evidence:
- `create-generic-disabled.png`: `CMS` leaves `Create draft` disabled.
- `created-with-path.png`: the exact path creates the draft page.
- `publish-generic-disabled.png`: `PUBLISH` leaves `Confirm publish change` disabled.
- `published-with-path.png`: the exact path publishes the page.
- `chrome-evidence.json`: records the tested route path, rejected generic tokens, accepted confirmation, and console failure state.

Verification:
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "admin CMS / SEO"`
- `bun run --filter @idream/main lint`
- `bun run --filter @idream/main typecheck`
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3198 PW_ADMIN_BASE_URL=http://127.0.0.1:3197 bun --cwd packages/main playwright test src/e2e/admin-web.e2e.ts -g "admin API Phase 3: CMS write|admin CMS UI requires typed confirmation"`
- Temporary Chrome evidence spec passed, then was removed.
