-- Character Soul v2 pins the Chat scene used to synthesize a voice clip.
-- Keep legacy four-key payloads readable while requiring the current scene
-- fields to appear as one exact, validated pair.
-- INTENT: Prisma does not wrap PostgreSQL migrations automatically. Keep the
-- old guard in place if validating the replacement ever fails.
BEGIN;

ALTER TABLE "voice_clip_requests"
  DROP CONSTRAINT IF EXISTS "voice_clip_requests_synthesis_payload_check";

ALTER TABLE "voice_clip_requests"
  ADD CONSTRAINT "voice_clip_requests_synthesis_payload_check"
  CHECK (
    "synthesisPayload" IS NULL OR (
      jsonb_typeof("synthesisPayload") = 'object'
      AND "synthesisPayload" ?& ARRAY['version', 'text', 'sessionId', 'intent']
      AND "synthesisPayload"->'version' = '1'::jsonb
      AND jsonb_typeof("synthesisPayload"->'text') = 'string'
      AND length(btrim("synthesisPayload"->>'text')) BETWEEN 1 AND 2000
      AND (
        "synthesisPayload"->'sessionId' = 'null'::jsonb
        OR (
          jsonb_typeof("synthesisPayload"->'sessionId') = 'string'
          AND length("synthesisPayload"->>'sessionId') > 0
        )
      )
      AND jsonb_typeof("synthesisPayload"->'intent') = 'string'
      AND "synthesisPayload"->>'intent' IN ('play', 'prewarm')
      AND (
        "synthesisPayload" - ARRAY['version', 'text', 'sessionId', 'intent'] = '{}'::jsonb
        OR (
          "synthesisPayload" ?& ARRAY['sceneVersion', 'scene']
          AND "synthesisPayload" - ARRAY[
            'version', 'text', 'sessionId', 'intent', 'sceneVersion', 'scene'
          ] = '{}'::jsonb
          AND CASE
            WHEN jsonb_typeof("synthesisPayload"->'sceneVersion') = 'number'
            THEN ("synthesisPayload"->>'sceneVersion')::numeric >= 0
              AND ("synthesisPayload"->>'sceneVersion')::numeric =
                trunc(("synthesisPayload"->>'sceneVersion')::numeric)
            ELSE false
          END
          AND (
            (
              "synthesisPayload"->'scene' = 'null'::jsonb
              AND "synthesisPayload"->'sceneVersion' = '0'::jsonb
            )
            OR (
              jsonb_typeof("synthesisPayload"->'scene') = 'object'
              AND "synthesisPayload"->'scene' ?& ARRAY[
                'schemaVersion', 'version', 'location', 'time', 'participants',
                'emotionalBeat', 'unresolvedThreads'
              ]
              AND ("synthesisPayload"->'scene') - ARRAY[
                'schemaVersion', 'version', 'location', 'time', 'participants',
                'emotionalBeat', 'unresolvedThreads'
              ] = '{}'::jsonb
              AND "synthesisPayload"->'scene'->'schemaVersion' = '1'::jsonb
              AND CASE
                WHEN jsonb_typeof("synthesisPayload"->'scene'->'version') = 'number'
                THEN ("synthesisPayload"->'scene'->>'version')::numeric >= 0
                  AND ("synthesisPayload"->'scene'->>'version')::numeric =
                    trunc(("synthesisPayload"->'scene'->>'version')::numeric)
                ELSE false
              END
              AND "synthesisPayload"->'sceneVersion' =
                "synthesisPayload"->'scene'->'version'
              AND (
                "synthesisPayload"->'scene'->'location' = 'null'::jsonb
                OR jsonb_typeof("synthesisPayload"->'scene'->'location') = 'string'
              )
              AND (
                "synthesisPayload"->'scene'->'time' = 'null'::jsonb
                OR jsonb_typeof("synthesisPayload"->'scene'->'time') = 'string'
              )
              AND jsonb_typeof("synthesisPayload"->'scene'->'participants') = 'array'
              AND NOT jsonb_path_exists(
                "synthesisPayload"->'scene',
                '$.participants[*] ? (@.type() != "string")'
              )
              AND (
                "synthesisPayload"->'scene'->'emotionalBeat' = 'null'::jsonb
                OR jsonb_typeof("synthesisPayload"->'scene'->'emotionalBeat') = 'string'
              )
              AND jsonb_typeof("synthesisPayload"->'scene'->'unresolvedThreads') = 'array'
              AND NOT jsonb_path_exists(
                "synthesisPayload"->'scene',
                '$.unresolvedThreads[*] ? (@.type() != "string")'
              )
            )
          )
        )
      )
    )
  );

COMMIT;
