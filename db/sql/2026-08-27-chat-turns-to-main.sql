-- USER-RUN CUTOVER SCRIPT. Do not run while either legacy Chat or Main Chat writes are active.
-- Preconditions:
--   1. Main migration 20260827120000_main_chat_turn_authority is applied.
--   2. Legacy `chat.*` and Main `public.*` schemas are visible in this database.
--   3. Both Chat write paths are drained and paused for this transaction.
-- This imports product facts only. Provider/DSH runtime_trace bytes are not
-- copied into Main; local AgentRun files own execution evidence after cutover.
-- Sessions whose Main user or Character no longer exists are legacy orphans:
-- they cannot satisfy Main foreign keys and are left in the backup/schema. The
-- preflight below still fails closed if any such session owns a completed Turn.
\set ON_ERROR_STOP on

BEGIN;

LOCK TABLE chat.chat_sessions, chat.chat_send_receipts, chat.messages,
  chat.message_attachments, chat.chat_scene_revisions IN SHARE MODE;

DO $$
DECLARE
  skipped_orphan_sessions bigint;
  skipped_orphan_attachments bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM chat.chat_send_receipts r
    JOIN chat.chat_sessions s ON s.id = r.session_id
    LEFT JOIN public.users u ON u.id = s.user_id
    LEFT JOIN public.characters c ON c.id = s.character_id
    WHERE u.id IS NULL OR c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy Chat contains a Turn without Main user/character authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM chat.chat_send_receipts r
    LEFT JOIN chat.messages u ON u.id = r.user_message_id AND u.role = 'user'
    LEFT JOIN chat.messages a ON a.id = r.assistant_message_id AND a.role = 'assistant'
    WHERE u.id IS NULL OR a.id IS NULL OR a.reply_to_message_id IS DISTINCT FROM u.id
  ) THEN
    RAISE EXCEPTION 'legacy Chat contains a send receipt without its exact user/assistant pair';
  END IF;
  IF EXISTS (
    SELECT 1 FROM chat.chat_sessions
    WHERE context_revision > 2147483647 OR context_revision < 0
  ) THEN
    RAISE EXCEPTION 'legacy Chat context_revision does not fit Main integer authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM chat.chat_send_receipts r
    JOIN chat.messages a ON a.id = r.assistant_message_id
    WHERE a.deleted_at IS NULL
      AND a.status NOT IN ('sent', 'blocked', 'failed')
  ) THEN
    RAISE EXCEPTION 'legacy Chat has an in-flight reply; drain or reconcile it before cutover';
  END IF;

  SELECT count(*) INTO skipped_orphan_sessions
  FROM chat.chat_sessions s
  LEFT JOIN public.users u ON u.id = s.user_id
  LEFT JOIN public.characters c ON c.id = s.character_id
  WHERE s.deleted_at IS NULL
    AND s.status <> 'deleted'
    AND (u.id IS NULL OR c.id IS NULL);

  SELECT count(*) INTO skipped_orphan_attachments
  FROM chat.message_attachments attachment
  JOIN chat.messages message ON message.id = attachment.message_id
  JOIN chat.chat_sessions s ON s.id = message.session_id
  LEFT JOIN public.users u ON u.id = s.user_id
  LEFT JOIN public.characters c ON c.id = s.character_id
  WHERE s.deleted_at IS NULL
    AND s.status <> 'deleted'
    AND (u.id IS NULL OR c.id IS NULL);

  IF skipped_orphan_sessions > 0 THEN
    RAISE NOTICE
      'Leaving % orphan Chat sessions and % orphan attachments in legacy storage',
      skipped_orphan_sessions,
      skipped_orphan_attachments;
  END IF;
END
$$;

-- Clear projection-era active keys before choosing exactly one active session
-- per user/Character. Older duplicates become archived instead of defeating the
-- Main uniqueness invariant.
UPDATE public.recent_chats target
SET "activeKey" = NULL
WHERE EXISTS (
  SELECT 1
  FROM chat.chat_sessions source
  JOIN public.users u ON u.id = source.user_id
  JOIN public.characters c ON c.id = source.character_id
  WHERE source.id = target."sessionId"
    AND source.deleted_at IS NULL
    AND source.status <> 'deleted'
);

