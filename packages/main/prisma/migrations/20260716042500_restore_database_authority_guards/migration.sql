-- Some long-lived databases were bootstrapped by resolving historical
-- migrations as applied before their PostgreSQL functions and triggers had
-- actually been installed. Re-establish missing authority guards without ever
-- overwriting a divergent database-side definition.

BEGIN;

DO $restore_authority_functions$
DECLARE
  expected RECORD;
  actual_source TEXT;
  actual_language TEXT;
  actual_return_type TEXT;
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        (
          'enforce_character_release_snapshot_immutable',
          $body$
BEGIN
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."revisionId" IS DISTINCT FROM OLD."revisionId"
    OR NEW."characterContentVersionId" IS DISTINCT FROM OLD."characterContentVersionId"
    OR NEW."visualProfileId" IS DISTINCT FROM OLD."visualProfileId"
    OR NEW."visualProfileVersion" IS DISTINCT FROM OLD."visualProfileVersion"
    OR NEW."referenceSetRevisionId" IS DISTINCT FROM OLD."referenceSetRevisionId"
    OR NEW."generationProvenance" IS DISTINCT FROM OLD."generationProvenance"
    OR NEW."releasePlacementManifest" IS DISTINCT FROM OLD."releasePlacementManifest"
    OR NEW."snapshotHash" IS DISTINCT FROM OLD."snapshotHash"
  THEN
    RAISE EXCEPTION 'character release snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$body$
        ),
        (
          'enforce_generation_attempt_terminal_event',
          $body$
BEGIN
  IF NEW."status" IN ('succeeded', 'failed', 'cancelled', 'unknown') AND NOT EXISTS (
    SELECT 1
    FROM "generation_attempt_events" e
    WHERE e."attemptId" = NEW."id"
      AND e."terminalScope" = 'terminal'
      AND e."outcome" = NEW."status"
      AND e."sequence" = NEW."terminalSequence"
  ) THEN
    RAISE EXCEPTION 'terminal GenerationAttempt requires one matching canonical terminal event';
  END IF;
  RETURN NEW;
END;
$body$
        ),
        (
          'enforce_generation_transport_execution_lifecycle',
          $body$
BEGIN
  IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
    OR NEW."transportAttemptNo" IS DISTINCT FROM OLD."transportAttemptNo"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR (OLD."latencyMs" IS NOT NULL AND NEW."latencyMs" IS DISTINCT FROM OLD."latencyMs")
    OR (OLD."costMicros" IS NOT NULL AND NEW."costMicros" IS DISTINCT FROM OLD."costMicros")
    OR (OLD."pricingVersion" IS NOT NULL AND NEW."pricingVersion" IS DISTINCT FROM OLD."pricingVersion")
  THEN
    RAISE EXCEPTION 'generation transport execution is append-only after one terminal transition';
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'running' AND NEW."status" IN ('succeeded', 'failed', 'unknown') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'unknown' AND NEW."status" = 'succeeded'
    AND OLD."manifestRef" IS NULL AND NEW."manifestRef" IS NOT NULL
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'generation transport execution is append-only after one terminal transition';
END;
$body$
        ),
        (
          'enforce_reference_set_snapshot_immutable',
          $body$
BEGIN
  IF OLD."snapshotHash" IS NOT NULL AND (
    NEW."visualProfileId" IS DISTINCT FROM OLD."visualProfileId"
    OR NEW."revision" IS DISTINCT FROM OLD."revision"
    OR NEW."selectorVersion" IS DISTINCT FROM OLD."selectorVersion"
    OR NEW."createdFrom" IS DISTINCT FROM OLD."createdFrom"
    OR NEW."availableAtSnapshot" IS DISTINCT FROM OLD."availableAtSnapshot"
    OR NEW."snapshotHash" IS DISTINCT FROM OLD."snapshotHash"
  ) THEN
    RAISE EXCEPTION 'sealed reference set snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$body$
        ),
        (
          'reject_admin_evidence_update',
          $body$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$body$
        ),
        (
          'reject_character_qa_run_update',
          $body$
BEGIN
  RAISE EXCEPTION 'character_qa_runs are immutable';
END;
$body$
        ),
        (
          'reject_creative_direction_lineage_update',
          $body$
BEGIN
  IF OLD."directionId" IS DISTINCT FROM NEW."directionId"
     OR OLD."directionSnapshot" IS DISTINCT FROM NEW."directionSnapshot"
     OR OLD."directionHash" IS DISTINCT FROM NEW."directionHash" THEN
    RAISE EXCEPTION 'creative direction lineage is immutable';
  END IF;
  RETURN NEW;
END;
$body$
        ),
        (
          'reject_generation_attempt_event_update',
          $body$
BEGIN
  RAISE EXCEPTION 'generation_attempt_events are immutable';
END;
$body$
        ),
        (
          'reject_incident_history_update',
          $body$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$body$
        )
    ) AS expected_functions(name, source)
  LOOP
    SELECT
      procedure.prosrc,
      language.lanname,
      procedure.prorettype::regtype::TEXT
    INTO actual_source, actual_language, actual_return_type
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_language language ON language.oid = procedure.prolang
    WHERE namespace.nspname = 'public'
      AND procedure.proname = expected.name
      AND procedure.pronargs = 0;

    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE FUNCTION public.%I() RETURNS trigger LANGUAGE plpgsql AS %L',
        expected.name,
        expected.source
      );
    ELSIF actual_language IS DISTINCT FROM 'plpgsql'
      OR actual_return_type IS DISTINCT FROM 'trigger'
      OR btrim(actual_source) IS DISTINCT FROM btrim(expected.source)
    THEN
      RAISE EXCEPTION
        'authority function public.%() exists with a divergent definition',
        expected.name;
    END IF;
  END LOOP;
