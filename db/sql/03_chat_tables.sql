-- P0-1 boundary · chat authority tables (PRD §6). RUN AS: chat_owner.
-- IDs are app-generated cuids (text). No cross-schema FKs (independent-DB ready).
-- companion_memories / relationship_states are intentionally ABSENT — long-term
-- memory & relationship moved to the file layer (design §5). IDEMPOTENT.
\set ON_ERROR_STOP on

-- The ledger trigger must be replaced during upgrades. Keep that replacement
-- and every data normalization in one transaction so runtime never observes an
-- unguarded table if this file is applied while the service is online.
BEGIN;

CREATE TABLE IF NOT EXISTS chat.chat_sessions (
  id                 text PRIMARY KEY,
  user_id            text NOT NULL,
  character_id       text NOT NULL,
  title              text,
  status             text NOT NULL DEFAULT 'active',   -- active|archived|deleted
  memory_enabled     boolean NOT NULL DEFAULT true,
  memory_summary     text,                              -- rolling summary (PG)
  log_extracted_seq  bigint NOT NULL DEFAULT 0,         -- session.jsonl derive watermark (D3)
  context_revision   bigint NOT NULL DEFAULT 0,         -- generation privacy/context fence
  entry_exposure_id  text,                              -- Main-owned exposure attribution
  entry_journey_id   text,
  entry_placement_id text,
  last_message_at    timestamp,
  created_at         timestamp NOT NULL DEFAULT (timezone('utc', now())),
  updated_at         timestamp NOT NULL DEFAULT (timezone('utc', now())),
  deleted_at         timestamp
);
ALTER TABLE chat.chat_sessions
  ADD COLUMN IF NOT EXISTS character_content_version_id text,
  ADD COLUMN IF NOT EXISTS character_release_id text,
  ADD COLUMN IF NOT EXISTS release_pinned_at timestamp,
  ADD COLUMN IF NOT EXISTS context_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS entry_exposure_id text,
  ADD COLUMN IF NOT EXISTS entry_journey_id text,
  ADD COLUMN IF NOT EXISTS entry_placement_id text;
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
ALTER TABLE chat.chat_send_receipts
  ADD COLUMN IF NOT EXISTS id text,
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_hash text,
  ADD COLUMN IF NOT EXISTS user_message_id text,
  ADD COLUMN IF NOT EXISTS assistant_message_id text,
  ADD COLUMN IF NOT EXISTS response_status text,
  ADD COLUMN IF NOT EXISTS safety_policy_code text,
  ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT (timezone('utc', now()));
ALTER TABLE chat.chat_send_receipts
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN session_id SET NOT NULL,
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL,
  ALTER COLUMN user_message_id SET NOT NULL,
  ALTER COLUMN assistant_message_id SET NOT NULL,
  ALTER COLUMN response_status SET NOT NULL,
  ALTER COLUMN safety_policy_code DROP NOT NULL,
  ALTER COLUMN created_at SET DEFAULT (timezone('utc', now())),
  ALTER COLUMN created_at SET NOT NULL;
-- This manifest runs with Chat writers paused. Recreate the complete receipt
-- authority so a same-name partial predecessor or weak index cannot pass.
ALTER TABLE chat.chat_send_receipts
  DROP CONSTRAINT IF EXISTS chat_send_receipts_pkey,
  DROP CONSTRAINT IF EXISTS chat_send_receipts_session_id_fkey,
  DROP CONSTRAINT IF EXISTS chat_send_receipts_response_status_check;
ALTER TABLE chat.chat_send_receipts
  ADD CONSTRAINT chat_send_receipts_pkey PRIMARY KEY (id),
  ADD CONSTRAINT chat_send_receipts_session_id_fkey
    FOREIGN KEY (session_id) REFERENCES chat.chat_sessions(id) ON DELETE CASCADE,
  ADD CONSTRAINT chat_send_receipts_response_status_check
    CHECK (response_status IN ('generating', 'blocked'));
DROP INDEX IF EXISTS chat.chat_send_receipts_user_idempotency_key;
DROP INDEX IF EXISTS chat.chat_send_receipts_session_idx;
CREATE UNIQUE INDEX chat_send_receipts_user_idempotency_key
  ON chat.chat_send_receipts (user_id, idempotency_key);
