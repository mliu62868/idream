BEGIN;

DROP TRIGGER IF EXISTS chat_file_mutations_immutable
  ON chat.chat_file_mutations;

ALTER TABLE chat.chat_file_mutations
  ADD COLUMN IF NOT EXISTS projection_claim_token text,
  ADD COLUMN IF NOT EXISTS projection_claimed_at timestamp,
  ADD COLUMN IF NOT EXISTS projection_authority_version bigint,
  ADD COLUMN IF NOT EXISTS projection_rebuild_id text;

ALTER TABLE chat.chat_file_mutations
  DROP CONSTRAINT IF EXISTS chat_file_mutations_projection_claim_check;
ALTER TABLE chat.chat_file_mutations
  ADD CONSTRAINT chat_file_mutations_projection_claim_check
    CHECK (
      (
        projection_claim_token IS NULL
        AND projection_claimed_at IS NULL
        AND projection_authority_version IS NULL
        AND projection_rebuild_id IS NULL
      )
      OR
      (
        status = 'pending'
        AND kind = 'relationship_rebuild'
        AND projection_claim_token ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        AND projection_claimed_at IS NOT NULL
        AND projection_authority_version > 0
        AND (
          projection_rebuild_id IS NULL
          OR projection_rebuild_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        )
      )
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
       OR NEW.projection_claim_token IS NOT NULL
       OR NEW.projection_claimed_at IS NOT NULL
       OR NEW.projection_authority_version IS NOT NULL
       OR NEW.projection_rebuild_id IS NOT NULL
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
     OR NEW.projection_claim_token IS NOT NULL
     OR NEW.projection_claimed_at IS NOT NULL
     OR NEW.projection_authority_version IS NOT NULL
     OR NEW.projection_rebuild_id IS NOT NULL
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

GRANT UPDATE (
  status,
  payload,
  attempts,
  last_error,
  applied_at,
  projection_claim_token,
  projection_claimed_at,
  projection_authority_version,
  projection_rebuild_id
) ON chat.chat_file_mutations TO chat_projector;

COMMIT;
