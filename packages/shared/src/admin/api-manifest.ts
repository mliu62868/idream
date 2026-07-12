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

export type AdminV2ApiOperation = {
  readonly id: AdminV2OperationId;
  readonly method: AdminV2HttpMethod;
  readonly route: AdminV2RoutePattern;
  readonly authorization: AdminV2Authorization;
  readonly contract: AdminV2ApiContract;
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
): AdminV2ApiOperation {
  return {
    id: `${method} ${route}`,
    method,
    route,
    authorization,
    contract: { request, response },
    ...(responseProjectionBy ? { responseProjectionBy } : {}),
  };
}

const collaborationRead = ["character.project.read", "creative.run.read", "case.read", "ops.incident.read"] as const;
const collaborationWrite = ["character.project.write", "creative.run.write", "case.assign", "ops.incident.manage"] as const;
const commandTargetRead = ["character.release.read", "creative.run.read", "ops.incident.read", "case.read"] as const;
const todayClaimWrite = ["case.assign", "ops.incident.manage", "character.project.write", "creative.run.write"] as const;

/**
 * Main authority SSoT for every public Admin v2 Route Handler operation.
 *
 * Resource-sensitive operations deliberately enumerate the only permissions their
 * resolver may select. They are not equivalent to an `admin` role or a blanket
 * dashboard capability.
 */