CREATE INDEX chat_send_receipts_session_idx
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
  memory_authority text NOT NULL DEFAULT 'legacy_unknown', -- enabled|disabled captured on the assistant turn
  memory_extracted_attempt integer NOT NULL DEFAULT 0,  -- latest attempt derived into file memory
  scene_version integer NOT NULL DEFAULT 0,             -- Scene revision visible when this turn began
  runtime_trace jsonb,                                   -- immutable-attempt model/Soul/Scene trace
  created_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  updated_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  deleted_at    timestamp,
  CONSTRAINT messages_memory_authority_check
    CHECK (memory_authority IN ('enabled', 'disabled', 'legacy_unknown'))
);
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id text;
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS engagement_session_id text,
  ADD COLUMN IF NOT EXISTS character_content_version_id text,
  ADD COLUMN IF NOT EXISTS character_release_id text;
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS memory_extracted_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS scene_version integer NOT NULL DEFAULT 0;
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS runtime_trace jsonb;
ALTER TABLE chat.messages
  ADD COLUMN IF NOT EXISTS memory_authority text NOT NULL DEFAULT 'legacy_unknown';
-- This manifest runs with Chat writers paused. Recreate owned constraints and
-- indexes so a same-name, weaker manual definition can never be trusted.
ALTER TABLE chat.messages
  DROP CONSTRAINT IF EXISTS messages_memory_authority_check;
ALTER TABLE chat.messages
  ADD CONSTRAINT messages_memory_authority_check
  CHECK (memory_authority IN ('enabled', 'disabled', 'legacy_unknown'));
CREATE INDEX IF NOT EXISTS messages_session_created_idx
  ON chat.messages (session_id, created_at);
-- reconciler hot scan: stuck `generating`
CREATE INDEX IF NOT EXISTS messages_status_updated_idx
  ON chat.messages (status, updated_at);
CREATE INDEX IF NOT EXISTS messages_reply_to_idx
  ON chat.messages (reply_to_message_id);

-- Memory enablement is captured per assistant turn. A later preference change
-- must not rewrite the authority under which an existing turn was generated.
CREATE OR REPLACE FUNCTION chat.reject_message_memory_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.memory_authority IS DISTINCT FROM OLD.memory_authority THEN
    RAISE EXCEPTION
      'message memory_authority is immutable (message id=%)',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS message_memory_authority_immutable ON chat.messages;
CREATE TRIGGER message_memory_authority_immutable
  BEFORE UPDATE OF memory_authority ON chat.messages
  FOR EACH ROW
  EXECUTE FUNCTION chat.reject_message_memory_authority_mutation();

DROP INDEX IF EXISTS chat.messages_memory_reconcile_eligible_idx;
CREATE INDEX messages_memory_reconcile_eligible_idx
  ON chat.messages (updated_at DESC)
  WHERE role = 'assistant'
    AND status = 'sent'
    AND deleted_at IS NULL
    AND memory_authority = 'enabled'
    AND memory_extracted_attempt < attempt
    AND reply_to_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat.chat_scene_revisions (
  id                          text PRIMARY KEY,
  session_id                  text NOT NULL REFERENCES chat.chat_sessions(id) ON DELETE CASCADE,
  version                     integer NOT NULL,
  source_assistant_message_id text NOT NULL,
  source_attempt              integer NOT NULL,
  snapshot                    jsonb NOT NULL,
  created_at                  timestamp NOT NULL DEFAULT (timezone('utc', now())),
  CONSTRAINT chat_scene_revisions_version_check CHECK (version > 0),
  CONSTRAINT chat_scene_revisions_source_attempt_check CHECK (source_attempt > 0),
  CONSTRAINT chat_scene_revisions_snapshot_schema_check CHECK (
    snapshot @> '{"schemaVersion": 1}'::jsonb
    AND (snapshot->>'version')::integer = version
  )
);
ALTER TABLE chat.chat_scene_revisions
  DROP CONSTRAINT IF EXISTS chat_scene_revisions_version_check,
  DROP CONSTRAINT IF EXISTS chat_scene_revisions_source_attempt_check,
  DROP CONSTRAINT IF EXISTS chat_scene_revisions_snapshot_schema_check;
