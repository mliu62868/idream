-- P0-1 boundary · chat authority tables (PRD §6). RUN AS: chat_owner.
-- IDs are app-generated cuids (text). No cross-schema FKs (independent-DB ready).
-- companion_memories / relationship_states are intentionally ABSENT — long-term
-- memory & relationship moved to the file layer (design §5). IDEMPOTENT.

CREATE TABLE IF NOT EXISTS chat.chat_sessions (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL,
  character_id       text NOT NULL,
  title              text,
  status             text NOT NULL DEFAULT 'active',   -- active|archived|deleted
  memory_enabled     boolean NOT NULL DEFAULT true,
  memory_summary     text,                              -- rolling summary (PG)
  log_extracted_seq  bigint NOT NULL DEFAULT 0,         -- session.jsonl derive watermark (D3)
  last_message_at    timestamp,
  created_at         timestamp NOT NULL DEFAULT (timezone('utc', now())),
  updated_at         timestamp NOT NULL DEFAULT (timezone('utc', now())),
  deleted_at         timestamp
);
ALTER TABLE chat.chat_sessions
  ADD COLUMN IF NOT EXISTS character_content_version_id text,
  ADD COLUMN IF NOT EXISTS character_release_id text,
  ADD COLUMN IF NOT EXISTS release_pinned_at timestamp;
