# Admin Generation Config Confirmation Audit

Date: 2026-07-04

Scope:
- `/admin/generation/config`
- `/admin/insights`
- `POST /api/v1/admin/generation/model-profiles/:id/dry-run`
- `POST /api/v1/admin/generation/model-profiles/:id/test-job`
- `POST /api/v1/admin/generation/model-profiles/:id/publish`
- `POST /api/v1/admin/generation/model-profiles/:id/rollback`
- `PATCH /api/v1/admin/generation/model-profiles/:id`
- `POST /api/v1/admin/generation/prompt-templates/:id/publish`
- `POST /api/v1/admin/generation/prompt-templates/:id/rollback`

Finding:
- Generation config actions previously used generic confirmation tokens such as `DRYRUN`, `TEST`, `PUBLISH`, `ROLLBACK`, and `DISABLE`.
- These operations affect model rollout, prompt templates, and test generation jobs, so confirmation must bind to the exact profile/template id being changed.

Change:
- Model profile dry-run, test-job, publish, rollback, and disable now require confirmation equal to the profile id.
- Prompt template publish and rollback now require confirmation equal to the template id.
- `/admin/generation/config` action modals now display the concrete id as the required confirmation and submit the operator's typed value.
- `/admin/insights` dry-run confirmation now requires the concrete profile id; `DRYRUN` remains disabled client-side and rejected server-side.

Chrome Evidence:
- `dryrun-generic-disabled.png`: `DRYRUN` leaves the action modal Confirm disabled.
- `publish-generic-disabled.png`: `PUBLISH` leaves the publish Confirm disabled.
- `published-with-profile-id.png`: the exact profile id publishes the draft profile.
- `rollback-generic-disabled.png`: `ROLLBACK` leaves rollback Confirm disabled.
- `chrome-evidence.json`: records the tested active/draft profile ids, rejected generic tokens, accepted exact id, and console failure state.

Verification:
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "publishes and rolls back model profiles|rejects model profile publish|rejects image model profile publish|rejects managed image model publish|rejects image model publish when runtime|does not let manual consistency|only allows active model profiles|keeps manual model profile|accepts managed sd_cpp|fails dry-run|creates zero-cost admin test image|normalizes legacy sd_cpp|publishes prompt templates|admin generation health"`
- `bun run --filter @idream/main typecheck`
- `bun run --filter @idream/main lint`
- `bun run --filter @idream/admin typecheck`
- `bun run --filter @idream/admin lint`
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3198 PW_ADMIN_BASE_URL=http://127.0.0.1:3197 bun --cwd packages/main playwright test src/e2e/admin-web.e2e.ts -g "admin insights dry-run UI requires typed confirmation"`
- Temporary Chrome evidence spec passed, then was removed.
