import type { AdminPermissionKey } from "./permissions";

export const ADMIN_V2_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type AdminV2HttpMethod = (typeof ADMIN_V2_HTTP_METHODS)[number];
export type AdminV2RoutePattern = `/api/v2/admin/${string}`;
export type AdminV2OperationId = `${AdminV2HttpMethod} ${AdminV2RoutePattern}`;

type NonEmptyPermissions = readonly [AdminPermissionKey, ...AdminPermissionKey[]];

export type AdminV2ResourcePermissionResolver =
  | "collaboration_target_read"
  | "collaboration_target_write"
  | "command_target_read"
  | "mutation_recovery_command_type"
  | "saved_view_scope_read"
  | "today_claim_source_write";

export type AdminV2Authorization =
  | { readonly kind: "bootstrap" }
  | { readonly kind: "all_of"; readonly permissions: NonEmptyPermissions }
  | {
      readonly kind: "one_of_by_resource";
      readonly permissions: NonEmptyPermissions;
      readonly resolver: AdminV2ResourcePermissionResolver;
    }
  | {
      readonly kind: "all_of_and_one_of_by_resource";
      readonly always: NonEmptyPermissions;
      readonly oneOf: NonEmptyPermissions;
      readonly resolver: AdminV2ResourcePermissionResolver;
    };

export type AdminV2SchemaContractRef = `${string}Schema`;
export type AdminV2RequestContractRef =
  | AdminV2SchemaContractRef
  | `${AdminV2SchemaContractRef}+idempotency-key`
  | `${AdminV2SchemaContractRef}+if-match`
  | `${AdminV2SchemaContractRef}+idempotency-key+if-match`
  | "none"
  | "if-match"
  | "limit-query"
  | `path:${string}`;

export type AdminV2ApiContract = {
  /** Public parser or transport contract. `none` is explicit, never inferred. */
  readonly request: AdminV2RequestContractRef;
  /** Public response DTO/envelope contract. */
  readonly response: AdminV2SchemaContractRef;
};

export type AdminV2MutationTransportKind =
  | "idempotency_key"
  | "if_match"
  | "idempotency_key_and_if_match";

export type AdminV2MutationMetadata = {
  readonly transport: AdminV2MutationTransportKind;
  readonly commandType: string;
  readonly executionMode: "atomic" | "durable";
};

export type AdminV2ApiOperation = {
  readonly id: AdminV2OperationId;
  readonly method: AdminV2HttpMethod;
  readonly route: AdminV2RoutePattern;
  readonly authorization: AdminV2Authorization;
  readonly contract: AdminV2ApiContract;
  /** Executable write admission; absent for read-only and preview operations. */
  readonly mutation?: AdminV2MutationMetadata;
  /** Additional permission-keyed DTO projections after admission. */
  readonly responseProjectionBy?: readonly AdminPermissionKey[];
};

const bootstrap = (): AdminV2Authorization => ({ kind: "bootstrap" });
const allOf = (...permissions: NonEmptyPermissions): AdminV2Authorization => ({ kind: "all_of", permissions });
const oneOfBy = (
  resolver: AdminV2ResourcePermissionResolver,
  ...permissions: NonEmptyPermissions
): AdminV2Authorization => ({ kind: "one_of_by_resource", resolver, permissions });
const allOfAndOneOfBy = (
  resolver: AdminV2ResourcePermissionResolver,
  always: NonEmptyPermissions,
  oneOf: NonEmptyPermissions,
): AdminV2Authorization => ({ kind: "all_of_and_one_of_by_resource", resolver, always, oneOf });

function operation<const Method extends AdminV2HttpMethod, const Route extends AdminV2RoutePattern>(
  method: Method,
  route: Route,
  authorization: AdminV2Authorization,
  request: AdminV2RequestContractRef,
  response: AdminV2SchemaContractRef,
  responseProjectionBy?: readonly AdminPermissionKey[],
  mutationOverride?: Partial<Pick<AdminV2MutationMetadata, "commandType" | "executionMode">>,
): AdminV2ApiOperation {
  const operationId = `${method} ${route}` as AdminV2OperationId;
  const mutation = mutationMetadata(
    operationId,
    request,
    response,
    mutationOverride,
  );
  return {
    id: operationId,
    method,
    route,
    authorization,
    contract: { request, response },
    ...(mutation ? { mutation } : {}),
    ...(responseProjectionBy ? { responseProjectionBy } : {}),
  };
}

