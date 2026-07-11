import { describe, expect, it } from "vitest";
import {
  adminCommandAcceptedSchema,
  adminCommandHeadersSchema,
  adminErrorResponseSchema,
  adminListResponseSchema,
  approvalBindingSchema,
  ADMIN_METRIC_REGISTRY,
  characterProjectSchema,
  characterReleaseSchema,
  creativeRunSchema,
  deriveCreativeExecutionOutcome,
  incidentSchema,
  metricCardSchema,
  metricDefinitionSchema,
  operationsCaseSchema,
  todayProjectionSchema,
} from "./index";

const now = "2026-07-11T12:00:00.000Z";

describe("Admin API v2 public contracts", () => {
  it("requires authoritative totals and provenance for every Today queue", () => {
    const emptyQueue = { totalCount: 0, items: [] };
    expect(todayProjectionSchema.safeParse({
      myShift: emptyQueue,
      nextBestActions: emptyQueue,
      unassigned: emptyQueue,
      watching: emptyQueue,
      recentlyResolved: emptyQueue,
      asOf: now,
      freshness: "fresh",
      workMode: "admin",
      rankingPolicyVersion: "today-ranking-v1",
    }).success).toBe(true);
    expect(todayProjectionSchema.safeParse({
      myShift: { items: [] },
      nextBestActions: emptyQueue,
      unassigned: emptyQueue,
      watching: emptyQueue,
      recentlyResolved: emptyQueue,
      asOf: now,
      freshness: "fresh",
      workMode: "admin",
      rankingPolicyVersion: "today-ranking-v1",
    }).success).toBe(false);
  });

  it("accepts a cursor list envelope and rejects a response without freshness metadata", () => {
    const schema = adminListResponseSchema(characterProjectSchema);
    const project = {
      id: "project_1",
      characterId: "character_1",
      ownerId: "user_1",
      phase: "producing",
      audience: "relationship-focused adults",
      companionNeed: "consistent daily conversation",
      hypothesis: "a calm voice improves return visits",
      differentiation: "grounded and reflective",
      targetPlacementKeys: ["explore.featured"],
      successCriteria: ["same-character D7 improves"],
      plannedLaunchAt: now,
      version: 3,
      createdAt: now,
      updatedAt: now,
    };

    expect(
      schema.safeParse({
        items: [project],
        pageInfo: { endCursor: "cursor_1", hasNextPage: true },
        asOf: now,
        freshness: "fresh",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        items: [project],
        pageInfo: { endCursor: null, hasNextPage: false },
        asOf: now,
      }).success,
    ).toBe(false);
  });

  it("validates immutable release provenance and rejects a release without an identity anchor", () => {
    const fixture = {
      id: "release_1",
      projectId: "project_1",
      revisionId: "revision_1",
      characterContentVersionId: "content_1",
      visualIdentity: {
        visualProfileId: "visual_1",
        visualProfileVersion: 2,
        anchorAssetId: "asset_anchor",
        referenceSetRevisionId: "refs_1",
      },
      generationRoute: {
        generationProfileKey: "portrait",
        generationProfileVersion: "2",
        workflowKey: "character-cover",
        workflowVersion: "3",
      },
      releaseOwnedPlacements: [],
      snapshotHash: "sha256:release",
      policyVersion: "release-policy-v2",
      status: "approved",
      publishedAt: null,
      supersedesId: null,
      rollbackOfReleaseId: null,
      version: 4,
      createdAt: now,
      updatedAt: now,
    };

    expect(characterReleaseSchema.safeParse(fixture).success).toBe(true);
    expect(
      characterReleaseSchema.safeParse({
        ...fixture,
        visualIdentity: { ...fixture.visualIdentity, anchorAssetId: null },
      }).success,
    ).toBe(false);
  });

  it.each([
    [{ generated: 0, failed: 4, reviewed: 0, approved: 0, placed: 0, total: 4 }, "failed"],
    [{ generated: 1, failed: 3, reviewed: 1, approved: 1, placed: 0, total: 4 }, "partially_succeeded"],
    [{ generated: 4, failed: 0, reviewed: 4, approved: 4, placed: 4, total: 4 }, "succeeded"],
  ] as const)("derives creative outcome from item facts", (counts, expected) => {
    expect(deriveCreativeExecutionOutcome(counts)).toBe(expected);
  });

  it("rejects creative count combinations that cannot be true", () => {
    const fixture = {
      id: "run_1",
      purpose: "character_cover",
      target: { type: "character_release", id: "release_1" },
      ownerId: "user_1",
      dueAt: now,
      priority: "high",
      lifecycleState: "active",
      workflowStage: "review",
      executionOutcome: "partially_succeeded",
      reviewState: "in_review",
      deploymentState: "unplaced",
      verificationState: "pending",
      counts: { generated: 1, failed: 3, reviewed: 2, approved: 0, placed: 0, total: 4 },
      version: 2,
      createdAt: now,
      updatedAt: now,
    };
    expect(creativeRunSchema.safeParse(fixture).success).toBe(false);
  });

  it("accepts incident and typed case read models while rejecting incomplete resolution", () => {
    expect(
      incidentSchema.safeParse({
        id: "incident_1",
        signature: "provider|profile|workflow|timeout|v1",
        signatureVersion: "v1",
        status: "mitigating",
        severity: "critical",
        ownerId: "ops_1",
        firstSeenAt: now,
        lastSeenAt: now,
        impact: { affectedRequests: 8, affectedUsers: 6, failedCostMicros: 5000, refundMicros: 0 },
        suspectedCause: "provider timeout",
        causeConfidence: 0.8,
        recommendedActions: ["pause route"],
        runbookUrl: "/admin/system/runbooks/provider-timeout",
        rollbackTarget: null,
        recoveryVerification: { state: "verifying", checkedAt: now, evidenceRefs: [] },
        version: 2,
        createdAt: now,
        updatedAt: now,
      }).success,
    ).toBe(true);

    const closedWithoutResolution = {
      id: "case_1",
      type: "support_request",
      target: { type: "customer", id: "customer_1" },
      caseKey: "support:customer_1:delivery",
      status: "closed",
      priority: "normal",
      severity: "medium",
      ownerId: "support_1",
      slaDueAt: now,
      reportCount: 1,
      messageCount: 2,
      resolutionSummary: null,
      verification: null,
      relatedIncidentIds: [],
      relatedCaseIds: [],
      version: 5,
      createdAt: now,
      updatedAt: now,
    };
    expect(operationsCaseSchema.safeParse(closedWithoutResolution).success).toBe(false);
  });

  it("requires decision-grade metadata on metric definitions and cards", () => {
    const definition = {
      key: "relationship.same_character_d1",
      name: "Same-character D1",
      description: "Exact next-product-day return to the same character.",
      businessQuestion: "Do qualified relationships return the next day?",
      numerator: "mature pairs with a QCE on D0+1",
      denominator: "mature first-QCE pair cohort",
      grain: "user_character_pair",
      sourceFacts: ["qualified_conversation_episode"],
      sourceEvents: ["chat.exchange.completed.v2"],
      requiredTrustClasses: ["canonical"],
      exclusions: ["internal actors", "non-customer data"],
      cohort: "first QCE pair UTC product day",
      window: "exact D0+1 UTC product day",
      timezone: "UTC",
      maturity: "cohort product day + 2 days",
      dedupe: "one pair per cohort product day",
      attributionRule: "same character only",
      owner: "Growth Analytics",
      version: 1,
      effectiveAt: now,
      queryHash: "sha256:d1-v1",
      freshnessSlo: { maxAgeSeconds: 86400 },
      qualityState: "invalid",
      decisionUse: "blocked",
      lastValidatedAt: null,
      validationEvidence: [],
    };
    expect(metricDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(metricDefinitionSchema.safeParse({ ...definition, queryHash: "" }).success).toBe(false);

    expect(
      metricCardSchema.safeParse({
        key: definition.key,
        definitionVersion: 1,
        name: definition.name,
        value: null,
        unit: "percent",
        numeratorLabel: definition.numerator,
        denominatorLabel: definition.denominator,
        numeratorValue: null,
        denominatorValue: null,
        sampleSize: 0,
        window: definition.window,
        maturity: "immature",
        latestDataAt: now,
        qualityState: "invalid",
      }).success,
    ).toBe(true);
  });

  it("uses stable command and error envelopes", () => {
    expect(
      adminCommandHeadersSchema.safeParse({
        idempotencyKey: "publish-release-1-v4",
        ifMatch: '"4"',
        requestId: "request_1",
      }).success,
    ).toBe(true);
    expect(
      approvalBindingSchema.safeParse({
        commandType: "character.release.publish",
        target: { type: "character_release", id: "release_1" },
        payloadHash: "sha256:payload",
        expectedVersion: 4,
        expiresAt: now,
      }).success,
    ).toBe(true);
    expect(
      adminCommandAcceptedSchema.safeParse({
        status: "accepted",
        requestId: "request_1",
        commandId: "command_1",
        verificationDeepLink: "/admin/ops/commands/command_1",
      }).success,
    ).toBe(true);
    expect(
      adminErrorResponseSchema.safeParse({
        ok: false,
        error: {
          code: "permission_denied",
          message: "Missing admin permission",
          requestId: "request_1",
          permission: "character.release.publish",
        },
      }).success,
    ).toBe(true);
    expect(
      adminErrorResponseSchema.safeParse({
        ok: false,
        error: { code: "permission_denied", message: "Denied", requestId: "request_1" },
      }).success,
    ).toBe(false);
  });

  it("ships an immutable registry with unsafe legacy metrics blocked for decisions", () => {
    const identities = ADMIN_METRIC_REGISTRY.map(({ key, version }) => `${key}@${version}`);
    expect(new Set(identities).size).toBe(identities.length);
    for (const key of [
      "legacy.activated_users",
      "legacy.signup_to_paid_conversion",
      "legacy.same_character_d1",
      "legacy.same_character_d7",
    ]) {
      expect(ADMIN_METRIC_REGISTRY.find((definition) => definition.key === key)).toMatchObject({
        qualityState: "invalid",
        decisionUse: "blocked",
      });
    }
    expect(ADMIN_METRIC_REGISTRY.find((definition) => definition.key === "flag_monitoring.exposure")).toMatchObject({
      qualityState: "directional",
      decisionUse: "directional_only",
    });
  });
});
