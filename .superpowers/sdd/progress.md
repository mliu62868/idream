# Chat Service Capability Completion — Progress Ledger

Plan: docs/product/CHAT_SERVICE_CAPABILITY_COMPLETION_PLAN.md
Branch: master (direct, per user global instructions)

## Phase 1 — P0 semantic fixes
- [x] P0-D: policy model → provider (env aliases, ChatModel.stream model, generate passes policy.model)
- [x] P0-C: free daily 30 quota (day period in service + finalize)
- [x] P0-E: no-memory skips session.jsonl
- [x] P0-G: boundaries non-degradable (split read, fail-closed)
- [x] P0-B: blocked send protocol (status, null streamUrl, BFF adapter, UI)
- [x] P0-A: dispatchV1 503 for chat/messages when unset + env/README
- [x] P0-F: inbox user.deleted → account erasure + main enqueue

## Phase 2 — P1 UI (parallel subagents)
[x] P1-A UI components (subagent)
[x] Upgrade/Profile copy
[x] Generate link

## Phase 3 — P1-B/C + probe + docs + E2E
[x] P1-B relationship injection + reset
- [ ] memory quality (defer-heavy parts)
[x] probe expanded
[x] docs synced
[x] E2E added (needs stack)

## FINAL STATUS (2026-06-27)
Phase 1 (P0 A–G): DONE + tested.
Phase 2 (P1 UI): DONE — ChatHeaderControls, MessageActions, SessionListDrawer, MemoryPanel,
  RelationshipBadge, MemoryToggle (subagent, owns ChatSessionClient + chat/*); Upgrade/Profile
  chat copy; Chat→Generate deep link.
Phase 3: P1-B relationship injection DONE+tested; probe-chat-service e2e smoke expanded;
  docs synced (PRD blocked-response); §10.3 management E2E added (needs running stack).
P1-C semantic memory upgrade: NOT done (plan frames it as a path; deferred — heaviest item).
Verification: chat 61 tests, main 190 tests, all typecheck+lint green, main production build green.
