# Chat Quota -> Upgrade Return Audit

Date: 2026-07-04

## Scope

Adversarial PM/UX audit of the free daily chat quota boundary when a user upgrades from an active chat session.

Target flow:

1. Signed-in free user reaches the 30-message daily cap.
2. User sends a draft in `/chat/:sessionId`.
3. Chat shows the quota message, keeps the draft, and offers Upgrade.
4. Upgrade activation preserves the original chat session as the return target.
5. User lands back in the same chat session with the composer available.

## Finding

Before the fix, the quota CTA linked to bare `/upgrade`. That allowed payment activation but lost the originating `/chat/:sessionId`, so the success CTA could not return the user to the conversation that triggered the upgrade.

Chrome evidence:

- `screenshots/01-quota-upgrade-before.png`

## Fix

- `ChatSessionClient` now sends quota upgrades to `/upgrade?returnTo=/chat/:sessionId`.
- `UpgradeWorkspace` now labels the success CTA from chat return targets as `Continue chat`.
- The chat composer input now has stable `id` and `name` attributes so the clean returned page has no DevTools form-field issue.
- The focused E2E quota test now covers quota block -> Upgrade return target -> Premium monthly demo activation -> `Continue chat` -> same session return.

## Chrome Evidence

Origin: `http://chat-quota-upgrade-return-1783161349.localhost:3128`

Session: `/chat/sess_3e13d5a2e78e4541a615c9962e01ee1e`

Screenshots:

- `screenshots/01-quota-upgrade-before.png`
- `screenshots/02-quota-upgrade-after.png`
- `screenshots/03-upgrade-success-continue-chat-after.png`
- `screenshots/04-returned-chat-after.png`

Post-fix Chrome result:

- Quota status: `Daily free message limit reached.`
- Draft retained in the composer before navigating to Upgrade.
- Upgrade link: `/upgrade?returnTo=%2Fchat%2Fsess_3e13d5a2e78e4541a615c9962e01ee1e`
- Premium monthly activation: `Premium monthly is active. 1,500 dreamcoins were added.`
- Success CTA: `Continue chat`
- Success CTA href: `/chat/sess_3e13d5a2e78e4541a615c9962e01ee1e`
- Final URL: `/chat/sess_3e13d5a2e78e4541a615c9962e01ee1e`
- Final clean reload console: no warnings, errors, or issues.

## Verification

Run after the implementation:

```bash
PW_BASE_URL=http://127.0.0.1:3128 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "chat UI preserves input and shows upgrade path at the free daily limit|upgrade UI activates Premium"
bun run --filter @idream/main lint
bun run --filter @idream/main typecheck
git diff --check
```
