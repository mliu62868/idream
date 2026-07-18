import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createMedia, createUser } from "@/server/test/helpers";
import { recordGenerationAttemptEvent } from "@/server/ai/generation-attempt-events";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "../characters/release-snapshot";
import { auditAdminCutoverInvariants } from "./invariants";

interface GraphOptions {
  readonly emptyReferenceSet?: boolean;
  readonly generationProvenance?: Prisma.InputJsonValue;
  readonly releasePlacementManifest?: Prisma.InputJsonValue;
  readonly releaseContentId?: string;
  readonly releaseRevisionId?: string;
  readonly releaseVisualProfileId?: string | null;
  readonly releaseVisualProfileVersion?: number | null;
  readonly releaseReferenceSetId?: string | null;
  readonly snapshotHash?: string;
  readonly tamperProfileHash?: boolean;
  readonly tamperReferenceHash?: boolean;
  readonly legacy?: boolean;
}

describe("Admin cutover invariant adversarial release authority", () => {
  const suffix = randomUUID();
  const prefix = `00-invariant-adversarial-${suffix}`;
  const userId = `${prefix}-user`;
  const mediaId = `${prefix}-media`;
  const releaseIds: string[] = [];
  const characterIds: string[] = [];
  const projectIds: string[] = [];
  const profileIds: string[] = [];
  const referenceSetIds: string[] = [];
  const qaRunIds: string[] = [];
  const partialFactId = `${prefix}-partial-fact`;
  const partialRequestId = `${prefix}-partial-request`;
  const missingPartialFactRequestId = `${prefix}-partial-without-fact`;
  const creativeMismatchId = `${prefix}-creative-mismatch`;
  const overRefundRequestId = `${prefix}-over-refund-request`;
  const capturedLedgerId = `${prefix}-captured-ledger`;
  const refundLedgerId = `${prefix}-refund-ledger`;
  const terminalCaseId = `${prefix}-terminal-case-with-active-key`;
  const activeCaseWithoutKeyId = `${prefix}-active-case-without-key`;
  const terminalIncidentId = `${prefix}-terminal-incident-with-active-key`;
  const cancelledRequestId = `${prefix}-cancelled-request-with-succeeded-attempt`;
  const mismatchedSucceededRequestId = `${prefix}-mismatched-succeeded-request`;
  const cancelledAttemptId = `${prefix}-cancelled-request-attempt`;
  const mismatchedSucceededAttemptId = `${prefix}-mismatched-succeeded-attempt`;
  const unlinkedSettlementRequestId = `${prefix}-unlinked-settlement-request`;
  const unlinkedSettlementLedgerId = `${prefix}-unlinked-settlement-ledger`;

  const validPlacement = {
    placements: [
      { slotKey: "character_avatar", assetId: mediaId, slotVersion: 1 },
    ],
  } satisfies Prisma.InputJsonObject;

  async function createReleaseGraph(label: string, options: GraphOptions = {}) {
    const characterId = `${prefix}-${label}-character`;
    const projectId = `${prefix}-${label}-project`;
    const contentId = `${prefix}-${label}-content`;
    const revisionId = `${prefix}-${label}-revision`;
    const profileId = `${prefix}-${label}-profile`;
    const referenceSetId = `${prefix}-${label}-references`;
    const releaseId = `${prefix}-${label}-release`;
    const qaRunId = `${prefix}-${label}-qa`;
    const qaEvidenceHash = `${prefix}-${label}-qa-hash`;
    const generationProvenance = options.generationProvenance ?? {
      routeFingerprint: `${prefix}:route`,
      matrixKey: "default-character",
      generationProfileKey: "portrait",
      generationProfileVersion: 1,
      workflowKey: "identity",
      workflowVersion: 1,
      characterQa: { status: "passed", qaRunId, evidenceHash: qaEvidenceHash },
    } satisfies Prisma.InputJsonObject;
    const releasePlacementManifest = options.releasePlacementManifest ?? validPlacement;

    characterIds.push(characterId);
    projectIds.push(projectId);
    profileIds.push(profileId);
    referenceSetIds.push(referenceSetId);
    releaseIds.push(releaseId);
    qaRunIds.push(qaRunId);

    await prisma.character.create({
      data: {
        id: characterId,
        name: `Invariant ${label}`,
        age: 27,
        description: "Adversarial invariant fixture",
        visibility: "private",
        status: "approved",
        source: "user",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "launch_ready",
        audience: { segment: "test" },
        successCriteria: ["invariant coverage"],
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `${prefix}-${label}-content-hash`,
        personaSnapshot: { systemPrompt: "Stay in persona." },
        openingSnapshot: { firstMessage: "Hello." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "test",
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: { label },
      },
    });
    await prisma.characterQaRun.create({
      data: {
        id: qaRunId,
        characterId,
        projectId,
        characterContentVersionId: contentId,
        projectVersion: 1,
        ownerId: userId,
        status: "passed",
        checks: [],
        evidenceHash: qaEvidenceHash,
      },
    });
    const visualProfile = {
      id: profileId,
      characterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "stable identity",
      negativeIdentityPrompt: null,
      faceTraits: { eyes: "amber" },
      hairTraits: { color: "black" },
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: { style: "realistic" },
      anchorAssetIds: [mediaId],
      referenceAssetIds: [mediaId],
      adapterRefs: {},
      evidenceState: "qualified",
      createdFrom: "test",
    };
    await prisma.characterVisualProfile.create({
      data: {
        ...visualProfile,
        immutableHash: options.tamperProfileHash
          ? "tampered-profile-hash"
          : characterVisualProfileSnapshotHash(visualProfile),
      },
    });
    const references = options.emptyReferenceSet
      ? []
      : [{ mediaAssetId: mediaId, position: 0, role: "primary_face", weight: 1 }];
    await prisma.referenceSetRevision.create({
      data: {
        id: referenceSetId,
        visualProfileId: profileId,
        revision: 1,
        status: "active",
        selectorVersion: "v2",
        snapshotHash: options.tamperReferenceHash
          ? "tampered-reference-hash"
          : referenceSetSnapshotHash({
              visualProfileId: profileId,
              revision: 1,
              selectorVersion: "v2",
              references,
            }),
        createdFrom: "test",
        references: references.length === 0
          ? undefined
          : {
              create: {
                mediaAssetId: mediaId,
                position: 0,
                role: "primary_face",
                selectionReason: "adversarial invariant fixture",
              },
            },
      },
    });

    const snapshot = {
      projectId,
      revisionId: options.releaseRevisionId ?? revisionId,
      characterContentVersionId: options.releaseContentId ?? contentId,
      visualProfileId: options.releaseVisualProfileId === undefined
        ? profileId
        : options.releaseVisualProfileId,
      visualProfileVersion: options.releaseVisualProfileVersion === undefined
        ? 1
        : options.releaseVisualProfileVersion,
      referenceSetRevisionId: options.releaseReferenceSetId === undefined
        ? referenceSetId
        : options.releaseReferenceSetId,
      generationProvenance,
      releasePlacementManifest,
    };
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        ...snapshot,
        snapshotHash: options.snapshotHash ?? characterReleaseSnapshotHash(snapshot),
        status: "published",
        readiness: "ready",
        legacy: options.legacy ?? false,
        publishedAt: new Date("2026-07-11T00:00:00.000Z"),
      },
    });
    await prisma.characterServing.create({
      data: {
        id: `${prefix}-${label}-serving`,
        characterId,
        currentReleaseId: releaseId,
        state: "live",
      },
    });
    return { characterId, contentId, profileId, projectId, referenceSetId, releaseId, revisionId };
  }

  beforeAll(async () => {
    await createUser({ id: userId });
    await createMedia({ id: mediaId, ownerId: userId, visibility: "public" });

    await createReleaseGraph("tampered-release", { snapshotHash: "tampered-release-hash" });
    await createReleaseGraph("empty-manifest", {
      generationProvenance: {},
      releasePlacementManifest: {},
    });
    await createReleaseGraph("missing-join", {
      releaseContentId: `${prefix}-missing-content`,
      releaseRevisionId: `${prefix}-missing-revision`,
    });
    await createReleaseGraph("missing-identity-reference", {
      releaseVisualProfileId: null,
      releaseVisualProfileVersion: null,
      releaseReferenceSetId: null,
    });
    await createReleaseGraph("legacy-missing-identity-reference", {
      legacy: true,
      releaseVisualProfileId: null,
      releaseVisualProfileVersion: null,
      releaseReferenceSetId: null,
    });
    await createReleaseGraph("wrong-identity-reference", {
      tamperProfileHash: true,
      tamperReferenceHash: true,
    });
    await createReleaseGraph("empty-reference", { emptyReferenceSet: true });
    const scheduledInvalid = await createReleaseGraph("scheduled-invalid", {
      generationProvenance: {},
      releasePlacementManifest: {},
      releaseVisualProfileId: null,
      releaseVisualProfileVersion: null,
      releaseReferenceSetId: null,
    });
    await prisma.characterRelease.update({
      where: { id: scheduledInvalid.releaseId },
      data: { status: "approved", publishedAt: null },
    });
    await prisma.characterServing.update({
      where: { characterId: scheduledInvalid.characterId },
      data: {
        currentReleaseId: null,
        scheduledReleaseId: scheduledInvalid.releaseId,
        scheduledAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const scheduledWrongStatus = await createReleaseGraph("scheduled-wrong-status");
    await prisma.characterServing.update({
      where: { characterId: scheduledWrongStatus.characterId },
      data: {
        currentReleaseId: null,
        scheduledReleaseId: scheduledWrongStatus.releaseId,
        scheduledAt: new Date("2030-01-03T00:00:00.000Z"),
      },
    });
    const officialNotLive = await createReleaseGraph("official-not-live");
    await prisma.character.update({
      where: { id: officialNotLive.characterId },
      data: { source: "official", visibility: "public", status: "approved" },
    });
    await prisma.characterServing.update({
      where: { characterId: officialNotLive.characterId },
      data: { state: "paused" },
    });
    const officialLiveProjectionMismatch = await createReleaseGraph("official-live-projection-mismatch");
    await prisma.character.update({
      where: { id: officialLiveProjectionMismatch.characterId },
      data: {
        source: "official",
        visibility: "public",
        status: "approved",
        imageAssetId: null,
      },
    });
    const crossCharacter = await createReleaseGraph("cross-character");
    const servingCharacterId = `${prefix}-cross-serving-character`;
    characterIds.push(servingCharacterId);
    await prisma.character.create({
      data: {
        id: servingCharacterId,
        name: "Cross-character serving owner",
        age: 28,
        description: "Owns a deliberately foreign release pointer",
        visibility: "private",
        status: "approved",
        source: "user",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterServing.update({
      where: { characterId: crossCharacter.characterId },
      data: { characterId: servingCharacterId },
    });

    await prisma.generationJob.create({
      data: {
        id: partialRequestId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 2,
        status: "completed",
      },
    });
    await prisma.generationDelivery.createMany({
      data: [0, 1].map((ordinal) => ({
        id: `${prefix}-partial-delivery-${ordinal}`,
        requestId: partialRequestId,
        artifactId: `${prefix}-partial-artifact-${ordinal}`,
        targetType: "gallery",
        targetId: userId,
        status: "delivered",
        deliveredAt: new Date("2026-07-11T00:00:00.000Z"),
      })),
    });
    await prisma.generationFulfillmentFact.create({
      data: {
        id: partialFactId,
        requestId: partialRequestId,
        sourceService: "main",
        sourceEventId: `${prefix}-partial-event`,
        artifactId: `${prefix}-artifact`,
        userId,
        expectedOutputCount: 2,
        deliveredOutputCount: 1,
        outcome: "partial",
        environment: "test",
        dataClass: "fixture",
        trustClass: "synthetic",
        eligible: false,
        occurredAt: new Date("2026-07-11T00:00:00.000Z"),
        validFrom: new Date("2026-07-11T00:00:00.000Z"),
      },
    });
    await prisma.generationJob.create({
      data: {
        id: missingPartialFactRequestId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 2,
        deliveredOutputCount: 1,
        status: "completed",
      },
    });
    await prisma.generationDelivery.create({
      data: {
        id: `${prefix}-missing-fact-delivery`,
        requestId: missingPartialFactRequestId,
        artifactId: `${prefix}-missing-fact-artifact`,
        targetType: "gallery",
        targetId: userId,
        status: "delivered",
        deliveredAt: new Date("2026-07-11T00:00:00.000Z"),
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: creativeMismatchId,
        title: "Deliberately stale child projection",
        purpose: "model_eval",
        targetType: "none",
        presetIds: [],
        totalItems: 2,
        completedItems: 2,
        approvedItems: 2,
        status: "completed",
        createdById: userId,
        items: {
          create: [
            { id: `${creativeMismatchId}-item-1`, itemIndex: 0, status: "queued", tags: [] },
            { id: `${creativeMismatchId}-item-2`, itemIndex: 1, status: "failed", tags: [] },
          ],
        },
      },
    });
    await prisma.generationJob.create({
      data: {
        id: overRefundRequestId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
      },
    });
    await prisma.dreamcoinLedger.createMany({
      data: [
        {
          id: capturedLedgerId,
          userId,
          delta: -5,
          balanceAfter: 95,
          reason: "generation_spend",
          sourceId: overRefundRequestId,
          idempotencyKey: `${prefix}-captured`,
        },
        {
          id: refundLedgerId,
          userId,
          delta: 7,
          balanceAfter: 102,
          reason: "refund",
          sourceId: overRefundRequestId,
          idempotencyKey: `${prefix}-refund`,
        },
      ],
    });
    await prisma.generationSettlementLink.createMany({
      data: [
        { requestId: overRefundRequestId, ledgerEntryId: capturedLedgerId, kind: "generation_spend" },
        { requestId: overRefundRequestId, ledgerEntryId: refundLedgerId, kind: "refund" },
      ],
    });
    await prisma.adminCase.createMany({
      data: [
        {
          id: terminalCaseId,
          type: "support_request",
          targetType: "user",
          targetId: userId,
          caseKey: `${prefix}:terminal`,
          activeKey: `${prefix}:terminal-active-key`,
          status: "resolved",
        },
        {
          id: activeCaseWithoutKeyId,
          type: "support_request",
          targetType: "user",
          targetId: userId,
          caseKey: `${prefix}:active-without-key`,
          activeKey: null,
          status: "in_progress",
        },
      ],
    });
    await prisma.opsIncident.create({
      data: {
        id: terminalIncidentId,
        signature: `${prefix}:terminal-signature`,
        signatureVersion: "generation-error-v1",
        activeCorrelationKey: `${prefix}:terminal-correlation`,
        status: "resolved",
        severity: "medium",
        firstSeen: new Date("2026-07-11T00:00:00.000Z"),
        lastSeen: new Date("2026-07-11T00:01:00.000Z"),
        impact: {},
        mitigation: {},
        verificationState: "passed",
      },
    });
    await prisma.generationJob.createMany({
      data: [
        {
          id: cancelledRequestId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          outputCount: 1,
          status: "cancelled",
        },
        {
          id: mismatchedSucceededRequestId,
          userId,
          mode: "image",
          controls: {},
          presetIds: [],
          outputCount: 2,
          deliveredOutputCount: 1,
          status: "completed",
        },
      ],
    });
    await prisma.generationAttempt.createMany({
      data: [
        { id: cancelledAttemptId, requestId: cancelledRequestId, attemptNo: 1, status: "running" },
        { id: mismatchedSucceededAttemptId, requestId: mismatchedSucceededRequestId, attemptNo: 1, status: "running" },
      ],
    });
    await prisma.$transaction(async (tx) => {
      await recordGenerationAttemptEvent(tx, {
        eventId: `${cancelledAttemptId}:succeeded`,
        attemptId: cancelledAttemptId,
        eventType: "generation.attempt.succeeded.v1",
        outcome: "succeeded",
        occurredAt: new Date("2026-07-11T00:02:00.000Z"),
        payload: { lateAfterCancellation: true },
      });
      await recordGenerationAttemptEvent(tx, {
        eventId: `${mismatchedSucceededAttemptId}:succeeded`,
        attemptId: mismatchedSucceededAttemptId,
        eventType: "generation.attempt.succeeded.v1",
        outcome: "succeeded",
        occurredAt: new Date("2026-07-11T00:03:00.000Z"),
        payload: { requestOutcome: "succeeded" },
      });
    });
    await prisma.generationDelivery.create({
      data: {
        id: `${prefix}-mismatched-succeeded-delivery`,
        requestId: mismatchedSucceededRequestId,
        artifactId: `${prefix}-mismatched-succeeded-artifact`,
        targetType: "gallery",
        targetId: userId,
        status: "delivered",
        deliveredAt: new Date("2026-07-11T00:03:00.000Z"),
      },
    });
    await prisma.generationFulfillmentFact.create({
      data: {
        id: `${prefix}-mismatched-succeeded-fact`,
        requestId: mismatchedSucceededRequestId,
        sourceService: "main",
        sourceEventId: `${prefix}-mismatched-succeeded-event`,
        artifactId: `${prefix}-mismatched-succeeded-asset`,
        userId,
        expectedOutputCount: 2,
        deliveredOutputCount: 2,
        outcome: "succeeded",
        environment: "test",
        dataClass: "fixture",
        trustClass: "synthetic",
        eligible: false,
        occurredAt: new Date("2026-07-11T00:03:00.000Z"),
        validFrom: new Date("2026-07-11T00:03:00.000Z"),
      },
    });
    await prisma.generationJob.create({
      data: {
        id: unlinkedSettlementRequestId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
      },
    });
    await prisma.dreamcoinLedger.create({
      data: {
        id: unlinkedSettlementLedgerId,
        userId,
        delta: -3,
        balanceAfter: 92,
        reason: "generation_spend",
        sourceId: unlinkedSettlementRequestId,
        idempotencyKey: `${prefix}-unlinked-settlement`,
      },
    });
  });

  afterAll(async () => {
    await prisma.adminCase.deleteMany({ where: { id: { in: [terminalCaseId, activeCaseWithoutKeyId] } } });
    await prisma.opsIncident.deleteMany({ where: { id: terminalIncidentId } });
    await prisma.generationFulfillmentFact.deleteMany({ where: { requestId: mismatchedSucceededRequestId } });
    await prisma.generationSettlementLink.deleteMany({ where: { requestId: unlinkedSettlementRequestId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: unlinkedSettlementLedgerId } });
    await prisma.generationDelivery.deleteMany({ where: { requestId: mismatchedSucceededRequestId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: { in: [cancelledAttemptId, mismatchedSucceededAttemptId] } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: [cancelledAttemptId, mismatchedSucceededAttemptId] } } });
    await prisma.generationSettlementLink.deleteMany({ where: { requestId: overRefundRequestId } });
    await prisma.dreamcoinLedger.deleteMany({ where: { id: { in: [capturedLedgerId, refundLedgerId] } } });
    await prisma.generationFulfillmentFact.deleteMany({ where: { id: partialFactId } });
    await prisma.generationDelivery.deleteMany({
      where: { requestId: { in: [partialRequestId, missingPartialFactRequestId] } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: [partialRequestId, missingPartialFactRequestId, overRefundRequestId, cancelledRequestId, mismatchedSucceededRequestId, unlinkedSettlementRequestId] } },
    });
    await prisma.contentProductionBatch.deleteMany({ where: { id: creativeMismatchId } });
    await prisma.characterServing.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.characterRelease.deleteMany({ where: { id: { in: releaseIds } } });
    await prisma.characterQaRun.deleteMany({ where: { id: { in: qaRunIds } } });
    await prisma.characterRevision.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.characterProject.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { referenceSetRevisionId: { in: referenceSetIds } },
    });
    await prisma.referenceSetRevision.deleteMany({ where: { id: { in: referenceSetIds } } });
    await prisma.characterVisualProfile.deleteMany({ where: { id: { in: profileIds } } });
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    await prisma.mediaAsset.deleteMany({ where: { id: mediaId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("blocks on tampered release authority, empty manifests, invalid joins, and identity/reference drift", async () => {
    const report = await auditAdminCutoverInvariants(prisma);
    expect(report).toMatchObject({ qualityState: "invalid", decisionUse: "blocked" });
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "serving_release_cross_character",
        status: "failed",
        sampleIds: expect.arrayContaining([`${prefix}-cross-character-release`]),
      }),
      expect.objectContaining({
        key: "serving_release_revision_content_join_invalid",
        status: "failed",
        sampleIds: expect.arrayContaining([`${prefix}-missing-join-release`]),
      }),
      expect.objectContaining({
        key: "current_release_missing_exact_identity_or_reference",
        status: "failed",
        sampleIds: expect.arrayContaining([
          `${prefix}-missing-identity-reference-release`,
          `${prefix}-legacy-missing-identity-reference-release`,
          `${prefix}-wrong-identity-reference-release`,
          `${prefix}-empty-reference-release`,
        ]),
      }),
      expect.objectContaining({
        key: "current_release_incomplete_manifest",
        status: "failed",
        sampleIds: expect.arrayContaining([
          `${prefix}-tampered-release-release`,
          `${prefix}-empty-manifest-release`,
        ]),
      }),
      expect.objectContaining({
        key: "scheduled_release_missing_exact_identity_or_reference",
        status: "failed",
        sampleIds: expect.arrayContaining([`${prefix}-scheduled-invalid-release`]),
      }),
      expect.objectContaining({
        key: "scheduled_release_incomplete_manifest",
        status: "failed",
        sampleIds: expect.arrayContaining([
          `${prefix}-scheduled-invalid-release`,
          `${prefix}-scheduled-wrong-status-release`,
        ]),
      }),
      expect.objectContaining({
        key: "serving_default_route_unqualified",
        status: "failed",
        sampleIds: expect.arrayContaining([
          `${prefix}-scheduled-invalid-release`,
          `${prefix}-scheduled-wrong-status-release`,
        ]),
      }),
      expect.objectContaining({
        key: "official_public_character_not_live",
        status: "failed",
        sampleIds: expect.arrayContaining([`${prefix}-official-not-live-character`]),
      }),
      expect.objectContaining({
        key: "live_serving_legacy_projection_mismatch",
        status: "failed",
        sampleIds: expect.arrayContaining([`${prefix}-official-live-projection-mismatch-character`]),
      }),
      expect.objectContaining({
        key: "partial_request_delivery_count_mismatch",
        status: "failed",
        sampleIds: expect.arrayContaining([partialRequestId, missingPartialFactRequestId]),
      }),
      expect.objectContaining({
        key: "creative_run_child_projection_mismatch",
        status: "failed",
        sampleIds: expect.arrayContaining([creativeMismatchId]),
      }),
      expect.objectContaining({
        key: "generation_refund_exceeds_captured_spend",
        status: "failed",
        sampleIds: expect.arrayContaining([overRefundRequestId]),
      }),
      expect.objectContaining({
        key: "succeeded_request_delivery_count_mismatch",
        status: "failed",
        sampleIds: expect.arrayContaining([mismatchedSucceededRequestId]),
      }),
      expect.objectContaining({
        key: "generation_settlement_link_mismatch",
        status: "failed",
        sampleIds: expect.arrayContaining([`${unlinkedSettlementRequestId}:${unlinkedSettlementLedgerId}`]),
      }),
      expect.objectContaining({
        key: "terminal_case_retains_active_key",
        status: "failed",
        sampleIds: expect.arrayContaining([terminalCaseId]),
      }),
      expect.objectContaining({
        key: "active_case_missing_active_key",
        status: "failed",
        sampleIds: expect.arrayContaining([activeCaseWithoutKeyId]),
      }),
      expect.objectContaining({
        key: "terminal_incident_retains_active_correlation_key",
        status: "failed",
        sampleIds: expect.arrayContaining([terminalIncidentId]),
      }),
    ]));
    const succeededMismatch = report.checks.find((check) => check.key === "succeeded_request_delivery_count_mismatch");
    expect(succeededMismatch?.sampleIds).not.toContain(cancelledRequestId);
  });

  it("detects a real orphan pointer even after the forward FK migration is installed", async () => {
    let checked = false;
    await expect(prisma.$transaction(async (tx) => {
      const constraints = await tx.$queryRaw<Array<{ deferrable: boolean }>>`
        SELECT condeferrable AS deferrable
        FROM pg_constraint
        WHERE conname IN (
          'character_serving_characterId_fkey',
          'character_serving_currentReleaseId_fkey',
          'character_serving_scheduledReleaseId_fkey'
        )
          AND connamespace = current_schema()::regnamespace
      `;
      expect(constraints.every((constraint) => constraint.deferrable)).toBe(true);
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
      const orphanCharacterId = `${prefix}-orphan-character`;
      await tx.character.create({
        data: {
          id: orphanCharacterId,
          name: "Orphan pointer fixture",
          age: 26,
          description: "Transaction-scoped orphan pointer",
          visibility: "private",
          status: "approved",
          source: "user",
          appearance: {},
          advancedDetails: {},
        },
      });
      const orphanReleaseId = `${prefix}-orphan-release`;
      const scheduledOrphanReleaseId = `${prefix}-scheduled-orphan-release`;
      await tx.characterServing.create({
        data: {
          id: `${prefix}-orphan-serving`,
          characterId: orphanCharacterId,
          currentReleaseId: orphanReleaseId,
          scheduledReleaseId: scheduledOrphanReleaseId,
          scheduledAt: new Date("2030-01-02T00:00:00.000Z"),
          state: "live",
        },
      });
      const missingCharacterId = `${prefix}-missing-serving-character`;
      await tx.characterServing.create({
        data: {
          id: `${prefix}-character-orphan-serving`,
          characterId: missingCharacterId,
          state: "inactive",
        },
      });
      const report = await auditAdminCutoverInvariants(tx);
      expect(report).toMatchObject({ qualityState: "invalid", decisionUse: "blocked" });
      expect(report.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          key: "serving_release_pointer_orphan",
          status: "failed",
          sampleIds: expect.arrayContaining([
            `${prefix}-orphan-serving:current:${orphanReleaseId}`,
            `${prefix}-orphan-serving:scheduled:${scheduledOrphanReleaseId}`,
          ]),
        }),
        expect.objectContaining({
          key: "serving_character_pointer_orphan",
          status: "failed",
          sampleIds: expect.arrayContaining([
            `${prefix}-character-orphan-serving:${missingCharacterId}`,
          ]),
        }),
      ]));
      checked = true;
      throw new Error("rollback-orphan-fixture");
    })).rejects.toThrow("rollback-orphan-fixture");
    expect(checked).toBe(true);
  });
});
