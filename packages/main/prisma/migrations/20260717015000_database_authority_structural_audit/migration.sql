-- Text rendered by pg_get_triggerdef depends on search_path. Audit the durable
-- catalog structure instead, under a deliberately restrictive search path.
BEGIN;

SET LOCAL search_path = pg_catalog;

DO $audit_authority_trigger_structure$
DECLARE
  expected RECORD;
  actual RECORD;
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        ('analytics_events_immutable', 'analytics_events', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('case_evidence_immutable', 'case_evidence', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('character_content_versions_immutable', 'character_content_versions', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('character_qa_runs_immutable_update', 'character_qa_runs', 'reject_character_qa_run_update', 19, FALSE, FALSE),
        ('character_release_snapshot_immutable', 'character_releases', 'enforce_character_release_snapshot_immutable', 19, FALSE, FALSE),
        ('character_revisions_immutable', 'character_revisions', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('character_visual_reference_snapshots_immutable', 'character_visual_reference_snapshots', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('content_production_items_direction_lineage_immutable', 'content_production_items', 'reject_creative_direction_lineage_update', 19, FALSE, FALSE),
        ('creative_review_decisions_immutable', 'creative_review_decisions', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('generation_attempt_events_immutable', 'generation_attempt_events', 'reject_generation_attempt_event_update', 19, FALSE, FALSE),
        ('generation_attempt_terminal_event_required', 'generation_attempts', 'enforce_generation_attempt_terminal_event', 21, FALSE, FALSE),
        ('generation_transport_execution_lifecycle', 'generation_transport_executions', 'enforce_generation_transport_execution_lifecycle', 19, FALSE, FALSE),
        ('incident_postmortems_immutable', 'incident_postmortems', 'reject_incident_history_update', 19, FALSE, FALSE),
        ('live_public_character_projection_from_character', 'characters', 'enforce_live_public_character_projection', 21, TRUE, TRUE),
        ('live_public_character_projection_from_release', 'character_releases', 'enforce_live_public_character_projection', 21, TRUE, TRUE),
        ('live_public_character_projection_from_serving', 'character_serving', 'enforce_live_public_character_projection', 21, TRUE, TRUE),
        ('metric_definition_snapshots_immutable', 'metric_definition_snapshots', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('ops_incident_occurrence_assignments_immutable', 'ops_incident_occurrence_assignments', 'reject_incident_history_update', 19, FALSE, FALSE),
        ('public_catalog_qualification_authority', 'public_catalog_qualifications', 'enforce_public_catalog_qualification_authority', 23, FALSE, FALSE),
        ('reference_set_snapshot_immutable', 'reference_set_revisions', 'enforce_reference_set_snapshot_immutable', 19, FALSE, FALSE),
        ('release_check_results_immutable', 'release_check_results', 'reject_admin_evidence_update', 19, FALSE, FALSE),
        ('release_validation_runs_immutable', 'release_validation_runs', 'reject_admin_evidence_update', 19, FALSE, FALSE)
    ) AS expected_triggers(
      name,
      table_name,
      function_name,
      trigger_type,
      is_deferrable,
      is_initially_deferred
    )
  LOOP
    SELECT
      function_namespace.nspname AS function_schema,
      procedure.proname AS function_name,
      trigger.tgtype::INTEGER AS trigger_type,
      trigger.tgenabled AS enabled,
      trigger.tgdeferrable AS is_deferrable,
      trigger.tginitdeferred AS is_initially_deferred
    INTO actual
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc procedure ON procedure.oid = trigger.tgfoid
    JOIN pg_catalog.pg_namespace function_namespace
      ON function_namespace.oid = procedure.pronamespace
    WHERE relation_namespace.nspname = 'public'
      AND relation.relname = expected.table_name
      AND trigger.tgname = expected.name
      AND NOT trigger.tgisinternal;

    IF NOT FOUND
      OR actual.function_schema IS DISTINCT FROM 'public'
      OR actual.function_name IS DISTINCT FROM expected.function_name
      OR actual.trigger_type IS DISTINCT FROM expected.trigger_type
      OR actual.enabled IS DISTINCT FROM 'O'
      OR actual.is_deferrable IS DISTINCT FROM expected.is_deferrable
      OR actual.is_initially_deferred IS DISTINCT FROM expected.is_initially_deferred
    THEN
      RAISE EXCEPTION
        'database authority trigger %.% is missing, disabled, or structurally divergent',
        expected.table_name,
        expected.name;
    END IF;
  END LOOP;
END;
$audit_authority_trigger_structure$;

COMMIT;