ALTER TABLE chat.chat_scene_revisions
  ADD CONSTRAINT chat_scene_revisions_version_check CHECK (version > 0),
  ADD CONSTRAINT chat_scene_revisions_source_attempt_check
    CHECK (source_attempt > 0),
  ADD CONSTRAINT chat_scene_revisions_snapshot_schema_check CHECK (
    snapshot @> '{"schemaVersion": 1}'::jsonb
    AND (snapshot->>'version')::integer = version
  );
DROP INDEX IF EXISTS chat.chat_scene_revisions_session_version_key;
DROP INDEX IF EXISTS chat.chat_scene_revisions_source_attempt_key;
DROP INDEX IF EXISTS chat.chat_scene_revisions_session_created_idx;
CREATE UNIQUE INDEX chat_scene_revisions_session_version_key
  ON chat.chat_scene_revisions (session_id, version);
CREATE UNIQUE INDEX chat_scene_revisions_source_attempt_key
  ON chat.chat_scene_revisions (source_assistant_message_id, source_attempt);
CREATE INDEX chat_scene_revisions_session_created_idx
  ON chat.chat_scene_revisions (session_id, created_at);

CREATE TABLE IF NOT EXISTS chat.message_versions (
  id         text PRIMARY KEY,
  message_id text NOT NULL,
  content    text NOT NULL,
  model      text,
  selected   boolean NOT NULL DEFAULT false,
  attempt    integer NOT NULL DEFAULT 1,
  runtime_trace jsonb,                                   -- immutable evidence for this exact attempt
  created_at timestamp NOT NULL DEFAULT (timezone('utc', now()))
);
ALTER TABLE chat.message_versions
  ADD COLUMN IF NOT EXISTS runtime_trace jsonb;
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
  status         text NOT NULL DEFAULT 'pending',       -- pending|request_bound|delivered|failed
  attempts       integer NOT NULL DEFAULT 0,
  next_run_at    timestamp NOT NULL DEFAULT (timezone('utc', now())),
  created_at     timestamp NOT NULL DEFAULT (timezone('utc', now())),
  delivered_at   timestamp
);
CREATE INDEX IF NOT EXISTS chat_outbox_pending_idx
  ON chat.chat_outbox_events (status, next_run_at);
ALTER TABLE chat.chat_outbox_events
  ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1;

-- Durable intent ledger for the local session/memory/relationship projection.
-- Domain transactions only append immutable intents; the idempotent projector
-- applies them to CHAT_FS_ROOT after commit and marks them applied.
CREATE TABLE IF NOT EXISTS chat.chat_file_mutations (
  id         text PRIMARY KEY,
  sequence   bigserial NOT NULL UNIQUE,
  user_id    text NOT NULL,
  kind       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status     text NOT NULL DEFAULT 'pending',
  attempts   integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp NOT NULL DEFAULT (timezone('utc', now())),
  applied_at timestamp,
  CONSTRAINT chat_file_mutations_status_check
    CHECK (status IN ('pending', 'applied'))
);

ALTER TABLE chat.chat_file_mutations
  ADD COLUMN IF NOT EXISTS id text,
  ADD COLUMN IF NOT EXISTS sequence bigint,
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS payload jsonb,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS attempts integer,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS created_at timestamp,
  ADD COLUMN IF NOT EXISTS applied_at timestamp;

DROP TRIGGER IF EXISTS chat_file_mutations_immutable
  ON chat.chat_file_mutations;

CREATE SEQUENCE IF NOT EXISTS chat.chat_file_mutations_sequence_seq;
ALTER SEQUENCE chat.chat_file_mutations_sequence_seq
  OWNED BY chat.chat_file_mutations.sequence;
ALTER TABLE chat.chat_file_mutations
  ALTER COLUMN sequence
    SET DEFAULT nextval('chat.chat_file_mutations_sequence_seq'::regclass),
  ALTER COLUMN payload SET DEFAULT '{}'::jsonb,
  ALTER COLUMN status SET DEFAULT 'pending',
  ALTER COLUMN attempts SET DEFAULT 0,
  ALTER COLUMN created_at SET DEFAULT (timezone('utc', now()));

