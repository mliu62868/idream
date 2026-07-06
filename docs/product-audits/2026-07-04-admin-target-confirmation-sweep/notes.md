# Admin Target Confirmation Sweep

Date: 2026-07-04

Surface: admin confirmation contracts across Support plaintext, Compliance, Content Ops, Official Character Templates, Tag Taxonomy, Review Queue, dual approvals, and role-change API.

## Finding

Several admin actions had already moved away from prompt dialogs, but some server/UI paths still accepted broad generic tokens such as `VIEW`, `ERASE`, `OVERRIDE`, `MERGE`, `APPROVE`, `REJECT`, `REVIEW`, `ROLE`, `ASSET`, `PLACEMENT`, `REGENERATE`, `PUBLISH`, and `OFFLINE`.

## Fix

- Support plaintext view now requires the exact target id; `VIEW` no longer enables/submits.
- Compliance erase and age-verification override now require the exact user id / verification id.
- Content production item review/regenerate, asset patch, placement patch, and bulk asset patch now require exact item/asset/placement/asset-list confirmation.
- Character template publish/offline now requires the exact template id; `PUBLISH`/`OFFLINE` no longer enables/submits.
- Tag merge now requires exact `sourceId:targetId`; `MERGE` is rejected.
- Review Queue decisions now require exact submission id; `REVIEW` is rejected.
- Dual approval requests require exact `targetId:action`; approval decisions require exact request id.
- Role-change API requires exact `userId:role`; `ROLE` is rejected.

## Chrome Evidence

Focused Chrome run:

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3198 PW_ADMIN_BASE_URL=http://127.0.0.1:3197 bun --cwd packages/main playwright test src/e2e/admin-web.e2e.ts -g "admin content ops requires confirmation|admin support plaintext panel|admin approval decisions require request-id confirmation|admin review queue approves|admin tag taxonomy metadata edits|admin compliance UI requires typed confirmations"
```

Result: 6 passed. The run proves generic tokens stay disabled for support plaintext, approval decisions, review queue approval, tag merge, and compliance erase/override, while exact target confirmations complete successfully.

Template publish/offline follow-up Chrome run:

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3198 PW_ADMIN_BASE_URL=http://127.0.0.1:3197 bun --cwd packages/main playwright test src/e2e/admin-web.e2e.ts -g "admin official characters and templates require inline confirmation"
```

Result: 1 passed. The run proves `OFFLINE` and `PUBLISH` keep template action buttons disabled, while the exact template id completes offline/publish successfully.

## Verification

- `bun run --filter @idream/main test -- src/server/modules/admin/characters/tags.test.ts src/server/modules/admin/characters/review.test.ts src/server/modules/ourdream/admin-console.test.ts -t "tag|review|production|support plaintext|dual-approval|writes are audited|compliance"`: pass, 22 passed / 41 skipped.
- `bun run --filter @idream/main test -- src/server/modules/admin/characters/templates.test.ts`: pass, 8 passed.
- `bun run --filter @idream/main lint`: pass.
- `bun run --filter @idream/main typecheck`: pass.
- `bun run --filter @idream/admin lint`: pass.
- `bun run --filter @idream/admin typecheck`: pass.
- `git diff --check`: pass.