WITH ranked AS (
  SELECT
    s.*,
    row_number() OVER (
      PARTITION BY s.user_id, s.character_id
      ORDER BY s.last_message_at DESC NULLS LAST, s.created_at DESC, s.id DESC
    ) AS active_rank,
    opening.content AS opening_message
  FROM chat.chat_sessions s
  JOIN public.users u ON u.id = s.user_id
  JOIN public.characters c ON c.id = s.character_id
  LEFT JOIN LATERAL (
    SELECT m.content
    FROM chat.messages m
    WHERE m.session_id = s.id
      AND m.role = 'assistant'
      AND m.reply_to_message_id IS NULL
      AND m.deleted_at IS NULL
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 1
  ) opening ON true
  WHERE s.deleted_at IS NULL AND s.status <> 'deleted'
)
INSERT INTO public.recent_chats (
  "sessionId", "userId", "characterId", title, status, "activeKey",
  "memoryEnabled", "contextRevision", "characterContentVersionId",
  "characterReleaseId", "releasePinnedAt", "entryExposureId",
  "entryJourneyId", "entryPlacementId", "openingMessage",
  "lastMessageAt", "createdAt", "updatedAt"
)
SELECT
  id,
  user_id,
  character_id,
  title,
  CASE WHEN status = 'active' AND active_rank = 1 THEN 'active' ELSE 'archived' END,
  CASE WHEN status = 'active' AND active_rank = 1 THEN user_id || ':' || character_id ELSE NULL END,
  memory_enabled,
  context_revision::integer,
  character_content_version_id,
  character_release_id,
  release_pinned_at,
  entry_exposure_id,
  entry_journey_id,
  entry_placement_id,
  opening_message,
  last_message_at,
  created_at,
  updated_at
FROM ranked
ON CONFLICT ("sessionId") DO UPDATE SET
  -- Main may already own this projection row; keep its original creation time.
  "userId" = EXCLUDED."userId",
  "characterId" = EXCLUDED."characterId",
  title = EXCLUDED.title,
  status = EXCLUDED.status,
  "activeKey" = EXCLUDED."activeKey",
  "memoryEnabled" = EXCLUDED."memoryEnabled",
  "contextRevision" = EXCLUDED."contextRevision",
  "characterContentVersionId" = EXCLUDED."characterContentVersionId",
  "characterReleaseId" = EXCLUDED."characterReleaseId",
  "releasePinnedAt" = EXCLUDED."releasePinnedAt",
  "entryExposureId" = EXCLUDED."entryExposureId",
  "entryJourneyId" = EXCLUDED."entryJourneyId",
  "entryPlacementId" = EXCLUDED."entryPlacementId",
  "openingMessage" = EXCLUDED."openingMessage",
  "lastMessageAt" = EXCLUDED."lastMessageAt",
  "updatedAt" = EXCLUDED."updatedAt";