UPDATE chat.chat_file_mutations
SET payload = CASE
      WHEN jsonb_typeof(COALESCE(payload, '{}'::jsonb)) = 'object'
        THEN jsonb_set(
          COALESCE(payload, '{}'::jsonb),
          '{kind}',
          to_jsonb(kind),
          true
        )
      ELSE jsonb_build_object('kind', kind)
    END,
    status = COALESCE(status, 'pending'),
    attempts = COALESCE(attempts, 0),
    created_at = COALESCE(created_at, timezone('utc', now()));

-- A partially deployed predecessor may already have assigned sequence values
-- next to NULLs. Align the sequence before backfilling so nextval cannot collide
-- with an existing row.
SELECT setval(
  'chat.chat_file_mutations_sequence_seq'::regclass,
  GREATEST(
    COALESCE((SELECT MAX(sequence) FROM chat.chat_file_mutations), 1),
    (SELECT last_value FROM chat.chat_file_mutations_sequence_seq),
    1
  ),
  (SELECT is_called FROM chat.chat_file_mutations_sequence_seq)
    OR EXISTS (
      SELECT 1
      FROM chat.chat_file_mutations
      WHERE sequence IS NOT NULL
    )
);

DO $$
DECLARE
  mutation record;
BEGIN
  FOR mutation IN
    SELECT id
    FROM chat.chat_file_mutations
    WHERE sequence IS NULL
    ORDER BY created_at, id
  LOOP
    UPDATE chat.chat_file_mutations
    SET sequence =
      nextval('chat.chat_file_mutations_sequence_seq'::regclass)
    WHERE id = mutation.id;
  END LOOP;
END
$$;

SELECT setval(
  'chat.chat_file_mutations_sequence_seq'::regclass,
  GREATEST(
    COALESCE((SELECT MAX(sequence) FROM chat.chat_file_mutations), 1),
    (SELECT last_value FROM chat.chat_file_mutations_sequence_seq),
    1
  ),
  (SELECT is_called FROM chat.chat_file_mutations_sequence_seq)
    OR EXISTS (SELECT 1 FROM chat.chat_file_mutations)
);