function mutationMetadata(
  operationId: AdminV2OperationId,
  request: AdminV2RequestContractRef,
  response: AdminV2SchemaContractRef,
  override?: Partial<Pick<AdminV2MutationMetadata, "commandType" | "executionMode">>,
): AdminV2MutationMetadata | undefined {
  const requirements = request.split("+");
  const idempotency = requirements.includes("idempotency-key");
  const ifMatch = requirements.includes("if-match") || request === "if-match";
  if (!idempotency && !ifMatch) return undefined;
  const transport = idempotency && ifMatch
    ? "idempotency_key_and_if_match"
    : idempotency
      ? "idempotency_key"
      : "if_match";
  return {
    transport,
    commandType: override?.commandType ?? operationId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ".")
      .replace(/^\.|\.$/g, ""),
    executionMode: override?.executionMode ??
      (response === "adminCommandAcceptedSchema" ? "durable" : "atomic"),
  };
}

const collaborationRead = ["character.project.read", "creative.run.read", "case.read", "ops.incident.read"] as const;
const collaborationWrite = ["character.project.write", "creative.run.write", "case.assign", "ops.incident.manage"] as const;
export const ADMIN_COMMAND_TARGET_READ_PERMISSIONS = {
  admin_case: "case.read",
  character_project: "character.project.read",
  character_release: "character.release.read",
  character_serving: "character.release.read",
  chat_session: "character.release.read",
  creative_run: "creative.run.read",
  incident_action_plan: "ops.incident.read",
  ops_incident: "ops.incident.read",
} as const satisfies Record<string, AdminPermissionKey>;
export type AdminCommandTargetType = keyof typeof ADMIN_COMMAND_TARGET_READ_PERMISSIONS;

const commandTargetRead = [
  "case.read",
  "character.project.read",
  "character.release.read",
  "creative.run.read",
  "ops.incident.read",
] as const satisfies readonly (typeof ADMIN_COMMAND_TARGET_READ_PERMISSIONS)[AdminCommandTargetType][];
const todayClaimWrite = ["case.assign", "ops.incident.manage", "character.project.write", "creative.run.write"] as const;
const mutationRecoveryWrite = [
  "character.project.write",
  "creative.run.review",
  "creative.run.write",
] as const;

/**
 * Main authority SSoT for every public Admin v2 Route Handler operation.
 *
 * Resource-sensitive operations deliberately enumerate the only permissions their
 * resolver may select. They are not equivalent to an `admin` role or a blanket
 * dashboard capability.
 */