export const ADMIN_V2_API_OPERATIONS = [
  operation("GET", "/api/v2/admin/bootstrap", bootstrap(), "none", "adminBootstrapSchema"),

  operation("GET", "/api/v2/admin/cases", allOf("case.read"), "operationsCaseQuerySchema", "operationsCaseListResponseSchema"),
  operation("POST", "/api/v2/admin/cases/backfill", allOf("case.decide"), "adminBackfillRequestSchema", "adminBackfillResultSchema"),
  operation("POST", "/api/v2/admin/cases/backfill/customer", allOf("case.decide"), "adminBackfillRequestSchema", "adminBackfillResultSchema"),
  operation("GET", "/api/v2/admin/cases/:id", allOf("case.read"), "path:id", "operationsCaseDetailSchema"),
  operation("POST", "/api/v2/admin/cases/:id/actions", allOf("case.decide"), "customerCaseActionRequestSchema+idempotency-key", "operationsCaseSchema"),
  operation("POST", "/api/v2/admin/cases/:id/assignment", allOf("case.assign"), "caseAssignmentRequestSchema+idempotency-key", "operationsCaseSchema"),
  operation("POST", "/api/v2/admin/cases/:id/commands/close", allOf("case.decide"), "caseCloseCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/cases/:id/commands/reopen", allOf("case.decide"), "caseReopenRequestSchema+idempotency-key", "operationsCaseSchema"),
  operation("POST", "/api/v2/admin/cases/:id/commands/wait", allOf("case.assign"), "caseWaitRequestSchema+idempotency-key", "operationsCaseSchema"),
  operation("POST", "/api/v2/admin/cases/:id/decisions", allOf("case.decide"), "caseDecisionRequestSchema+idempotency-key", "operationsCaseSchema"),
  operation("POST", "/api/v2/admin/cases/:id/verification", allOf("case.decide"), "caseVerificationRequestSchema+idempotency-key", "operationsCaseSchema"),

  operation("POST", "/api/v2/admin/characters", allOf("character.project.write"), "characterProjectCreateRequestSchema+idempotency-key", "characterProjectCreateResponseSchema"),
  operation("GET", "/api/v2/admin/characters/portfolio", allOf("character.performance.read"), "characterPortfolioQuerySchema", "characterPortfolioResponseSchema"),
  operation("POST", "/api/v2/admin/characters/performance/backfill", allOf("analytics.metric.export"), "characterPerformanceBackfillRequestSchema", "characterPerformanceBackfillResponseSchema"),
  operation("GET", "/api/v2/admin/characters/performance/reconciliation", allOf("analytics.metric.read"), "none", "characterPerformanceReconciliationSchema"),
  operation("POST", "/api/v2/admin/characters/route-qualifications/commands/evaluate", allOf("content.production.write"), "generationRouteQualificationEvaluateRequestSchema", "generationRouteQualificationEvaluateResponseSchema"),
  operation("GET", "/api/v2/admin/characters/:id", allOf("character.project.read", "character.release.read", "character.performance.read"), "path:id", "characterWorkspaceDetailSchema"),
  operation("POST", "/api/v2/admin/characters/:id/commands/pause", allOf("character.release.publish"), "adminCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/commands/resume", allOf("character.release.publish"), "adminCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/commands/retire", allOf("character.release.publish"), "adminCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/portfolio-decisions", allOf("character.project.write"), "characterPortfolioDecisionRequestSchema", "characterPortfolioDecisionRecordSchema"),
  operation("GET", "/api/v2/admin/characters/:id/project", allOf("character.project.write"), "path:id", "characterProjectDraftResumeSchema"),
  operation("PATCH", "/api/v2/admin/characters/:id/project", allOf("character.project.write"), "characterProjectDraftPatchRequestSchema+if-match", "characterProjectDraftResumeSchema"),
  operation("POST", "/api/v2/admin/characters/:id/qa-runs", allOf("character.release.review"), "characterQaRunCreateRequestSchema", "characterQaRunSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases", allOf("character.release.propose"), "characterReleaseProposalRequestSchema", "characterReleaseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/commands/publish", allOf("character.release.publish"), "characterReleasePublishCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/commands/rollback", allOf("character.release.publish"), "characterReleaseRollbackCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/commands/schedule", allOf("character.release.publish"), "characterReleaseScheduleCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/monitors/:window/refresh", allOf("character.release.review"), "characterReleaseMonitorRefreshRequestSchema", "characterReleaseMonitorSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/review", allOf("character.release.review"), "characterReleaseReviewRequestSchema", "characterReleaseSchema"),
  operation("POST", "/api/v2/admin/characters/:id/releases/:releaseId/validation", allOf("character.release.publish"), "characterReleaseValidationRequestSchema", "characterReleaseSchema"),

  operation("POST", "/api/v2/admin/chat/sessions/:sessionId/commands/migrate-release", allOf("character.release.publish"), "characterSessionReleaseMigrationCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),

  operation("GET", "/api/v2/admin/collaboration/:targetType/:targetId/activity", oneOfBy("collaboration_target_read", ...collaborationRead), "collaborationQuerySchema", "collaborationActivityListResponseSchema"),
  operation("POST", "/api/v2/admin/collaboration/:targetType/:targetId/activity", oneOfBy("collaboration_target_write", ...collaborationWrite), "collaborationActivityCreateSchema+idempotency-key", "collaborationActivityMutationSchema"),
  operation("PUT", "/api/v2/admin/collaboration/:targetType/:targetId/watch", oneOfBy("collaboration_target_read", ...collaborationRead), "collaborationWatchSchema+idempotency-key", "collaborationWatchResponseSchema"),
  operation("GET", "/api/v2/admin/collaboration/mentions", allOf("dashboard.read"), "collaborationQuerySchema", "collaborationActivityListResponseSchema", collaborationRead),
  operation("GET", "/api/v2/admin/commands/:commandId", allOfAndOneOfBy("command_target_read", ["dashboard.read"], commandTargetRead), "path:commandId", "adminCommandStatusSchema"),

  operation("GET", "/api/v2/admin/creative/runs", allOf("creative.run.read"), "creativeRunQuerySchema", "creativeRunListResponseSchema"),
  operation("POST", "/api/v2/admin/creative/runs", allOf("creative.run.write"), "creativeRunCreateRequestSchema+idempotency-key", "creativeRunDetailSchema"),
  operation("GET", "/api/v2/admin/creative/runs/:id", allOf("creative.run.read"), "path:id", "creativeRunDetailSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/commands/attach-incident", allOf("ops.incident.manage", "creative.run.write"), "creativeRunAttachIncidentRequestSchema", "creativeRunDetailSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/commands/retry-failed", allOf("creative.run.write"), "creativeRunRetryFailedCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/items/:itemId/decisions", allOf("creative.run.review"), "creativeReviewDecisionRequestSchema", "creativeRunDetailSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/placements", allOf("creative.placement.publish"), "creativePlacementPublishRequestSchema", "creativeRunDetailSchema"),
  operation("POST", "/api/v2/admin/creative/runs/:id/placements/:placementId/verification", allOf("creative.placement.publish"), "creativePlacementVerificationRequestSchema", "creativeRunDetailSchema"),

  operation("GET", "/api/v2/admin/customers", allOf("customer.read"), "customerListQuerySchema", "customerListResponseSchema"),
  operation("GET", "/api/v2/admin/customers/:id", allOf("customer.read"), "path:id", "customer360Schema"),

  operation("GET", "/api/v2/admin/experiments", allOf("experiment.manage"), "limit-query", "experimentDefinitionListSchema"),
  operation("POST", "/api/v2/admin/experiments", allOf("experiment.manage"), "experimentDefinitionCreateSchema+idempotency-key", "experimentDefinitionSchema"),
  operation("GET", "/api/v2/admin/experiments/:id", allOf("experiment.manage"), "path:id", "experimentDefinitionSchema"),
  operation("GET", "/api/v2/admin/experiments/:id/analysis", allOf("experiment.manage"), "experimentAnalysisQuerySchema", "experimentAnalysisResponseSchema"),
  operation("POST", "/api/v2/admin/experiments/:id/commands/start", allOf("experiment.manage"), "experimentLifecycleRequestSchema+idempotency-key", "experimentDefinitionSchema"),
  operation("POST", "/api/v2/admin/experiments/:id/commands/stop", allOf("experiment.manage"), "experimentLifecycleRequestSchema+idempotency-key", "experimentDefinitionSchema"),

  operation("POST", "/api/v2/admin/generation/requests/:id/commands/cancel", allOf("generation.job.requeue"), "generationRequestCancelSchema+idempotency-key", "generationRequestCancelResultSchema"),

  operation("GET", "/api/v2/admin/incidents", allOf("ops.incident.read"), "incidentQuerySchema", "incidentListResponseSchema"),
  operation("POST", "/api/v2/admin/incidents/backfill", allOf("ops.incident.manage"), "adminBackfillRequestSchema", "adminBackfillResultSchema"),
  operation("GET", "/api/v2/admin/incidents/:id", allOf("ops.incident.read"), "path:id", "incidentDetailSchema"),
  operation("PATCH", "/api/v2/admin/incidents/:id", allOf("ops.incident.manage"), "incidentTriageRequestSchema+if-match", "incidentDetailSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/action-plans/preview", allOf("ops.incident.manage"), "incidentActionPlanPreviewRequestSchema+idempotency-key", "incidentActionPlanSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/action-plans/:planId/execute", allOf("ops.incident.manage"), "incidentActionPlanExecuteRequestSchema+idempotency-key", "incidentDetailSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/close", allOf("ops.incident.manage"), "incidentCloseRequestSchema+idempotency-key", "incidentDetailSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/merge", allOf("ops.incident.manage"), "incidentMergeRequestSchema+idempotency-key", "incidentDetailSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/resolve", allOf("ops.incident.manage"), "incidentResolveCommandRequestSchema+idempotency-key", "adminCommandAcceptedSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/commands/split", allOf("ops.incident.manage"), "incidentSplitRequestSchema+idempotency-key", "incidentDetailSchema"),
  operation("POST", "/api/v2/admin/incidents/:id/verification", allOf("ops.incident.manage"), "incidentRecoveryVerificationRequestSchema+idempotency-key", "incidentDetailSchema"),

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
  operation("POST", "/api/v2/admin/today/claim", allOfAndOneOfBy("today_claim_source_write", ["dashboard.read"], todayClaimWrite), "todayClaimRequestSchema+idempotency-key", "todayClaimResponseSchema"),
  operation("PUT", "/api/v2/admin/today/preferences", allOf("dashboard.read"), "operationalWorkPreferenceUpdateSchema+if-match", "operationalWorkPreferenceSchema"),

  operation("GET", "/api/v2/admin/users/:id/grant-bundles", allOf("user.role.write"), "path:id", "adminGrantBundleListSchema"),
  operation("POST", "/api/v2/admin/users/:id/grant-bundles", allOf("user.role.write"), "adminGrantBundleWriteSchema", "adminGrantBundleMutationSchema"),
  operation("DELETE", "/api/v2/admin/users/:id/grant-bundles/:bundleKey", allOf("user.role.write"), "adminGrantBundleRevokeSchema", "adminGrantBundleMutationSchema"),
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
