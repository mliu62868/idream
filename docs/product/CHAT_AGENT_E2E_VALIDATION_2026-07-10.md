# Chat Agent SQL + E2E Validation — 2026-07-10

## Scope

Validation target: local `idream` PostgreSQL on port 5433, the `chat_service`
runtime role, local Redis, the PM2 `chat` process, the configured OpenAI-compatible
chat model, and the running Main event consumer.

## SQL deployment

Applied `db/sql/03_chat_tables.sql` as `chat_owner`, then regenerated the Chat
Prisma client. The deployed schema was inspected through PostgreSQL:

- `chat.messages.reply_to_message_id`: `text`, nullable for legacy rows.
- `chat.messages.memory_extracted_attempt`: `integer NOT NULL DEFAULT 0`.
- `messages_reply_to_idx` and `messages_status_updated_idx` exist.
- `chat_service` can read/write `chat.*` and read the four authority views.
- A direct `chat_service` read of `public.users` is rejected.

The repository-wide `apply-validate.sh` was not used as the migration mechanism:
its attempt to recreate an older `core.chat_character_view` fails against the
newer expanded view (`cannot drop columns from view`). The scoped Chat DDL is
idempotent and completed successfully without replacing Main-owned views.

## Live conversation evidence

`probe-chat-service.ts` passed against `http://127.0.0.1:3100` using signed BFF
requests. Evidence from the final run:

- Health: 200, service `chat`.
- Signed session request: 200; unsigned request: rejected with 401.
- Create session: 201.
- Send message: 202.
- SSE observed `start`, `delta`, and `done`.
- GET session found the exact assistant message in `sent` state with non-empty content.
- Incognito turn completed while memory was disabled, then the probe restored the session.
- Blocked-input turn returned 202 with `status=blocked` and no stream.

The standalone real-model probe also passed: provider `openai`, one non-template
completion chunk, terminal `done=true`.

## Deep invariant evidence

For the live normal assistant turn, direct authority checks confirmed:

- `status=sent`, `attempt=1`.
- `reply_to_message_id` resolves to the exact `role=user`, `status=sent` turn.
- Exactly one selected `message_versions` row exists.
- An output moderation row exists with `status=passed`.
- `memory_extracted_attempt=1`; the relationship projection file exists.
- The subsequent incognito assistant has `memory_extracted_attempt=0`.
- The Redis stream contained 18 events and had approximately 24 hours of TTL remaining.
- `chat.message.completed` moved to `delivered` immediately with zero failed attempts.
- Main's `recent_chats` projection contains the Chat session, user, character, active
  status, and a populated `lastMessageAt`.

## Automated verification

- Chat: 20 test files, 152 tests passed.
- Full repository lint, typecheck, and production build passed.
- Full repository test run: Chat, Shared, and Gen passed. Main passed 467/468;
  the single `gaps.test.ts` remix-provenance failure passed when rerun alone, so it
  is classified as an unrelated order/flakiness issue rather than a Chat regression.
