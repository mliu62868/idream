-- Canonical facts and evidence are append-only. Retention may delete rows, but
-- no application or ad-hoc SQL may rewrite a fact in place.
CREATE FUNCTION reject_admin_evidence_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER analytics_events_immutable
BEFORE UPDATE ON "analytics_events"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

CREATE TRIGGER metric_definition_snapshots_immutable
BEFORE UPDATE ON "metric_definition_snapshots"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

CREATE TRIGGER case_evidence_immutable
BEFORE UPDATE ON "case_evidence"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

CREATE TRIGGER creative_review_decisions_immutable
BEFORE UPDATE ON "creative_review_decisions"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

CREATE TRIGGER character_content_versions_immutable
BEFORE UPDATE ON "character_content_versions"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

CREATE TRIGGER character_revisions_immutable
BEFORE UPDATE ON "character_revisions"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

CREATE TRIGGER character_visual_reference_snapshots_immutable
BEFORE UPDATE ON "character_visual_reference_snapshots"
FOR EACH ROW EXECUTE FUNCTION reject_admin_evidence_update();

-- Release lifecycle/readiness/version may advance, but its pinned content,
-- visual, reference, provenance and placement snapshot never change.
CREATE FUNCTION enforce_character_release_snapshot_immutable()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER character_release_snapshot_immutable
BEFORE UPDATE ON "character_releases"
FOR EACH ROW EXECUTE FUNCTION enforce_character_release_snapshot_immutable();

-- A ReferenceSetRevision is assembled once, then sealed by snapshotHash. Its
-- lifecycle status can later become superseded without rewriting the snapshot.
CREATE FUNCTION enforce_reference_set_snapshot_immutable()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER reference_set_snapshot_immutable
BEFORE UPDATE ON "reference_set_revisions"
FOR EACH ROW EXECUTE FUNCTION enforce_reference_set_snapshot_immutable();

-- One TransportExecution row may only move from running to one terminal state;
-- identity and cost evidence cannot be overwritten after that.
CREATE FUNCTION enforce_generation_transport_execution_lifecycle()
RETURNS trigger AS $$
BEGIN
  IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
    OR NEW."transportAttemptNo" IS DISTINCT FROM OLD."transportAttemptNo"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR (OLD."costMicros" IS NOT NULL AND NEW."costMicros" IS DISTINCT FROM OLD."costMicros")
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
$$ LANGUAGE plpgsql;

CREATE TRIGGER generation_transport_execution_lifecycle
BEFORE UPDATE ON "generation_transport_executions"
FOR EACH ROW EXECUTE FUNCTION enforce_generation_transport_execution_lifecycle();
