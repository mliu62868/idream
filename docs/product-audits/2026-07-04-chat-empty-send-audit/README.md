# Chat Empty Send Audit

Date: 2026-07-04

Scope: adversarial PM check of the signed-in chat composer on a live local Chrome session.

## Finding

Before the fix, an empty chat composer exposed an enabled `Send message` button. Clicking it produced no visible status, no submitted message, and left the user with an apparently broken action.

Captured evidence:

- `current-chrome-evidence.json`
- `01-current-empty-send-enabled.png`
- `02-current-empty-send-after-click.png`

## Fix

The chat composer now derives button state from the same guard used by submit:

- empty input: disabled
- whitespace-only input: disabled
- non-empty trimmed text: enabled unless a send is pending

Regression coverage was added to the existing character-detail chat journey so the same test still proves the full send, report, assistant reply, and reload-persistence path.

## Verification

- Chrome post-fix evidence: `fixed-chrome-evidence.json`
- Screenshots: `03-fixed-empty-send-disabled.png`, `04-fixed-send-enabled-after-typing.png`
- Focused E2E: `PW_BASE_URL=http://127.0.0.1:3236 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "chat UI starts from character detail, sends a message, and persists history"` passed 1/1.
- Scoped lint: `bun run --cwd packages/main lint -- src/components/ourdream/ChatSessionClient.tsx src/e2e/ui-workflows.e2e.ts` passed.
- Typecheck: `bun run typecheck` passed.
- Whitespace check: `git diff --check` passed.