END;
$restore_authority_functions$;

DO $restore_authority_triggers$
DECLARE
  expected RECORD;
  actual_definition TEXT;
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        (
          'analytics_events_immutable',
          'analytics_events',
          'CREATE TRIGGER analytics_events_immutable BEFORE UPDATE ON analytics_events FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update()'
        ),
        (
          'case_evidence_immutable',
          'case_evidence',
          'CREATE TRIGGER case_evidence_immutable BEFORE UPDATE ON case_evidence FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update()'
        ),
        (
          'character_content_versions_immutable',
          'character_content_versions',
          'CREATE TRIGGER character_content_versions_immutable BEFORE UPDATE ON character_content_versions FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update()'
        ),
        (
          'character_qa_runs_immutable_update',
          'character_qa_runs',
          'CREATE TRIGGER character_qa_runs_immutable_update BEFORE UPDATE ON character_qa_runs FOR EACH ROW EXECUTE FUNCTION reject_character_qa_run_update()'
        ),
        (
          'character_release_snapshot_immutable',
          'character_releases',
          'CREATE TRIGGER character_release_snapshot_immutable BEFORE UPDATE ON character_releases FOR EACH ROW EXECUTE FUNCTION enforce_character_release_snapshot_immutable()'
        ),
        (
          'character_revisions_immutable',
          'character_revisions',
          'CREATE TRIGGER character_revisions_immutable BEFORE UPDATE ON character_revisions FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update()'
        ),
        (
          'character_visual_reference_snapshots_immutable',
          'character_visual_reference_snapshots',
          'CREATE TRIGGER character_visual_reference_snapshots_immutable BEFORE UPDATE ON character_visual_reference_snapshots FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update()'
        ),
        (
          'content_production_items_direction_lineage_immutable',
          'content_production_items',
          'CREATE TRIGGER content_production_items_direction_lineage_immutable BEFORE UPDATE ON content_production_items FOR EACH ROW EXECUTE FUNCTION reject_creative_direction_lineage_update()'
        ),
        (
          'creative_review_decisions_immutable',
          'creative_review_decisions',
          'CREATE TRIGGER creative_review_decisions_immutable BEFORE UPDATE ON creative_review_decisions FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update()'
        ),
        (
          'generation_attempt_events_immutable',
          'generation_attempt_events',
          'CREATE TRIGGER generation_attempt_events_immutable BEFORE UPDATE ON generation_attempt_events FOR EACH ROW EXECUTE FUNCTION reject_generation_attempt_event_update()'
        ),
        (
          'generation_attempt_terminal_event_required',
          'generation_attempts',
          'CREATE TRIGGER generation_attempt_terminal_event_required AFTER INSERT OR UPDATE OF status, "terminalSequence" ON generation_attempts FOR EACH ROW EXECUTE FUNCTION enforce_generation_attempt_terminal_event()'
        ),
        (
          'generation_transport_execution_lifecycle',
          'generation_transport_executions',
          'CREATE TRIGGER generation_transport_execution_lifecycle BEFORE UPDATE ON generation_transport_executions FOR EACH ROW EXECUTE FUNCTION enforce_generation_transport_execution_lifecycle()'
        ),
        (
          'incident_postmortems_immutable',
          'incident_postmortems',
          'CREATE TRIGGER incident_postmortems_immutable BEFORE UPDATE ON incident_postmortems FOR EACH ROW EXECUTE FUNCTION reject_incident_history_update()'
        ),
        (
          'metric_definition_snapshots_immutable',
          'metric_definition_snapshots',
          'CREATE TRIGGER metric_definition_snapshots_immutable BEFORE UPDATE ON metric_definition_snapshots FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update()'
        ),
        (
          'ops_incident_occurrence_assignments_immutable',
          'ops_incident_occurrence_assignments',
          'CREATE TRIGGER ops_incident_occurrence_assignments_immutable BEFORE UPDATE ON ops_incident_occurrence_assignments FOR EACH ROW EXECUTE FUNCTION reject_incident_history_update()'
        ),
        (
          'reference_set_snapshot_immutable',
          'reference_set_revisions',
          'CREATE TRIGGER reference_set_snapshot_immutable BEFORE UPDATE ON reference_set_revisions FOR EACH ROW EXECUTE FUNCTION enforce_reference_set_snapshot_immutable()'
        )
    ) AS expected_triggers(name, table_name, definition)
  LOOP
    SELECT pg_get_triggerdef(trigger.oid, TRUE)
    INTO actual_definition
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = expected.table_name
      AND trigger.tgname = expected.name
      AND NOT trigger.tgisinternal;

    IF NOT FOUND THEN
      EXECUTE expected.definition;
    ELSIF actual_definition IS DISTINCT FROM expected.definition THEN
      RAISE EXCEPTION
        'authority trigger %.% exists with divergent wiring',
        expected.table_name,
        expected.name;
    END IF;
  END LOOP;
END;
$restore_authority_triggers$;

COMMIT;