export const ADMIN_V2_API_OPERATIONS = [
  operation("GET", "/api/v2/admin/bootstrap", bootstrap(), "none", "adminBootstrapResponseSchema"),

  operation("GET", "/api/v2/admin/cases", allOf("case.read"), "operationsCaseQuerySchema", "operationsCaseListResponseSchema"),
  operation("POST", "/api/v2/admin/cases/backfill", allOf("case.decide"), "adminBackfillRequestSchema+idempotency-key", "adminBackfillResultSchema"),
  operation("POST", "/api/v2/admin/cases/backfill/customer", allOf("case.decide"), "adminBackfillRequestSchema+idempotency-key", "adminBackfillResultSchema"),
  operation("GET", "/api/v2/admin/cases/:id", allOf("case.read"), "path:id", "operationsCaseDetailSchema"),
  operation("POST", "/api/v2/admin/cases/:id/actions", allOf("case.decide"), "customerCaseActionRequestSchema+idempotency-key", "caseMutationResultSchema"),
  operation("POST", "/api/v2/admin/cases/:id/assignment", allOf("case.assign"), "caseAssignmentRequestSchema+idempotency-key", "caseMutationResultSchema"),
  operation("POST", "/api/v2/admin/cases/:id/commands/close", allOf("case.decide"), "caseCloseCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/cases/:id/commands/reopen", allOf("case.decide"), "caseReopenRequestSchema+idempotency-key", "caseReopenResultSchema"),
  operation("POST", "/api/v2/admin/cases/:id/commands/wait", allOf("case.assign"), "caseWaitRequestSchema+idempotency-key", "caseMutationResultSchema"),
  operation("POST", "/api/v2/admin/cases/:id/decisions", allOf("case.decide"), "caseDecisionRequestSchema+idempotency-key", "caseMutationResultSchema"),
  operation("POST", "/api/v2/admin/cases/:id/verification", allOf("case.decide"), "caseVerificationRequestSchema+idempotency-key", "caseMutationResultSchema"),

  operation("GET", "/api/v2/admin/voice-defaults", allOf("generation.config.read"), "none", "voiceDefaultSettingsSchema"),
  operation("PUT", "/api/v2/admin/voice-defaults", allOf("generation.config.write"), "voiceDefaultSettingsUpdateRequestSchema+idempotency-key", "voiceDefaultSettingsUpdateResponseSchema"),
  operation("POST", "/api/v2/admin/voice-defaults/preview", allOf("generation.config.read"), "voiceDefaultPreviewRequestSchema", "voiceDefaultPreviewResponseSchema"),

  operation("POST", "/api/v2/admin/characters", allOf("character.project.write"), "characterProjectCreateRequestSchema+idempotency-key", "characterProjectCreateResponseSchema"),
  operation("GET", "/api/v2/admin/characters/portfolio", allOf("character.performance.read"), "characterPortfolioQuerySchema", "characterPortfolioResponseSchema"),
  operation("POST", "/api/v2/admin/characters/performance/backfill", allOf("analytics.metric.export"), "characterPerformanceBackfillRequestSchema+idempotency-key", "characterPerformanceBackfillResponseSchema"),
  operation("GET", "/api/v2/admin/characters/performance/reconciliation", allOf("analytics.metric.read"), "none", "characterPerformanceReconciliationSchema"),
  operation("POST", "/api/v2/admin/characters/route-qualifications/commands/evaluate", allOf("content.production.write"), "generationRouteQualificationEvaluateRequestSchema+idempotency-key", "generationRouteQualificationEvaluateResponseSchema"),
  operation("GET", "/api/v2/admin/characters/:id", allOf("character.project.read", "character.release.read", "character.performance.read"), "path:id", "characterWorkspaceDetailSchema"),
  operation("GET", "/api/v2/admin/characters/:id/image-sources", allOf("character.project.read", "creative.run.read"), "path:id", "characterImageSourceListResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/image-sources", allOf("character.project.write", "creative.run.write"), "characterImageSourceUploadRequestSchema+idempotency-key", "characterImageSourceUploadResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/voice-clones", allOf("character.project.write"), "characterVoiceCloneCreateRequestSchema+idempotency-key", "characterVoiceCloneCreateResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/voice-clones/:profileId/activate", allOf("character.release.publish"), "characterVoiceActivationRequestSchema+idempotency-key", "characterVoiceActivationResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/voice-defaults/reset", allOf("character.release.publish"), "characterVoiceSystemDefaultResetRequestSchema+idempotency-key", "characterVoiceSystemDefaultResetResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/reference-sets", allOf("content.official.write"), "characterReferenceSetPublishRequestSchema+idempotency-key", "characterReferenceSetPublishResponseSchema"),
  operation("PATCH", "/api/v2/admin/characters/:id/looks/:lookId", allOf("content.official.write"), "characterLookArchiveRequestSchema+idempotency-key", "characterLookArchiveResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/commands/pause", allOf("character.release.publish"), "adminCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/commands/resume", allOf("character.release.publish"), "adminCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/commands/retire", allOf("character.release.publish"), "adminCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/portfolio-decisions", allOf("character.project.write"), "characterPortfolioDecisionRequestSchema+idempotency-key", "characterPortfolioDecisionRecordSchema"),
  operation("GET", "/api/v2/admin/characters/:id/project", allOf("character.project.write"), "path:id", "characterProjectDraftResumeSchema"),
  operation("PATCH", "/api/v2/admin/characters/:id/project", allOf("character.project.write"), "characterProjectDraftPatchRequestSchema+if-match", "characterWorkspaceProjectSchema"),
  operation("PATCH", "/api/v2/admin/characters/:id/draft-image", allOf("character.project.write"), "characterDraftImageSelectionRequestSchema+idempotency-key+if-match", "characterDraftImageSelectionResultSchema", undefined, { commandType: "character.project.draft_image.select" }),
  operation("POST", "/api/v2/admin/characters/:id/identity-bootstrap", allOf("character.project.write"), "characterIdentityBootstrapRequestSchema+idempotency-key+if-match", "characterIdentityBootstrapResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/image-readiness/repair", allOf("character.project.write"), "characterImageReadinessRepairRequestSchema+idempotency-key+if-match", "characterImageReadinessRepairResponseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/qa-runs", allOf("character.release.review"), "characterQaRunCreateRequestSchema+idempotency-key+if-match", "characterQaRunSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases", allOf("character.release.propose"), "characterReleaseProposalRequestSchema+idempotency-key+if-match", "characterReleaseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/commands/publish", allOf("character.release.publish"), "characterReleasePublishCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/commands/rollback", allOf("character.release.publish"), "characterReleaseRollbackCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/commands/schedule", allOf("character.release.publish"), "characterReleaseScheduleCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/monitors/:window/refresh", allOf("character.release.review"), "characterReleaseMonitorRefreshRequestSchema+idempotency-key", "characterReleaseMonitorRefreshResultSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/review", allOf("character.release.review"), "characterReleaseReviewRequestSchema+idempotency-key+if-match", "characterReleaseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/validation", allOf("character.release.publish"), "characterReleaseValidationRequestSchema+idempotency-key", "characterReleaseValidationResultSchema"),

  operation("POST", "/api/v2/admin/chat/sessions/:sessionId/commands/migrate-release", allOf("character.release.publish"), "characterSessionReleaseMigrationCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),

  operation("GET", "/api/v2/admin/collaboration/:targetType/:targetId/activity", oneOfBy("collaboration_target_read", ...collaborationRead), "collaborationQuerySchema", "collaborationActivityListResponseSchema"),
  operation("POST", "/api/v2/admin/collaboration/:targetType/:targetId/activity", oneOfBy("collaboration_target_write", ...collaborationWrite), "collaborationActivityCreateSchema+idempotency-key", "collaborationActivityMutationSchema"),
  operation("PUT", "/api/v2/admin/collaboration/:targetType/:targetId/watch", oneOfBy("collaboration_target_read", ...collaborationRead), "collaborationWatchSchema+idempotency-key", "collaborationWatchResponseSchema"),
  operation("GET", "/api/v2/admin/collaboration/mentions", allOf("dashboard.read"), "collaborationQuerySchema", "collaborationActivityListResponseSchema", collaborationRead),
  operation("GET", "/api/v2/admin/commands/:commandId", allOfAndOneOfBy("command_target_read", ["dashboard.read"], commandTargetRead), "path:commandId", "adminCommandStatusSchema"),
  operation("POST", "/api/v2/admin/mutation-receipts/reconcile", oneOfBy("mutation_recovery_command_type", ...mutationRecoveryWrite), "adminMutationRecoveryRequestSchema+idempotency-key", "adminMutationRecoveryResultSchema"),

  operation("GET", "/api/v2/admin/creative/runs", allOf("creative.run.read"), "creativeRunQuerySchema", "creativeRunListResponseSchema"),
  operation("POST", "/api/v2/admin/creative/runs", allOf("creative.run.write"), "creativeRunCreateRequestSchema+idempotency-key", "creativeRunCreateResultSchema"),
  operation("GET", "/api/v2/admin/creative/run-options", allOf("creative.run.read"), "none", "creativeRunCreateOptionsSchema"),
  operation("GET", "/api/v2/admin/creative/runs/:id", allOf("creative.run.read"), "path:id", "creativeRunDetailSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/commands/attach-incident", allOf("ops.incident.manage", "creative.run.write"), "creativeRunAttachIncidentRequestSchema+idempotency-key", "creativeRunAttachIncidentResultSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/commands/retry-failed", allOf("creative.run.write"), "creativeRunRetryFailedCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/items/:itemId/decisions", allOf("creative.run.review"), "creativeReviewDecisionRequestSchema+idempotency-key", "creativeReviewDecisionResultSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/placements", allOf("creative.placement.publish"), "creativePlacementPublishRequestSchema+idempotency-key", "creativePlacementPublishResultSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/placements/:placementId/verification", allOf("creative.placement.publish"), "creativePlacementVerificationRequestSchema+idempotency-key", "creativePlacementVerificationResultSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/placements/:placementId/withdrawal", allOf("creative.placement.publish"), "creativePlacementWithdrawalRequestSchema+idempotency-key", "creativePlacementWithdrawalResultSchema"),

  operation("GET", "/api/v2/admin/customers", allOf("customer.read"), "customerListQuerySchema", "customerListResponseSchema"),
  operation("GET", "/api/v2/admin/customers/:id", allOf("customer.read"), "path:id", "customer360Schema"),

  operation("GET", "/api/v2/admin/experiments", allOf("experiment.manage"), "experimentDefinitionListQuerySchema", "experimentDefinitionListSchema"),
  operation("POST", "/api/v2/admin/experiments", allOf("experiment.manage"), "experimentDefinitionCreateSchema+idempotency-key", "experimentDefinitionSchema"),
  operation("GET", "/api/v2/admin/experiments/:id", allOf("experiment.manage"), "path:id", "experimentDefinitionSchema"),
  operation("GET", "/api/v2/admin/experiments/:id/analysis", allOf("experiment.manage"), "experimentAnalysisQuerySchema", "experimentAnalysisResponseSchema"),
  operation("POST", "/api/v2/admin/experiments/:id/commands/start", allOf("experiment.manage"), "experimentLifecycleRequestSchema+idempotency-key", "experimentDefinitionSchema"),
  operation("POST", "/api/v2/admin/experiments/:id/commands/stop", allOf("experiment.manage"), "experimentLifecycleRequestSchema+idempotency-key", "experimentDefinitionSchema"),

  operation("POST", "/api/v2/admin/generation/requests/:id/commands/cancel", allOf("generation.job.requeue"), "generationRequestCancelSchema+idempotency-key", "generationRequestCancelResultSchema"),

  operation("GET", "/api/v2/admin/incidents", allOf("ops.incident.read"), "incidentQuerySchema", "incidentListResponseSchema"),
  operation("POST", "/api/v2/admin/incidents/backfill", allOf("ops.incident.manage"), "adminBackfillRequestSchema+idempotency-key", "adminBackfillResultSchema"),
  operation("GET", "/api/v2/admin/incidents/:id", allOf("ops.incident.read"), "path:id", "incidentDetailSchema"),
  operation("PATCH", "/api/v2/admin/incidents/:id", allOf("ops.incident.manage"), "incidentTriageRequestSchema+if-match", "incidentTriageResultSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/action-plans/preview", allOf("ops.incident.manage"), "incidentActionPlanPreviewRequestSchema+idempotency-key", "incidentActionPlanSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/action-plans/:planId/execute", allOf("ops.incident.manage"), "incidentActionPlanExecuteRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/close", allOf("ops.incident.manage"), "incidentCloseRequestSchema+idempotency-key", "incidentCloseResultSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/merge", allOf("ops.incident.manage"), "incidentMergeRequestSchema+idempotency-key", "incidentMergeResultSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/resolve", allOf("ops.incident.manage"), "incidentResolveCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/split", allOf("ops.incident.manage"), "incidentSplitRequestSchema+idempotency-key", "incidentSplitResultSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/verification", allOf("ops.incident.manage"), "incidentRecoveryVerificationRequestSchema+idempotency-key", "incidentRecoveryVerificationResultSchema"),

  operation("GET", "/api/v2/admin/jobs", allOf("generation.job.read"), "generationJobQuerySchema", "generationJobListResponseSchema"),
  operation("GET", "/api/v2/admin/jobs/:id", allOf("generation.job.read"), "path:id", "generationJobDetailResponseSchema"),
  operation("POST", "/api/v2/admin/jobs/:id/commands/retry", allOf("generation.job.requeue"), "retryGenerationRequestCommandSchema+idempotency-key", "retryGenerationRequestResultSchema"),

  operation("GET", "/api/v2/admin/metrics", allOf("analytics.metric.read"), "metricDashboardQuerySchema", "metricDashboardResponseSchema"),
  operation("GET", "/api/v2/admin/metrics/quality", allOf("analytics.metric.read"), "metricQualityQuerySchema", "metricQualityReportSchema"),
  operation("GET", "/api/v2/admin/metrics/reconciliation", allOf("analytics.metric.read"), "metricReconciliationQuerySchema", "metricReconciliationReportSchema"),
  operation("GET", "/api/v2/admin/reconciliation/invariants", allOf("analytics.metric.read"), "none", "adminInvariantReportSchema"),

  operation("GET", "/api/v2/admin/saved-views", allOfAndOneOfBy("saved_view_scope_read", ["dashboard.read"], collaborationRead), "savedViewListQuerySchema", "savedViewListResponseSchema"),
  operation("POST", "/api/v2/admin/saved-views", allOfAndOneOfBy("saved_view_scope_read", ["dashboard.read"], collaborationRead), "savedViewCreateSchema+idempotency-key", "savedViewMutationResponseSchema"),
  operation("PATCH", "/api/v2/admin/saved-views/:id", allOfAndOneOfBy("saved_view_scope_read", ["dashboard.read"], collaborationRead), "savedViewUpdateSchema+if-match", "savedViewUpdateResponseSchema"),
  operation("DELETE", "/api/v2/admin/saved-views/:id", allOfAndOneOfBy("saved_view_scope_read", ["dashboard.read"], collaborationRead), "if-match", "savedViewDeleteSchema"),
  operation("GET", "/api/v2/admin/search", allOf("dashboard.read"), "globalAdminSearchQuerySchema", "globalAdminSearchResponseSchema", ["customer.read", "character.project.read", "creative.run.read", "case.read", "ops.incident.read", "generation.job.read"]),

  operation("GET", "/api/v2/admin/today", allOf("dashboard.read"), "todayProjectionQuerySchema", "todayProjectionSchema"),
  operation("GET", "/api/v2/admin/today/all-work", allOf("dashboard.read"), "todayAllWorkQuerySchema", "todayAllWorkResponseSchema"),
  operation("POST", "/api/v2/admin/today/claim", allOfAndOneOfBy("today_claim_source_write", ["dashboard.read"], todayClaimWrite), "todayClaimRequestSchema+idempotency-key", "todayClaimResponseSchema"),
  operation("PUT", "/api/v2/admin/today/preferences", allOf("dashboard.read"), "operationalWorkPreferenceUpdateSchema+if-match", "operationalWorkPreferenceSchema"),

  operation("GET", "/api/v2/admin/users/:id/grant-bundles", allOf("user.role.write"), "path:id", "adminGrantBundleListSchema"),
  operation("POST", "/api/v2/admin/users/:id/grant-bundles", allOf("user.role.write"), "adminGrantBundleWriteSchema+idempotency-key", "adminGrantBundleMutationSchema"),
  operation("DELETE", "/api/v2/admin/users/:id/grant-bundles/:bundleKey", allOf("user.role.write"), "adminGrantBundleRevokeSchema+idempotency-key", "adminGrantBundleMutationSchema"),
] as const satisfies readonly AdminV2ApiOperation[];

function routePatternRegex(route: AdminV2RoutePattern): RegExp {
  const pattern = route
    .split("/")
    .map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("/");
  return new RegExp(`^${pattern}/?$`);
}

export function findAdminV2ApiOperation(
  method: string,
  pathname: string,
): AdminV2ApiOperation | null {
  return ADMIN_V2_API_OPERATIONS.find(
    (operation) => operation.method === method && routePatternRegex(operation.route).test(pathname),
  ) ?? null;
}

/**
 * Returns the complete static permission set that must be present when a
 * handler asserts `permission`, or null when that assertion is not declared by
 * the operation. Resource resolvers still choose the one applicable key; this
 * function prevents them from choosing outside the enumerated matrix.
 */
export function resolveAdminV2ManifestAuthorization(
  operation: AdminV2ApiOperation,
  permission: AdminPermissionKey,
): readonly AdminPermissionKey[] | null {
  const authorization = operation.authorization;
  if (authorization.kind === "bootstrap") return null;
  if (authorization.kind === "all_of") {
    return authorization.permissions.includes(permission)
      ? authorization.permissions
      : null;
  }
  if (authorization.kind === "one_of_by_resource") {
    return authorization.permissions.includes(permission) ? [permission] : null;
  }
  if (authorization.always.includes(permission)) return authorization.always;
  return authorization.oneOf.includes(permission)
    ? [...authorization.always, permission]
    : null;
}
