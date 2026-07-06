# Admin Content/Ops Confirmation Audit

Date: 2026-07-04

## Audit Scope

Admin package flows that either affect public content or gate pre-publish operations:

- `/admin/cms` publish and unpublish
- `/admin/announcements` deactivate and delete
- `/admin/insights` profile dry-run

User goal: an operator can complete public-content state changes and pre-publish dry-runs without browser-native prompt dialogs, with clear inline confirmation, audit reasons, and visible state feedback.

## Finding

The current Admin CMS, Announcements, and Insights dry-run surfaces still used `window.prompt` for operator reasons. That created inconsistent UI, weak accessibility labels, and no reliable visual state for end-to-end audit screenshots. It also left update/destructive/pre-publish workflows harder to validate from the product surface even though the backend already expected reason/confirmation data.

## Fix

- CMS publish/unpublish now opens an inline confirmation panel with reason plus typed confirmation. The submit button stays disabled until the reason is at least 3 characters and confirmation is either `PUBLISH` or the page path.
- Announcements activate/deactivate/delete now opens an inline confirmation panel with reason plus typed confirmation. Update accepts `ANNOUNCE` or announcement ID; delete accepts `DELETE` or announcement ID.
- Insights profile dry-run now opens an inline confirmation panel with reason plus typed confirmation. Dry-run accepts `DRYRUN` or model profile ID.
- Announcement DELETE now accepts an optional JSON body, validates confirmation when present, and persists the audit reason.
- Admin i18n gained labels and visible copy for the new controls.
- Focused E2E covers disabled state, wrong-confirmation rejection, successful state changes, no native dialogs, and announcement delete / dry-run audit reasons.

## Verification

Commands:

```bash
bun run --filter @idream/main lint
bun run --filter @idream/main typecheck
git diff --check -- packages/main/src/components/admin/AnnouncementsView.tsx packages/main/src/components/admin/CmsView.tsx packages/main/src/components/admin/i18n.tsx packages/main/src/server/modules/admin/announcements.ts packages/main/src/e2e/admin-web.e2e.ts
bun run test -- src/server/modules/ourdream/admin-console.test.ts -t "admin CMS"
bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "admin announcements"
bun run test -- src/server/modules/ourdream/admin-console.test.ts -t "admin generation health"
PW_BASE_URL=http://127.0.0.1:3160 PW_ADMIN_BASE_URL=http://127.0.0.1:3161 bun run test:e2e -- src/e2e/admin-web.e2e.ts -g "admin insights dry-run UI requires typed confirmation|admin CMS UI requires typed confirmation|admin announcements UI requires typed confirmation"
```

Results:

- Lint, typecheck, and diff whitespace checks passed.
- Backend CMS, announcement, and generation-health focused tests passed. The first attempted parallel run hit a test DB schema-reset race; the tests passed when rerun serially.
- Focused admin E2E passed: 3/3 tests.
- Google Chrome channel `149.0.7827.201` completed the same product flows with `dialogs=[]` and `consoleFailures=[]`; the only ignored console item was `/favicon.ico` 404.

## Chrome Evidence

Saved screenshots:

1. `screenshots/01-cms-publish-confirmation.png` - CMS publish confirmation panel is visible, wrong confirmation has been corrected, and submit is enabled.
2. `screenshots/02-cms-published.png` - The CMS row refreshes to `published`.
3. `screenshots/03-cms-unpublish-confirmation.png` - CMS unpublish confirmation accepts the page path.
4. `screenshots/04-announcement-deactivate-confirmation.png` - Announcement deactivate confirmation panel is visible and submit is enabled.
5. `screenshots/05-announcement-inactive.png` - The announcement row refreshes to `active=no`.
6. `screenshots/06-announcement-delete-confirmation.png` - Announcement delete confirmation panel is visible and submit is enabled.
7. `screenshots/07-announcement-deleted.png` - The announcement table refreshes to empty state.
8. `screenshots/08-insights-dry-run-confirmation.png` - Insights dry-run confirmation panel is visible and submit is enabled.
9. `screenshots/09-insights-dry-run-success.png` - Insights dry-run reports `Dry-run pass: 2/2 samples passed.`

Machine-readable evidence: `chrome-evidence.json` and `chrome-insights-evidence.json`.

## UX Notes

- The inline panels keep the operator in context and avoid a blocking native browser prompt.
- Buttons expose meaningful accessible names: `Confirm publish change`, `Confirm update`, `Confirm delete`, and `Delete announcement`.
- Insights dry-run now exposes named controls for model profile ID, reason, and confirmation.
- The state changes are visible in the same table row after submission.

## Evidence Limits

This audit proves local Admin behavior on the current dev server and Google Chrome channel. It does not prove production cache propagation, model quality, or concurrent multi-admin conflict handling.
