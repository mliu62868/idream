CREATE TABLE "ops_incident_occurrence_assignments" (
  "id" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "fromIncidentId" TEXT NOT NULL,
  "toIncidentId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_incident_occurrence_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ops_incident_occurrence_assignments_occurrenceId_createdAt_idx"
  ON "ops_incident_occurrence_assignments"("occurrenceId", "createdAt");
CREATE INDEX "ops_incident_occurrence_assignments_fromIncidentId_createdAt_idx"
  ON "ops_incident_occurrence_assignments"("fromIncidentId", "createdAt");
CREATE INDEX "ops_incident_occurrence_assignments_toIncidentId_createdAt_idx"
  ON "ops_incident_occurrence_assignments"("toIncidentId", "createdAt");

CREATE TABLE "incident_postmortems" (
  "id" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "rootCause" TEXT NOT NULL,
  "contributingFactors" JSONB NOT NULL,
  "correctiveActions" JSONB NOT NULL,
  "evidenceRefs" JSONB NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "incident_postmortems_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "incident_postmortems_incidentId_key" ON "incident_postmortems"("incidentId");
CREATE INDEX "incident_postmortems_createdById_createdAt_idx" ON "incident_postmortems"("createdById", "createdAt");

CREATE FUNCTION reject_incident_history_update()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ops_incident_occurrence_assignments_immutable
BEFORE UPDATE ON "ops_incident_occurrence_assignments"
FOR EACH ROW EXECUTE FUNCTION reject_incident_history_update();

CREATE TRIGGER incident_postmortems_immutable
BEFORE UPDATE ON "incident_postmortems"
FOR EACH ROW EXECUTE FUNCTION reject_incident_history_update();
