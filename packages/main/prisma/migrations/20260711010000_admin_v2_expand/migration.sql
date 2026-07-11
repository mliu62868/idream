-- AlterTable
ALTER TABLE "analytics_events" ADD COLUMN     "actor" JSONB,
ADD COLUMN     "context" JSONB,
ADD COLUMN     "dataClass" TEXT NOT NULL DEFAULT 'customer',
ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "occurredAt" TIMESTAMP(3),
ADD COLUMN     "payloadHash" TEXT,
ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "sourceEventId" TEXT,
ADD COLUMN     "sourceService" TEXT NOT NULL DEFAULT 'web',
ADD COLUMN     "trustClass" TEXT NOT NULL DEFAULT 'client_untrusted';

-- CreateTable
CREATE TABLE "character_projects" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "ownerId" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'idea',
    "audience" JSONB NOT NULL,
    "hypothesis" TEXT,
    "differentiation" TEXT,
    "successCriteria" JSONB NOT NULL,
    "plannedLaunchAt" TIMESTAMP(3),
    "activeKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_content_versions" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "personaSnapshot" JSONB NOT NULL,
    "openingSnapshot" JSONB NOT NULL,
    "appearanceSnapshot" JSONB NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_content_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_revisions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "characterContentVersionId" TEXT NOT NULL,
    "projectSnapshot" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "character_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_releases" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "characterContentVersionId" TEXT NOT NULL,
    "visualProfileId" TEXT NOT NULL,
    "visualProfileVersion" INTEGER NOT NULL,
    "referenceSetRevisionId" TEXT NOT NULL,
    "generationProvenance" JSONB NOT NULL,
    "releasePlacementManifest" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "rollbackOfReleaseId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_serving" (
    "id" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "currentReleaseId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'inactive',
    "scheduledReleaseId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_serving_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_validation_runs" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "release_validation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_check_results" (
    "id" TEXT NOT NULL,
    "validationRunId" TEXT NOT NULL,
    "checkKey" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_check_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_monitors" (
    "id" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "baseline" JSONB NOT NULL,
    "observed" JSONB NOT NULL,
    "verification" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "release_monitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_route_qualifications" (
    "id" TEXT NOT NULL,
    "routeFingerprint" TEXT NOT NULL,
    "generationProfileKey" TEXT NOT NULL,
    "generationProfileVersion" INTEGER NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "workflowVersion" INTEGER NOT NULL,
    "style" TEXT NOT NULL,
    "matrixKey" TEXT NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "passCount" INTEGER NOT NULL,
    "identityMatch" DOUBLE PRECISION NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'candidate',
    "evidence" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "generation_route_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_attempts" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "provider" TEXT,
    "profileKey" TEXT,
    "profileVersion" INTEGER,
    "workflowKey" TEXT,
    "workflowVersion" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "terminalSequence" INTEGER,
    "errorClass" TEXT,
    "errorCode" TEXT,
    "errorSignature" TEXT,
    "retryability" TEXT,
    "operatorGuidance" TEXT,
    "completionManifestRef" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_transport_executions" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "transportAttemptNo" INTEGER NOT NULL,
    "providerRequestId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL,
    "costMicros" BIGINT,
    "manifestRef" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "generation_transport_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_artifacts" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "providerRef" TEXT,
    "manifestChecksum" TEXT NOT NULL,
    "validationState" TEXT NOT NULL DEFAULT 'produced',
    "assetId" TEXT,
    "archiveState" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_deliveries" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generation_settlement_links" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_settlement_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_incidents" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signatureVersion" TEXT NOT NULL,
    "activeCorrelationKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "severity" TEXT NOT NULL,
    "ownerId" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "slaDueAt" TIMESTAMP(3),
    "impact" JSONB NOT NULL,
    "mitigation" JSONB NOT NULL,
    "suspectedCause" TEXT,
    "confidence" DOUBLE PRECISION,
    "verificationState" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_incident_occurrences" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "requestId" TEXT,
    "attemptId" TEXT,
    "transportExecutionId" TEXT,
    "occurrenceKey" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_incident_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_action_plans" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "incidentVersion" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "eligibleIdsHash" TEXT NOT NULL,
    "eligibleIds" JSONB NOT NULL,
    "skippedIds" JSONB NOT NULL,
    "impactSnapshot" JSONB NOT NULL,
    "targetVersion" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "incident_action_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_cases" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "ownerId" TEXT,
    "slaDueAt" TIMESTAMP(3),
    "resolution" JSONB,
    "verificationState" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_evidence" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operational_work_preferences" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "watching" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "snoozedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operational_work_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_records" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "evidenceRefs" JSONB NOT NULL,
    "decision" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "ownerId" TEXT NOT NULL,
    "successCriteria" JSONB NOT NULL,
    "guardrails" JSONB NOT NULL,
    "reviewAt" TIMESTAMP(3),
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decision_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane_commands" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "expectedVersion" INTEGER,
    "approvalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "result" JSONB,
    "error" JSONB,
    "needsReconciliation" BOOLEAN NOT NULL DEFAULT false,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "control_plane_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "control_plane_command_attempts" (
    "id" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "error" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "control_plane_command_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_event_receipts" (
    "id" TEXT NOT NULL,
    "sourceService" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processingState" TEXT NOT NULL DEFAULT 'received',
    "processedAt" TIMESTAMP(3),
    "quarantinedAt" TIMESTAMP(3),
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_event_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "main_outbox_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "lastError" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "main_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_definitions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "eligibility" JSONB NOT NULL,
    "variants" JSONB NOT NULL,
    "salt" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_assignments" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "experimentVersion" INTEGER NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "assignmentVersion" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "eligibilitySnapshot" JSONB NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_definition_snapshots" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "queryHash" TEXT NOT NULL,
    "qualityState" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "lastValidatedAt" TIMESTAMP(3),
    "validationEvidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_definition_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_facts" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "requestId" TEXT,
    "attemptId" TEXT,
    "transportExecutionId" TEXT,
    "userId" TEXT,
    "characterId" TEXT,
    "releaseId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "usage" JSONB NOT NULL,
    "latencyMs" INTEGER,
    "costMicros" BIGINT,
    "pricingVersion" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "character_projects_activeKey_key" ON "character_projects"("activeKey");

-- CreateIndex
CREATE INDEX "character_projects_characterId_phase_idx" ON "character_projects"("characterId", "phase");

-- CreateIndex
CREATE INDEX "character_projects_ownerId_phase_idx" ON "character_projects"("ownerId", "phase");

-- CreateIndex
CREATE INDEX "character_content_versions_sourceType_sourceId_idx" ON "character_content_versions"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "character_content_versions_characterId_version_key" ON "character_content_versions"("characterId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "character_content_versions_characterId_contentHash_key" ON "character_content_versions"("characterId", "contentHash");

-- CreateIndex
CREATE INDEX "character_revisions_characterContentVersionId_idx" ON "character_revisions"("characterContentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "character_revisions_projectId_revision_key" ON "character_revisions"("projectId", "revision");

-- CreateIndex
CREATE INDEX "character_releases_projectId_status_idx" ON "character_releases"("projectId", "status");

-- CreateIndex
CREATE INDEX "character_releases_characterContentVersionId_idx" ON "character_releases"("characterContentVersionId");

-- CreateIndex
CREATE INDEX "character_releases_visualProfileId_visualProfileVersion_idx" ON "character_releases"("visualProfileId", "visualProfileVersion");

-- CreateIndex
CREATE INDEX "character_releases_referenceSetRevisionId_idx" ON "character_releases"("referenceSetRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "character_releases_projectId_snapshotHash_key" ON "character_releases"("projectId", "snapshotHash");

-- CreateIndex
CREATE UNIQUE INDEX "character_serving_characterId_key" ON "character_serving"("characterId");

-- CreateIndex
CREATE UNIQUE INDEX "character_serving_currentReleaseId_key" ON "character_serving"("currentReleaseId");

-- CreateIndex
CREATE UNIQUE INDEX "character_serving_scheduledReleaseId_key" ON "character_serving"("scheduledReleaseId");

-- CreateIndex
CREATE INDEX "character_serving_state_scheduledAt_idx" ON "character_serving"("state", "scheduledAt");

-- CreateIndex
CREATE INDEX "release_validation_runs_releaseId_startedAt_idx" ON "release_validation_runs"("releaseId", "startedAt");

-- CreateIndex
CREATE INDEX "release_validation_runs_policyVersion_result_idx" ON "release_validation_runs"("policyVersion", "result");

-- CreateIndex
CREATE UNIQUE INDEX "release_check_results_validationRunId_checkKey_key" ON "release_check_results"("validationRunId", "checkKey");

-- CreateIndex
CREATE INDEX "release_monitors_status_startedAt_idx" ON "release_monitors"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "release_monitors_releaseId_window_key" ON "release_monitors"("releaseId", "window");

-- CreateIndex
CREATE INDEX "generation_route_qualifications_routeFingerprint_result_idx" ON "generation_route_qualifications"("routeFingerprint", "result");

-- CreateIndex
CREATE UNIQUE INDEX "generation_route_qualifications_routeFingerprint_matrixKey__key" ON "generation_route_qualifications"("routeFingerprint", "matrixKey", "policyVersion");

-- CreateIndex
CREATE INDEX "generation_attempts_status_createdAt_idx" ON "generation_attempts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "generation_attempts_errorSignature_status_idx" ON "generation_attempts"("errorSignature", "status");

-- CreateIndex
CREATE UNIQUE INDEX "generation_attempts_requestId_attemptNo_key" ON "generation_attempts"("requestId", "attemptNo");

-- CreateIndex
CREATE INDEX "generation_transport_executions_providerRequestId_idx" ON "generation_transport_executions"("providerRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_transport_executions_attemptId_transportAttemptN_key" ON "generation_transport_executions"("attemptId", "transportAttemptNo");

-- CreateIndex
CREATE INDEX "generation_artifacts_assetId_idx" ON "generation_artifacts"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_artifacts_attemptId_ordinal_key" ON "generation_artifacts"("attemptId", "ordinal");

-- CreateIndex
CREATE INDEX "generation_deliveries_requestId_status_idx" ON "generation_deliveries"("requestId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "generation_deliveries_artifactId_targetType_targetId_key" ON "generation_deliveries"("artifactId", "targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "generation_settlement_links_ledgerEntryId_key" ON "generation_settlement_links"("ledgerEntryId");

-- CreateIndex
CREATE INDEX "generation_settlement_links_requestId_kind_idx" ON "generation_settlement_links"("requestId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ops_incidents_activeCorrelationKey_key" ON "ops_incidents"("activeCorrelationKey");

-- CreateIndex
CREATE INDEX "ops_incidents_status_severity_lastSeen_idx" ON "ops_incidents"("status", "severity", "lastSeen");

-- CreateIndex
CREATE INDEX "ops_incidents_ownerId_status_idx" ON "ops_incidents"("ownerId", "status");

-- CreateIndex
CREATE INDEX "ops_incidents_signature_signatureVersion_lastSeen_idx" ON "ops_incidents"("signature", "signatureVersion", "lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "ops_incident_occurrences_occurrenceKey_key" ON "ops_incident_occurrences"("occurrenceKey");

-- CreateIndex
CREATE INDEX "ops_incident_occurrences_incidentId_observedAt_idx" ON "ops_incident_occurrences"("incidentId", "observedAt");

-- CreateIndex
CREATE INDEX "incident_action_plans_incidentId_expiresAt_idx" ON "incident_action_plans"("incidentId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_cases_activeKey_key" ON "admin_cases"("activeKey");

-- CreateIndex
CREATE INDEX "admin_cases_type_targetType_targetId_caseKey_idx" ON "admin_cases"("type", "targetType", "targetId", "caseKey");

-- CreateIndex
CREATE INDEX "admin_cases_status_slaDueAt_idx" ON "admin_cases"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "admin_cases_ownerId_status_idx" ON "admin_cases"("ownerId", "status");

-- CreateIndex
CREATE INDEX "case_evidence_caseId_occurredAt_idx" ON "case_evidence"("caseId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "case_evidence_caseId_sourceType_sourceId_key" ON "case_evidence"("caseId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "operational_work_preferences_actorId_watching_snoozedUntil_idx" ON "operational_work_preferences"("actorId", "watching", "snoozedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "operational_work_preferences_actorId_sourceType_sourceId_key" ON "operational_work_preferences"("actorId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "decision_records_sourceType_sourceId_createdAt_idx" ON "decision_records"("sourceType", "sourceId", "createdAt");

-- CreateIndex
CREATE INDEX "decision_records_ownerId_reviewAt_idx" ON "decision_records"("ownerId", "reviewAt");

-- CreateIndex
CREATE INDEX "control_plane_commands_status_leaseExpiresAt_idx" ON "control_plane_commands"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "control_plane_commands_targetType_targetId_createdAt_idx" ON "control_plane_commands"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "control_plane_commands_scope_idempotencyKey_key" ON "control_plane_commands"("scope", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "control_plane_command_attempts_commandId_attemptNo_key" ON "control_plane_command_attempts"("commandId", "attemptNo");

-- CreateIndex
CREATE INDEX "inbound_event_receipts_processingState_createdAt_idx" ON "inbound_event_receipts"("processingState", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_event_receipts_sourceService_sourceEventId_key" ON "inbound_event_receipts"("sourceService", "sourceEventId");

-- CreateIndex
CREATE INDEX "main_outbox_events_status_nextRunAt_idx" ON "main_outbox_events"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "main_outbox_events_aggregateType_aggregateId_createdAt_idx" ON "main_outbox_events"("aggregateType", "aggregateId", "createdAt");

-- CreateIndex
CREATE INDEX "experiment_definitions_status_createdAt_idx" ON "experiment_definitions"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_definitions_key_version_key" ON "experiment_definitions"("key", "version");

-- CreateIndex
CREATE INDEX "experiment_assignments_experimentId_experimentVersion_varia_idx" ON "experiment_assignments"("experimentId", "experimentVersion", "variant");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_assignments_experimentId_subjectType_subjectId_a_key" ON "experiment_assignments"("experimentId", "subjectType", "subjectId", "assignmentVersion");

-- CreateIndex
CREATE INDEX "metric_definition_snapshots_qualityState_effectiveAt_idx" ON "metric_definition_snapshots"("qualityState", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "metric_definition_snapshots_key_version_key" ON "metric_definition_snapshots"("key", "version");

-- CreateIndex
CREATE INDEX "ai_usage_facts_requestId_occurredAt_idx" ON "ai_usage_facts"("requestId", "occurredAt");

-- CreateIndex
CREATE INDEX "ai_usage_facts_provider_model_occurredAt_idx" ON "ai_usage_facts"("provider", "model", "occurredAt");

-- CreateIndex
CREATE INDEX "ai_usage_facts_characterId_releaseId_occurredAt_idx" ON "ai_usage_facts"("characterId", "releaseId", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_environment_dataClass_occurredAt_idx" ON "analytics_events"("environment", "dataClass", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_trustClass_name_occurredAt_idx" ON "analytics_events"("trustClass", "name", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_events_sourceService_sourceEventId_key" ON "analytics_events"("sourceService", "sourceEventId");

-- Cross-field invariants that Prisma cannot express.
ALTER TABLE "character_serving"
ADD CONSTRAINT "character_serving_distinct_pointers_check"
CHECK (
  "currentReleaseId" IS NULL
  OR "scheduledReleaseId" IS NULL
  OR "currentReleaseId" <> "scheduledReleaseId"
);

ALTER TABLE "generation_attempts"
ADD CONSTRAINT "generation_attempt_terminal_time_check"
CHECK (
  "status" NOT IN ('succeeded', 'failed', 'cancelled', 'unknown')
  OR "finishedAt" IS NOT NULL
);

ALTER TABLE "control_plane_commands"
ADD CONSTRAINT "control_plane_command_attempt_budget_check"
CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0 AND "attemptCount" <= "maxAttempts");

ALTER TABLE "ops_incident_occurrences"
ADD CONSTRAINT "ops_incident_occurrence_source_check"
CHECK (
  "requestId" IS NOT NULL
  OR "attemptId" IS NOT NULL
  OR "transportExecutionId" IS NOT NULL
);
