-- Repair schema-only drift left by historical databases that were provisioned
-- before explicit long index names and column defaults became authoritative.
-- This migration is idempotent on clean databases and never rewrites rows.

BEGIN;

ALTER TABLE "control_plane_commands"
  ALTER COLUMN "requestPayload" SET DEFAULT '{}'::jsonb;

ALTER TABLE "experiment_definitions"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

DO $repair_index_names$
DECLARE
  expected RECORD;
  old_index REGCLASS;
  new_index REGCLASS;
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        (
          'admin_collaboration_activities_targetType_targetId_createdA_idx',
          'admin_collaboration_activities_targetType_targetId_createdAt_id'
        ),
        (
          'character_economics_facts_auditState_coverageState_occurred_idx',
          'character_economics_facts_auditState_coverageState_occurredAt_i'
        ),
        (
          'character_economics_facts_characterId_characterContentVersi_idx',
          'character_economics_facts_characterId_characterContentVersionId'
        ),
        (
          'character_qa_runs_projectId_characterContentVersionId_statu_idx',
          'character_qa_runs_projectId_characterContentVersionId_status_id'
        ),
        (
          'chat_exchange_facts_characterReleaseId_placementId_productD_idx',
          'chat_exchange_facts_characterReleaseId_placementId_productDay_i'
        ),
        (
          'ops_incident_occurrence_assignments_fromIncidentId_createdA_idx',
          'ops_incident_occurrence_assignments_fromIncidentId_createdAt_id'
        )
    ) AS expected_indexes(old_name, new_name)
  LOOP
    old_index := to_regclass(format('public.%I', expected.old_name));
    new_index := to_regclass(format('public.%I', expected.new_name));

    IF old_index IS NOT NULL AND new_index IS NOT NULL THEN
      RAISE EXCEPTION
        'both legacy and canonical indexes exist: %, %',
        expected.old_name,
        expected.new_name;
    ELSIF new_index IS NOT NULL THEN
      CONTINUE;
    ELSIF old_index IS NOT NULL THEN
      EXECUTE format(
        'ALTER INDEX public.%I RENAME TO %I',
        expected.old_name,
        expected.new_name
      );
    ELSE
      RAISE EXCEPTION
        'neither legacy nor canonical index exists: %, %',
        expected.old_name,
        expected.new_name;
    END IF;
  END LOOP;
END;
$repair_index_names$;

COMMIT;
