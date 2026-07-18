-- Additive live upgrade for durable Chat send idempotency.
-- RUN AS: chat_owner. Safe to re-run.
CREATE TABLE IF NOT EXISTS chat.chat_send_receipts (
  id                   text PRIMARY KEY,
  user_id              text NOT NULL,
  session_id           text NOT NULL REFERENCES chat.chat_sessions(id) ON DELETE CASCADE,
  idempotency_key      text NOT NULL,
  request_hash         text NOT NULL,
  user_message_id      text NOT NULL,
  assistant_message_id text NOT NULL,
  response_status      text NOT NULL,
  safety_policy_code   text,
  created_at           timestamp NOT NULL DEFAULT (timezone('utc', now())),
  CONSTRAINT chat_send_receipts_response_status_check
    CHECK (response_status IN ('generating', 'blocked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_send_receipts_user_idempotency_key
  ON chat.chat_send_receipts (user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS chat_send_receipts_session_idx
  ON chat.chat_send_receipts (session_id);
