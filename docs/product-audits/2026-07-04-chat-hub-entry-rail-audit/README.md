# Chat Hub Entry Rail Audit

Date: 2026-07-04

## Scope

Chrome and focused E2E verification for `/chat` as a primary product navigation entry, covering signed-out and signed-in empty states.

## Finding

Before this pass, `/chat` behaved correctly as a session hub but had a thin empty/signed-out experience: users could authenticate or jump to Explore/Create, but the page did not expose concrete character-start paths from the hub itself.

## Fix

`ChatHubWorkspace` now keeps the existing session-list contract and adds a compact `Start a conversation` panel with real featured character routes plus Explore/Create actions. The signed-out card copy now explains the value of logging in without changing the auth-return behavior.

## Evidence

- `01-chat-hub-signed-in-empty.png` / `.json`: signed-in empty hub shows `No chats yet`, `Start a conversation`, three featured character cards, Explore/Create actions, and console warning/error count `0`.
- `02-chat-hub-signed-out-entry-rail.png` / `.json`: signed-out hub shows `Sign in to see your chats`, `/login?next=%2Fchat`, `/signup?next=%2Fchat`, three featured character cards, Explore/Create actions, and console warning/error count `0`.
- `03-chat-hub-character-route.png` / `.json`: clicking the Melissa Burke featured card lands on `/characters/melissa-burke` with Chat/Generate actions available and console warning/error count `0`.

## Automated Check

```bash
PW_BASE_URL=http://127.0.0.1:3234 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "chat hub signup redirect returns anonymous user to the hub"
```

Result: `1 passed`.