WITH paired AS (
  SELECT
    r.id AS turn_id,
    r.session_id,
    r.idempotency_key,
    r.request_hash,
    u.id AS user_message_id,
    a.id AS assistant_message_id,
    u.content AS user_content,
    CASE WHEN u.status = 'blocked' THEN 'blocked' ELSE 'sent' END AS user_status,
    a.content AS assistant_content,
    a.status AS assistant_status,
    a.model,
    a.token_count,
    a.attempt,
    COALESCE(a.character_content_version_id, s.character_content_version_id) AS content_version_id,
    COALESCE(a.character_release_id, s.character_release_id) AS release_id,
    COALESCE(a.memory_authority = 'enabled', s.memory_enabled) AS memory_enabled,
    COALESCE(scene.version, a.scene_version, 0) AS scene_version,
    scene.snapshot AS scene_snapshot,
    LEAST(u.created_at, a.created_at) AS created_at,
    GREATEST(u.updated_at, a.updated_at) AS updated_at,
    CASE WHEN a.status IN ('sent','blocked','failed','cancelled') THEN a.updated_at ELSE NULL END AS terminal_at
  FROM chat.chat_send_receipts r
  JOIN chat.chat_sessions s ON s.id = r.session_id
  JOIN public.users main_user ON main_user.id = s.user_id
  JOIN public.characters main_character ON main_character.id = s.character_id
  JOIN chat.messages u ON u.id = r.user_message_id AND u.role = 'user'
  JOIN chat.messages a ON a.id = r.assistant_message_id AND a.role = 'assistant'
  LEFT JOIN chat.chat_scene_revisions scene
    ON scene.source_assistant_message_id = a.id
   AND scene.source_attempt = a.attempt
  WHERE s.deleted_at IS NULL
    AND s.status <> 'deleted'
    AND u.deleted_at IS NULL
    AND a.deleted_at IS NULL
)
INSERT INTO public.chat_turns (
  id, "sessionId", attempt, "idempotencyKey", "requestHash",
  "userMessageId", "assistantMessageId", "userContent", "userStatus",
  "assistantContent", "assistantStatus", model, "promptTokens",
  "completionTokens", "terminalEvidence", "characterContentVersionId",
  "characterReleaseId", "memoryEnabled", "sceneVersion", scene,
  "createdAt", "updatedAt", "terminalAt"
)
SELECT
  turn_id,
  session_id,
  GREATEST(attempt, 1),
  idempotency_key,
  request_hash,
  user_message_id,
  assistant_message_id,
  user_content,
  user_status,
  assistant_content,
  assistant_status,
  model,
  NULL,
  token_count,
  jsonb_build_object('authority', 'legacy_chat_pg_migration'),
  content_version_id,
  release_id,
  memory_enabled,
  scene_version,
  scene_snapshot,
  created_at,
  updated_at,
  terminal_at
FROM paired
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.chat_turn_attachments (
  id, "turnId", kind, status, "generationJobId", "mediaAssetId",
  "promptHint", width, height, "errorCode", metadata, "createdAt", "updatedAt"
)
SELECT
  attachment.id,
  turn.id,
  attachment.kind,
  attachment.status,
  attachment.generation_job_id,
  attachment.media_asset_id,
  attachment.prompt_hint,
  attachment.width,
  attachment.height,
  attachment.error_code,
  (attachment.metadata - 'prompt' - 'caption' - 'instruction')
    || jsonb_build_object('attempt', turn.attempt),
  attachment.created_at,
  attachment.updated_at
FROM chat.message_attachments attachment
JOIN public.chat_turns turn ON turn."assistantMessageId" = attachment.message_id
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  expected_turns bigint;
  imported_turns bigint;
  expected_attachments bigint;
  imported_attachments bigint;
BEGIN
  SELECT count(*) INTO expected_turns
  FROM chat.chat_send_receipts r
  JOIN chat.chat_sessions s ON s.id = r.session_id
  JOIN public.users main_user ON main_user.id = s.user_id
  JOIN public.characters main_character ON main_character.id = s.character_id
  JOIN chat.messages u ON u.id = r.user_message_id AND u.deleted_at IS NULL
  JOIN chat.messages a ON a.id = r.assistant_message_id AND a.deleted_at IS NULL
  WHERE s.deleted_at IS NULL AND s.status <> 'deleted';

  SELECT count(*) INTO imported_turns
  FROM public.chat_turns t
  JOIN chat.chat_send_receipts r ON r.id = t.id;

  SELECT count(*) INTO expected_attachments
  FROM chat.message_attachments a
  JOIN public.chat_turns t ON t."assistantMessageId" = a.message_id;

  SELECT count(*) INTO imported_attachments
  FROM public.chat_turn_attachments a
  JOIN chat.message_attachments old ON old.id = a.id;

  IF expected_turns <> imported_turns OR expected_attachments <> imported_attachments THEN
    RAISE EXCEPTION
      'Chat cutover verification failed: turns %/% attachments %/%',
      imported_turns, expected_turns, imported_attachments, expected_attachments;
  END IF;
END
$$;

COMMIT;

-- After application smoke tests pass, archive/drop the legacy `chat` schema and
-- DBA roles in a separately reviewed operator action. This import intentionally
-- does not perform irreversible retirement.
