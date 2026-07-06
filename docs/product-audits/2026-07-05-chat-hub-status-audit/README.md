# Chat Hub Status Audit

Date: 2026-07-05

## Finding

`/chat` already had a retryable load-error UI, but the Chat Hub status surface was not locked as a stable product contract. Loading feedback needed an explicit polite live region and the API-failure path needed an assertive alert with focused retry coverage.

## Fix

- `ChatHubWorkspace` now exposes loading feedback through `data-testid="chat-hub-status"`, `role="status"`, and `aria-live="polite"`.
- The retryable error state now exposes `data-testid="chat-hub-status"`, `role="alert"`, and `aria-live="assertive"`.
- Focused E2E now forces the first `/api/v1/chat/sessions` request to return 500, verifies the assertive alert semantics, clicks `Retry`, and verifies the normal empty hub/start-panel recovery.

## Evidence

- `01-chat-hub-current.png`: Chrome capture of the current signed-in `/chat` hub.
- `01-chat-hub-current.json`: DOM/state sample from Chrome; current ready state had 3 session cards, the start panel visible, no horizontal overflow, and no active status node.
- `02-chrome-console-logs.json`: Chrome warning/error capture, `[]`.

## Commands

```bash
PW_BASE_URL=http://127.0.0.1:3258 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "chat hub"
bun run --cwd packages/main lint -- src/components/ourdream/ChatHubWorkspace.tsx src/e2e/ui-workflows.e2e.ts
bun run typecheck
```