CREATE INDEX IF NOT EXISTS chat_sessions_user_last_idx
  ON chat.chat_sessions (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_character_idx
  ON chat.chat_sessions (character_id);

-- Immutable receipt for the logical client send intent. The receipt is written
-- in the same transaction as the user/assistant pair, so HTTP retry, timeout,
-- and concurrent delivery always converge on one canonical turn.
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

CREATE TABLE IF NOT EXISTS chat.chat_session_release_migrations (
  id                                text PRIMARY KEY,
  command_id                        text NOT NULL UNIQUE,
  session_id                        text NOT NULL REFERENCES chat.chat_sessions(id),
  character_id                      text NOT NULL,
  from_character_content_version_id text,
  from_character_release_id         text,
  to_character_content_version_id   text NOT NULL,
  to_character_release_id           text,
  reason                            text NOT NULL,
  compatibility_qa                  jsonb NOT NULL,
  requested_by_id                   text NOT NULL,
  status                            text NOT NULL DEFAULT 'pending',
  requested_at                      timestamp NOT NULL DEFAULT (timezone('utc', now())),
  applied_at                        timestamp
);
CREATE INDEX IF NOT EXISTS chat_session_release_migrations_pending_idx
  ON chat.chat_session_release_migrations (session_id, status, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS chat_session_release_migrations_one_pending_idx
  ON chat.chat_session_release_migrations (session_id)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS chat.messages (
  id            text PRIMARY KEY,
  session_id    text NOT NULL,
  role          text NOT NULL,                          -- user|assistant|system|tool
  content       text NOT NULL DEFAULT '',
  model         text,
  status        text NOT NULL DEFAULT 'pending',        -- pending|moderating_input|blocked|generating|moderating_output|sent|failed|deleted
  token_count   integer,
  safety_status text NOT NULL DEFAULT 'unknown',        -- unknown|passed|flagged|blocked
  attempt       integer NOT NULL DEFAULT 1,             -- regenerate attempt counter
  reply_to_message_id text,                              -- exact user turn answered by an assistant
  engagement_session_id text,                            -- versioned 30m inactivity grouping, assigned on user turn
  character_content_version_id text,                     -- exact immutable content used by this turn
  character_release_id text,                             -- exact release when present; never inferred later
  memory_extracted_attempt integer NOT NULL DEFAULT 0,  -- latest attempt derived into file memory
  created_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  updated_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  deleted_at    timestamp
);
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id text;
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS engagement_session_id text,
  ADD COLUMN IF NOT EXISTS character_content_version_id text,
  ADD COLUMN IF NOT EXISTS character_release_id text;
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS memory_extracted_attempt integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_session_created_idx
  ON chat.messages (session_id, created_at);
-- reconciler hot scan: stuck `generating`
CREATE INDEX IF NOT EXISTS messages_status_updated_idx
  ON chat.messages (status, updated_at);
CREATE INDEX IF NOT EXISTS messages_reply_to_idx
  ON chat.messages (reply_to_message_id);

CREATE TABLE IF NOT EXISTS chat.message_versions (
  id         text PRIMARY KEY,
  message_id text NOT NULL,
  content    text NOT NULL,
  model      text,
  selected   boolean NOT NULL DEFAULT false,
  attempt    integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT (timezone('utc', now()))
);
CREATE INDEX IF NOT EXISTS message_versions_message_idx
  ON chat.message_versions (message_id);

-- Chat-visible generated media attachments. The media authority remains in main
-- MediaAsset; chat stores only status + ids for rendering and recovery.
CREATE TABLE IF NOT EXISTS chat.message_attachments (
  id                text PRIMARY KEY,
  session_id        text NOT NULL,
  message_id        text NOT NULL,
  kind              text NOT NULL,                         -- generated_image
  status            text NOT NULL DEFAULT 'proposed',       -- proposed|requesting|queued|running|completed|failed|blocked|refunded|canceled
  generation_job_id text,
  media_asset_id    text,
  cost_dreamcoins   integer,
  prompt_hint       text,
  width             integer,
  height            integer,
  error_code        text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamp NOT NULL DEFAULT (timezone('utc', now())),
  updated_at        timestamp NOT NULL DEFAULT (timezone('utc', now()))
);
CREATE INDEX IF NOT EXISTS message_attachments_message_idx
  ON chat.message_attachments (message_id);
CREATE INDEX IF NOT EXISTS message_attachments_session_status_idx
  ON chat.message_attachments (session_id, status);
CREATE INDEX IF NOT EXISTS message_attachments_generation_job_idx
  ON chat.message_attachments (generation_job_id);

CREATE TABLE IF NOT EXISTS chat.chat_usage (
  id            text PRIMARY KEY,
  user_id       text NOT NULL,
  session_id    text,
  messages_used integer NOT NULL DEFAULT 0,
  period_start  timestamp NOT NULL,
  period_end    timestamp NOT NULL,
  created_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  updated_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  UNIQUE (user_id, period_start)
);
CREATE INDEX IF NOT EXISTS chat_usage_user_idx ON chat.chat_usage (user_id);

CREATE TABLE IF NOT EXISTS chat.chat_moderation_events (
  id          text PRIMARY KEY,
  target_type text NOT NULL,                            -- message|memory|session
  target_id   text NOT NULL,
  layer       text NOT NULL,                            -- input|output|memory
  status      text NOT NULL,                            -- passed|flagged|blocked
  policy_code text,
  confidence  double precision,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamp NOT NULL DEFAULT (timezone('utc', now()))
);
CREATE INDEX IF NOT EXISTS chat_moderation_target_idx
  ON chat.chat_moderation_events (target_type, target_id);

-- Transactional outbox (chat → main). Written in the finalize TX; delivered async.
CREATE TABLE IF NOT EXISTS chat.chat_outbox_events (
  id             text PRIMARY KEY,
  event_type     text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version integer NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'pending',       -- pending|delivered|failed
  attempts       integer NOT NULL DEFAULT 0,
  next_run_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  created_at     timestamp NOT NULL DEFAULT (timezone('utc', now())),
  delivered_at   timestamp
);
CREATE INDEX IF NOT EXISTS chat_outbox_pending_idx
  ON chat.chat_outbox_events (status, next_run_at);
ALTER TABLE chat.chat_outbox_events
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

-- Inbox (main → chat). Commands consumed idempotently on event_id.
CREATE TABLE IF NOT EXISTS chat.chat_inbox_events (
  id           text PRIMARY KEY,                        -- chat-local receipt id
  source_service text NOT NULL DEFAULT 'main',
  source_event_id text NOT NULL,
  payload_hash text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',         -- pending|consumed|failed
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamp NOT NULL DEFAULT (timezone('utc', now())),
  processed_at timestamp,
  consumed_at  timestamp                               -- legacy compatibility
);
ALTER TABLE chat.chat_inbox_events
  ADD COLUMN IF NOT EXISTS source_service text,
  ADD COLUMN IF NOT EXISTS source_event_id text,
  ADD COLUMN IF NOT EXISTS payload_hash text,
  ADD COLUMN IF NOT EXISTS processed_at timestamp;
UPDATE chat.chat_inbox_events
SET source_service = COALESCE(source_service, payload #>> '{__durable,sourceService}', 'main'),
    source_event_id = COALESCE(source_event_id, id),
    payload_hash = COALESCE(payload_hash, payload #>> '{__durable,payloadHash}', 'legacy:' || id),
    processed_at = COALESCE(processed_at, consumed_at)
WHERE source_service IS NULL
   OR source_event_id IS NULL
   OR payload_hash IS NULL
   OR (processed_at IS NULL AND consumed_at IS NOT NULL);
ALTER TABLE chat.chat_inbox_events
  ALTER COLUMN source_service SET DEFAULT 'main',
  ALTER COLUMN source_service SET NOT NULL,
  ALTER COLUMN source_event_id SET NOT NULL,
  ALTER COLUMN payload_hash SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_inbox_source_key
  ON chat.chat_inbox_events (source_service, source_event_id);
CREATE INDEX IF NOT EXISTS chat_inbox_pending_idx
  ON chat.chat_inbox_events (status, created_at);
