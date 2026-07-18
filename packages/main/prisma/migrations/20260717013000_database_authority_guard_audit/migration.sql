-- Refuse to declare the schema healthy when an authority function or trigger
-- has been changed, disabled, rewired, or partially installed out of band.
DO $audit_authority_functions$
DECLARE
  expected RECORD;
  actual RECORD;
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        ('enforce_character_release_snapshot_immutable', '80d2328cae32dc01db1e1e36a5cfe90b'),
        ('enforce_generation_attempt_terminal_event', '2ec7d820bdd51728e52aca468e731409'),
        ('enforce_generation_transport_execution_lifecycle', 'd414875aa85c64e0f229ff36f5921abd'),
        ('enforce_live_public_character_projection', 'a27602725f16c1c2f67a9e7db629a7ac'),
        ('enforce_public_catalog_qualification_authority', '161e78047b6fb9c969865456b8135b40'),
        ('enforce_reference_set_snapshot_immutable', '9f6c814f6830d76bbcfc063c9f7cd0c5'),
        ('reject_admin_evidence_update', 'f0c933f2b332d19ec7d51866e2ad5a7b'),
        ('reject_character_qa_run_update', '3d5595e6518b7c561be3882dfbfd10eb'),
        ('reject_creative_direction_lineage_update', '02530bdbda2412ff0f7aebdb780a6931'),
        ('reject_generation_attempt_event_update', 'a015a041ca5861c88584e55e3323db16'),
        ('reject_incident_history_update', 'f0c933f2b332d19ec7d51866e2ad5a7b')
    ) AS expected_functions(name, source_hash)
  LOOP
    SELECT
      md5(btrim(procedure.prosrc)) AS source_hash,
      language.lanname AS language,
      procedure.prorettype::regtype::TEXT AS return_type
    INTO actual
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_language language ON language.oid = procedure.prolang
    WHERE namespace.nspname = 'public'
      AND procedure.proname = expected.name
      AND procedure.pronargs = 0;

    IF NOT FOUND
      OR actual.source_hash IS DISTINCT FROM expected.source_hash
      OR actual.language IS DISTINCT FROM 'plpgsql'
      OR actual.return_type IS DISTINCT FROM 'trigger'
    THEN
      RAISE EXCEPTION
        'database authority function public.%() is missing or divergent',
        expected.name;
    END IF;
  END LOOP;
END;
$audit_authority_functions$;

DO $audit_authority_triggers$
DECLARE
  expected RECORD;
  actual RECORD;
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        ('analytics_events_immutable', 'analytics_events', 'eb3c5776588d8d4dcd9aaf2d543b0476'),
        ('case_evidence_immutable', 'case_evidence', '7fdc391d65027a2a5df13e2efacb74f2'),
        ('character_content_versions_immutable', 'character_content_versions', '6aa6d56e9b489f6b5ab7c2643ba15398'),
        ('character_qa_runs_immutable_update', 'character_qa_runs', '506dfdf7158064a76ea04782c87f650c'),
        ('character_release_snapshot_immutable', 'character_releases', '017062ce9542fd9c60bda9849eca9e51'),
        ('character_revisions_immutable', 'character_revisions', 'cf01e65e007392c892cb2f5d55108f97'),
        ('character_visual_reference_snapshots_immutable', 'character_visual_reference_snapshots', '0dda056bc76cb7e62dbceaf37f5150a9'),
        ('content_production_items_direction_lineage_immutable', 'content_production_items', 'cb88bbb28c957d9224549842d2536429'),
        ('creative_review_decisions_immutable', 'creative_review_decisions', '91d2f32bca63096aff9041074a87ef57'),
        ('generation_attempt_events_immutable', 'generation_attempt_events', '6b52fef2e80e918cae893cffd5fe0f92'),
        ('generation_attempt_terminal_event_required', 'generation_attempts', '25fa2c4e52e3b60506536070d22a447d'),
        ('generation_transport_execution_lifecycle', 'generation_transport_executions', '2ac793b4c840f699070268ddddd33788'),
        ('incident_postmortems_immutable', 'incident_postmortems', 'aa4a48bbeb46a2f6b99cfc6b1d437d3b'),
        ('live_public_character_projection_from_character', 'characters', '1282216f452335bce3189ca19a1f7d4c'),
        ('live_public_character_projection_from_release', 'character_releases', 'c90eac0f4306a40b49e5db1746b11d28'),
        ('live_public_character_projection_from_serving', 'character_serving', '2a927995a268515d91161a456ff7e39b'),
        ('metric_definition_snapshots_immutable', 'metric_definition_snapshots', '93c23c11b7d0d04c447157656d4db41b'),
        ('ops_incident_occurrence_assignments_immutable', 'ops_incident_occurrence_assignments', 'dcad02e8e71487ebc66b3bbcd8e82b52'),
        ('public_catalog_qualification_authority', 'public_catalog_qualifications', '2ad7f7b6c06e2a1da91eab2f66aaf526'),
        ('reference_set_snapshot_immutable', 'reference_set_revisions', 'b262d4be9c16019e5c1b304b6f9e1aee'),
        ('release_check_results_immutable', 'release_check_results', '2627b4e7a537d6258a7145d321823ab2'),
        ('release_validation_runs_immutable', 'release_validation_runs', '5accecbacda23b3893fc64c7e3dd69ca')
    ) AS expected_triggers(name, table_name, definition_hash)
  LOOP
    SELECT
      md5(pg_get_triggerdef(trigger.oid, TRUE)) AS definition_hash,
      trigger.tgenabled AS enabled
    INTO actual
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = expected.table_name
      AND trigger.tgname = expected.name
      AND NOT trigger.tgisinternal;

    IF NOT FOUND
      OR actual.definition_hash IS DISTINCT FROM expected.definition_hash
      OR actual.enabled IS DISTINCT FROM 'O'
    THEN
      RAISE EXCEPTION
        'database authority trigger %.% is missing, disabled, or divergent',
        expected.table_name,
        expected.name;
    END IF;
  END LOOP;
END;
$audit_authority_triggers$;
