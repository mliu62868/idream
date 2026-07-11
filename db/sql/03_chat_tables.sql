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
CREATE INDEX IF NOT EXISTS chat_sessions_user_last_idx
  ON chat.chat_sessions (user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_character_idx
  ON chat.chat_sessions (character_id);

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
  memory_extracted_attempt integer NOT NULL DEFAULT 0,  -- latest attempt derived into file memory
  created_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  updated_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  deleted_at    timestamp
);
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id text;
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
  status         text NOT NULL DEFAULT 'pending',       -- pending|delivered|failed
  attempts       integer NOT NULL DEFAULT 0,
  next_run_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  created_at     timestamp NOT NULL DEFAULT (timezone('utc', now())),
  delivered_at   timestamp
);
CREATE INDEX IF NOT EXISTS chat_outbox_pending_idx
  ON chat.chat_outbox_events (status, next_run_at);

-- Inbox (main → chat). Commands consumed idempotently on event_id.
CREATE TABLE IF NOT EXISTS chat.chat_inbox_events (
  id           text PRIMARY KEY,                        -- event_id from main
  event_type   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',         -- pending|consumed|failed
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamp NOT NULL DEFAULT (timezone('utc', now())),
  consumed_at  timestamp
);
CREATE INDEX IF NOT EXISTS chat_inbox_pending_idx
  ON chat.chat_inbox_events (status, created_at);