ALTER TABLE chat.chat_file_mutations
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN sequence SET NOT NULL,
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN payload SET NOT NULL,
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN attempts SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'chat.chat_file_mutations'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE chat.chat_file_mutations
      ADD PRIMARY KEY (id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS chat_file_mutations_sequence_key
  ON chat.chat_file_mutations (sequence);
CREATE INDEX IF NOT EXISTS chat_file_mutations_user_pending_idx
  ON chat.chat_file_mutations (user_id, status, sequence);

CREATE OR REPLACE FUNCTION chat.redact_file_mutation_payload(
  mutation_id text,
  mutation_kind text,
  mutation_payload jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE mutation_kind
    WHEN 'memory_extract' THEN jsonb_build_object(
      'kind', mutation_kind,
      'sessionId', mutation_payload -> 'sessionId',
      'userMessageId', mutation_payload -> 'userMessageId',
      'characterId', mutation_payload -> 'characterId',
      'turnKey', mutation_payload -> 'turnKey',
      'attempt', mutation_payload -> 'attempt'
    )
    WHEN 'relationship_set' THEN mutation_payload
    WHEN 'relationship_delete' THEN mutation_payload
    WHEN 'turn_forget' THEN jsonb_build_object(
      'kind', mutation_kind,
      'sessionId', mutation_payload -> 'sessionId',
      'characterId', mutation_payload -> 'characterId'
    )
    WHEN 'session_delete' THEN jsonb_build_object(
      'kind', mutation_kind,
      'sessionId', mutation_payload -> 'sessionId',
      'characterId', mutation_payload -> 'characterId'
    )
    WHEN 'memory_update' THEN jsonb_build_object(
      'kind', mutation_kind,
      'memoryId', mutation_payload -> 'memoryId'
    )
    WHEN 'memory_delete' THEN jsonb_build_object(
      'kind', mutation_kind,
      'memoryId', mutation_payload -> 'memoryId'
    )
    WHEN 'relationship_rebuild' THEN jsonb_build_object(
      'kind', mutation_kind,
      'characterId', mutation_payload -> 'characterId'
    )
    WHEN 'trace_append' THEN jsonb_build_object(
      'kind', mutation_kind,
      'sessionId', mutation_payload -> 'sessionId'
    )
    WHEN 'account_delete' THEN jsonb_build_object(
      'kind', mutation_kind,
      'deletionRequestEventId', COALESCE(
        mutation_payload -> 'deletionRequestEventId',
        to_jsonb('legacy-chat-file-mutation:' || mutation_id)
      )
    ) || CASE
      WHEN mutation_payload ->> 'requestBound' = 'true'
        THEN jsonb_build_object('requestBound', true)
      ELSE '{}'::jsonb
    END
    ELSE jsonb_build_object('kind', mutation_kind)
  END
$$;

CREATE OR REPLACE FUNCTION chat.redact_file_mutation_payload(
  mutation_kind text,
  mutation_payload jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT chat.redact_file_mutation_payload(
    NULL,
    mutation_kind,
    mutation_payload
  )
$$;

-- Pre-v2 pending account erasure intents did not carry a request identity.
-- Bind them one-way to their immutable ledger id before the canonical payload
-- constraint is installed; request-bound rows are never synthesized.
UPDATE chat.chat_file_mutations
SET payload = jsonb_build_object(
  'kind', 'account_delete',
  'deletionRequestEventId', 'legacy-chat-file-mutation:' || id
)
WHERE status = 'pending'
  AND kind = 'account_delete'
  AND payload ->> 'deletionRequestEventId' IS NULL
  AND COALESCE(payload ->> 'requestBound', 'false') <> 'true';

-- Applied rows from the pre-receipt implementation may contain model prompts,
-- memory candidates, or deleted source text. Convert them one-way to the same
-- content-free receipt the runtime writes at completion.
UPDATE chat.chat_file_mutations
SET payload = chat.redact_file_mutation_payload(id, kind, payload),
    attempts = GREATEST(attempts, 1),
    applied_at = COALESCE(applied_at, created_at),
    last_error = NULL
WHERE status = 'applied';

-- A relationship reset is terminal for older manual summaries; do not retain
-- reset content in the durable ledger.
DELETE FROM chat.chat_file_mutations AS older
USING chat.chat_file_mutations AS reset
WHERE older.user_id = reset.user_id
  AND older.status = 'applied'
  AND reset.status = 'applied'
  AND older.kind = 'relationship_set'
  AND reset.kind = 'relationship_delete'
  AND older.sequence < reset.sequence
  AND older.payload ->> 'characterId' =
      reset.payload ->> 'characterId';

ALTER TABLE chat.chat_file_mutations
  DROP CONSTRAINT IF EXISTS chat_file_mutations_status_check,
  DROP CONSTRAINT IF EXISTS chat_file_mutations_attempts_check,
  DROP CONSTRAINT IF EXISTS chat_file_mutations_lifecycle_check,
  DROP CONSTRAINT IF EXISTS chat_file_mutations_payload_kind_check;
ALTER TABLE chat.chat_file_mutations
  ADD CONSTRAINT chat_file_mutations_status_check
    CHECK (status IN ('pending', 'applied')),
  ADD CONSTRAINT chat_file_mutations_attempts_check
    CHECK (attempts >= 0),
  ADD CONSTRAINT chat_file_mutations_lifecycle_check
    CHECK (
      (status = 'pending' AND applied_at IS NULL)
      OR
      (status = 'applied' AND applied_at IS NOT NULL AND attempts > 0)
    ),
  ADD CONSTRAINT chat_file_mutations_payload_kind_check
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND payload ->> 'kind' IS NOT DISTINCT FROM kind
    );

CREATE OR REPLACE FUNCTION chat.assert_file_mutation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.attempts <> 0
       OR NEW.applied_at IS NOT NULL
       OR NEW.payload ->> 'kind' IS DISTINCT FROM NEW.kind THEN
      RAISE EXCEPTION 'new chat file mutation must be a pending canonical intent';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF current_setting(
         'idream.account_erasure_file_mutation_user',
         true
       ) IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'chat file mutation deletion requires controlled erasure';
    END IF;
    RETURN OLD;
  END IF;
  IF current_user <> 'chat_projector' THEN
    RAISE EXCEPTION
      'chat file mutation completion requires projector authority';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'chat file mutation identity is immutable';
  END IF;
  IF OLD.status = 'applied' THEN
    RAISE EXCEPTION 'applied chat file mutation receipt is immutable';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'chat file mutation attempts cannot decrease';
  END IF;
  IF NEW.status = 'pending' THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'pending chat file mutation payload is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status <> 'applied'
     OR NEW.attempts <= OLD.attempts
     OR NEW.applied_at IS NULL
     OR NEW.last_error IS NOT NULL
     OR NEW.payload IS DISTINCT FROM
        chat.redact_file_mutation_payload(OLD.id, OLD.kind, OLD.payload) THEN
    RAISE EXCEPTION 'chat file mutation completion evidence is invalid';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chat_file_mutations_immutable
BEFORE INSERT OR UPDATE OR DELETE ON chat.chat_file_mutations
FOR EACH ROW EXECUTE FUNCTION chat.assert_file_mutation_update();

DROP FUNCTION IF EXISTS chat.purge_file_mutations_for_account(text);

CREATE OR REPLACE FUNCTION chat.purge_file_mutations_for_account(
  target_user_id text,
  authority_mutation_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, chat
AS $$
DECLARE
  purged integer;
  authority_status text;
BEGIN
  SELECT status
  INTO authority_status
  FROM chat.chat_file_mutations
  WHERE id = authority_mutation_id
    AND user_id = target_user_id
    AND kind = 'account_delete'
    AND payload ->> 'kind' = 'account_delete'
    AND status IN ('pending', 'applied');
  IF authority_status IS NULL THEN
    RAISE EXCEPTION
      'account file purge requires its canonical erasure intent';
  END IF;
  PERFORM set_config(
    'idream.account_erasure_file_mutation_user',
    target_user_id,
    true
  );
  DELETE FROM chat.chat_file_mutations
  WHERE user_id = target_user_id
    AND (
      id <> authority_mutation_id
      OR authority_status = 'applied'
    );
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END
$$;

CREATE OR REPLACE FUNCTION chat.purge_applied_relationship_sets(
  target_user_id text,
  target_character_id text,
  before_sequence bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, chat
AS $$
DECLARE
  purged integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM chat.chat_file_mutations
    WHERE user_id = target_user_id
      AND sequence = before_sequence
      AND kind = 'relationship_delete'
      AND status = 'pending'
      AND payload ->> 'kind' = 'relationship_delete'
      AND payload ->> 'characterId' = target_character_id
  ) THEN
    RAISE EXCEPTION
      'relationship file purge requires its canonical pending reset intent';
  END IF;
  PERFORM set_config(
    'idream.account_erasure_file_mutation_user',
    target_user_id,
    true
  );
  DELETE FROM chat.chat_file_mutations
  WHERE user_id = target_user_id
    AND status = 'applied'
    AND kind = 'relationship_set'
    AND sequence < before_sequence
    AND payload ->> 'characterId' = target_character_id;
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END
$$;

REVOKE ALL ON FUNCTION
  chat.purge_file_mutations_for_account(text, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  chat.purge_applied_relationship_sets(text, text, bigint)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  chat.purge_applied_relationship_sets(text, text, bigint)
  FROM chat_service;
GRANT EXECUTE ON FUNCTION
  chat.purge_file_mutations_for_account(text, text)
  TO chat_service, chat_projector;
GRANT EXECUTE ON FUNCTION
  chat.purge_applied_relationship_sets(text, text, bigint)
  TO chat_projector;
GRANT SELECT ON chat.chat_file_mutations TO chat_service;
REVOKE INSERT ON chat.chat_file_mutations FROM chat_service;
GRANT INSERT (id, user_id, kind, payload)
  ON chat.chat_file_mutations TO chat_service;
REVOKE UPDATE ON chat.chat_file_mutations FROM chat_service;
REVOKE DELETE
  ON chat.chat_file_mutations
  FROM chat_service;
GRANT SELECT, UPDATE ON chat.chat_file_mutations TO chat_projector;
REVOKE INSERT, DELETE ON chat.chat_file_mutations FROM chat_projector;

-- Inbox (main → chat). Commands consumed idempotently on event_id.
CREATE TABLE IF NOT EXISTS chat.chat_inbox_events (
  id           text PRIMARY KEY,                        -- chat-local receipt id
  source_service text NOT NULL DEFAULT 'main',
  source_event_id text NOT NULL,
  payload_hash text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending',         -- pending|processing|consumed|consumed_v2|failed|quarantined|discarded_target_missing
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

COMMIT;
