import { expect, test, type Page } from "@playwright/test";
import axe, { type AxeResults } from "axe-core";
import { prisma } from "@/server/lib/db";
import {
  CHARACTER_RELEASE_POLICY_VERSION,
  executeCharacterReleaseCommand,
} from "@/server/modules/admin-v2/characters/release-executor";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const actorId = "seed-admin-user";
const creativeRunId = `e2e-v2-creative-${suffix}`;
const creativeItemId = `e2e-v2-creative-item-${suffix}`;
const creativeAssetId = `e2e-v2-creative-asset-${suffix}`;
const incidentId = `e2e-v2-incident-${suffix}`;
const incidentRequestId = `e2e-v2-incident-request-${suffix}`;
const incidentAttemptId = `e2e-v2-incident-attempt-${suffix}`;
const incidentOccurrenceId = `e2e-v2-incident-occurrence-${suffix}`;
const retryRequestId = `e2e-v2-retry-request-${suffix}`;
const retryAttemptId = `e2e-v2-retry-attempt-${suffix}`;
const caseId = `e2e-v2-case-${suffix}`;
const caseTargetId = `e2e-v2-customer-${suffix}`;
const caseEvidenceId = `e2e-v2-evidence-${suffix}`;
const characterName = `E2E V2 Companion ${suffix}`;
const releaseCharacterId = `e2e-v2-release-character-${suffix}`;
const releaseCharacterName = `E2E Release Companion ${suffix}`;
const releaseProjectId = `e2e-v2-release-project-${suffix}`;
const releaseContentId = `e2e-v2-release-content-${suffix}`;
const releaseRevisionId = `e2e-v2-release-revision-${suffix}`;
const releaseProfileId = `e2e-v2-release-profile-${suffix}`;
const releaseReferenceSetId = `e2e-v2-release-refs-${suffix}`;
const releaseMediaId = `e2e-v2-release-media-${suffix}`;
const releaseQaRunId = `e2e-v2-release-qa-${suffix}`;
const oldReleaseId = `e2e-v2-release-old-${suffix}`;
const candidateReleaseId = `e2e-v2-release-candidate-${suffix}`;
const releaseRouteFingerprint = `e2e-v2-release-route-${suffix}`;
let wizardCharacterId: string | null = null;

function adminBaseURL() {
  if (process.env.PW_ADMIN_BASE_URL) return process.env.PW_ADMIN_BASE_URL.replace(/\/$/, "");
  const url = new URL(process.env.PW_BASE_URL ?? "http://127.0.0.1:3000");
  url.port = String(Number(url.port || "3000") + 1);
  return url.toString().replace(/\/$/, "");
}

async function login(page: Page) {
  const response = await page.request.post(`${adminBaseURL()}/api/admin-auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function consoleFailures(page: Page, expected: RegExp[] = []) {
  const failures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !expected.some((pattern) => pattern.test(message.text()))) {
      failures.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (!expected.some((pattern) => pattern.test(error.message))) failures.push(error.message);
  });
  return failures;
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: element.className,
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
        text: element.innerText?.slice(0, 80) ?? "",
      }))
      .filter((element) => element.right > window.innerWidth + 1 || element.left < -1)
      .slice(0, 8),
  }));
  expect(metrics.documentWidth, JSON.stringify(metrics, null, 2)).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

async function expectWcag22AA(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const results = await page.evaluate(async () => {
    const runner = (window as typeof window & { axe: typeof axe }).axe;
    return runner.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
  }) as AxeResults;
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      failureSummary: node.failureSummary,
    })),
  }));
  expect(violations, `${page.url()}\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

test.describe.serial("Admin v2 operator workspaces", () => {
  test.describe.configure({ retries: 0 });
  test.beforeAll(async () => {
    await prisma.mediaAsset.create({
      data: {
        id: creativeAssetId,
        ownerId: actorId,
        type: "image",
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23d9d4c7'/%3E%3C/svg%3E",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { source: "admin_v2_playwright" },
      },
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: creativeRunId,
        title: `E2E Creative Run ${suffix}`,
        purpose: "campaign",
        targetType: "campaign",
        targetId: `campaign-${suffix}`,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        status: "reviewing",
        lifecycleState: "active",
        workflowStage: "review",
        verificationState: "pending",
        ownerId: actorId,
        createdById: actorId,
        items: {
          create: {
            id: creativeItemId,
            itemIndex: 0,
            status: "generated",
            mediaAssetId: creativeAssetId,
            tags: [],
          },
        },
      },
    });
    const incidentLastSeen = new Date(Date.now() - 30 * 60_000);
    await prisma.generationJob.create({
      data: {
        id: incidentRequestId,
        userId: actorId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "completed",
        outputCount: 1,
        deliveredOutputCount: 1,
        finishedAt: new Date(incidentLastSeen.getTime() + 5 * 60_000),
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: incidentAttemptId,
        requestId: incidentRequestId,
        attemptNo: 1,
        provider: "e2e-provider",
        profileKey: "e2e-profile",
        workflowKey: "e2e-workflow",
        status: "succeeded",
        finishedAt: new Date(incidentLastSeen.getTime() + 5 * 60_000),
      },
    });
    await prisma.generationJob.create({ data: {
      id: retryRequestId,
      userId: actorId,
      mode: "image",
      controls: {},
      presetIds: [],
      status: "failed",
      outputCount: 1,
      errorCode: "e2e_retryable_failure",
      version: 1,
    } });
    await prisma.generationAttempt.create({ data: {
      id: retryAttemptId,
      requestId: retryRequestId,
      attemptNo: 1,
      status: "failed",
      errorCode: "e2e_retryable_failure",
      retryability: "retryable",
      finishedAt: new Date(),
    } });
    await prisma.opsIncident.create({
      data: {
        id: incidentId,
        signature: `provider:profile:e2e-${suffix}`,
        signatureVersion: "v1",
        activeCorrelationKey: `e2e-active-${suffix}`,
        status: "monitoring",
        severity: "high",
        ownerId: actorId,
        firstSeen: new Date(incidentLastSeen.getTime() - 5 * 60_000),
        lastSeen: incidentLastSeen,
        slaDueAt: new Date(Date.now() + 3_600_000),
        impact: { affectedRequests: 3, affectedUsers: 2, failedCostMicros: 1200, refundedDreamcoins: 0 },
        mitigation: {
          recommendedActions: ["inspect route"],
          signatureComponents: {
            provider: "e2e-provider",
            profileKey: "e2e-profile",
            workflowKey: "e2e-workflow",
            errorClass: "provider_regression",
            normalizedError: `e2e-regression-${suffix}`,
          },
        },
        suspectedCause: `E2E provider regression ${suffix}`,
        confidence: 0.8,
      },
    });
    await prisma.opsIncidentOccurrence.create({
      data: {
        id: incidentOccurrenceId,
        incidentId,
        requestId: incidentRequestId,
        attemptId: incidentAttemptId,
        occurrenceKey: `e2e-recovered:${suffix}`,
        observedAt: incidentLastSeen,
      },
    });
    await prisma.adminCase.create({
      data: {
        id: caseId,
        type: "support_request",
        targetType: "user",
        targetId: caseTargetId,
        caseKey: `support:e2e:${suffix}`,
        activeKey: `support_request:user:${caseTargetId}:support:e2e:${suffix}`,
        status: "in_progress",
        priority: "high",
        ownerId: actorId,
        slaDueAt: new Date(Date.now() + 3_600_000),
        resolution: { severity: "high" },
      },
    });
    await prisma.caseEvidence.create({
      data: {
        id: caseEvidenceId,
        caseId,
        sourceType: "support_message",
        sourceId: `support-message-${suffix}`,
        snapshot: { description: "Customer supplied immutable reproduction evidence." },
        occurredAt: new Date(),
      },
    });

    await prisma.mediaAsset.create({
      data: {
        id: releaseMediaId,
        ownerId: actorId,
        type: "image",
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='400'%3E%3Crect width='320' height='400' fill='%233a3347'/%3E%3Ccircle cx='160' cy='150' r='72' fill='%23d9b9a5'/%3E%3C/svg%3E",
        visibility: "public",
        safetyStatus: "passed",
        metadata: { source: "admin_v2_character_playwright" },
      },
    });
    await prisma.character.create({
      data: {
        id: releaseCharacterId,
        name: releaseCharacterName,
        age: 29,
        description: "An attentive companion with immutable release evidence.",
        systemPrompt: "Stay warm, concise, and grounded.",
        source: "official",
        status: "approved",
        visibility: "public",
        imageAssetId: releaseMediaId,
        appearance: { style: "realistic", eyes: "amber" },
        advancedDetails: { firstMessage: "Welcome back. What should we make space for today?" },
      },
    });
    const visualProfile = {
      id: releaseProfileId,
      characterId: releaseCharacterId,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "stable attentive companion identity",
      negativeIdentityPrompt: null,
      faceTraits: { eyes: "amber" },
      hairTraits: { color: "black" },
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: { style: "realistic" },
      anchorAssetIds: [releaseMediaId],
      referenceAssetIds: [releaseMediaId],
      adapterRefs: {},
      evidenceState: "qualified",
      createdFrom: "playwright",
    };
    await prisma.characterVisualProfile.create({
      data: {
        ...visualProfile,
        immutableHash: characterVisualProfileSnapshotHash(visualProfile),
      },
    });
    const referenceSnapshot = {
      visualProfileId: releaseProfileId,
      revision: 1,
      selectorVersion: "e2e-v1",
      references: [{ mediaAssetId: releaseMediaId, position: 0, role: "primary_face", weight: 1 }],
    };
    await prisma.referenceSetRevision.create({
      data: {
        id: releaseReferenceSetId,
        visualProfileId: releaseProfileId,
        revision: 1,
        status: "active",
        selectorVersion: "e2e-v1",
        snapshotHash: referenceSetSnapshotHash(referenceSnapshot),
        createdFrom: "playwright",
        references: {
          create: {
            mediaAssetId: releaseMediaId,
            position: 0,
            role: "primary_face",
            weight: 1,
            selectionReason: "E2E immutable identity evidence",
          },
        },
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        routeFingerprint: releaseRouteFingerprint,
        generationProfileKey: "e2e-portrait",
        generationProfileVersion: 1,
        workflowKey: "e2e-identity",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: "default-character",
        sampleCount: 40,
        passCount: 37,
        identityMatch: 0.925,
        result: "qualified",
        evidence: { reviewerId: actorId, evaluatorVersion: "identity-match-v1" },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: releaseContentId,
        characterId: releaseCharacterId,
        version: 1,
        contentHash: `e2e-content-hash-${suffix}`,
        personaSnapshot: {
          name: releaseCharacterName,
          age: 29,
          gender: "female",
          relationshipArchetype: "trusted confidante",
          characterPromise: "A grounded daily reflection partner.",
          personality: "Attentive and calm.",
          tone: "Warm and concise.",
          backstory: "A host who remembers the important details.",
          systemPrompt: "Stay warm, concise, and grounded.",
          description: "An attentive companion with immutable release evidence.",
        },
        openingSnapshot: { firstMessage: "Welcome back. What should we make space for today?" },
        appearanceSnapshot: { style: "realistic", eyes: "amber" },
        sourceType: "playwright",
      },
    });
    await prisma.characterProject.create({
      data: {
        id: releaseProjectId,
        characterId: releaseCharacterId,
        ownerId: actorId,
        phase: "launch_ready",
        audience: {
          audience: "relationship-focused adults",
          companionNeed: "consistent reflective conversation",
          targetPlacementKeys: ["explore.featured"],
          productionPackage: "release e2e",
          qaPlan: "immutable surfaces",
        },
        hypothesis: "A grounded tone improves repeat conversation.",
        differentiation: "Continuity without exaggerated affect.",
        successCriteria: ["operational monitor passes"],
        activeKey: `official:${releaseCharacterId}`,
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: releaseRevisionId,
        projectId: releaseProjectId,
        revision: 1,
        characterContentVersionId: releaseContentId,
        projectSnapshot: { hypothesis: "A grounded tone improves repeat conversation." },
      },
    });
    const qaChecks = [
      "explore_feed_card_desktop",
      "explore_feed_card_mobile",
      "character_detail_desktop",
      "character_detail_mobile",
      "opening_message",
      "five_turn_conversation",
      "chat_image",
    ].map((key) => ({
      key,
      result: "passed",
      evidenceRef: `e2e://character/${key}`,
      comment: "Verified in the immutable browser fixture.",
      fixDeepLink: `/admin/characters/${releaseCharacterId}?tab=preview`,
      ownerId: actorId,
    }));
    await prisma.characterQaRun.create({
      data: {
        id: releaseQaRunId,
        characterId: releaseCharacterId,
        projectId: releaseProjectId,
        characterContentVersionId: releaseContentId,
        projectVersion: 1,
        ownerId: actorId,
        status: "passed",
        checks: qaChecks,
        evidenceHash: `e2e-qa-evidence-${suffix}`,
      },
    });
    const generationProvenance = {
      routeFingerprint: releaseRouteFingerprint,
      matrixKey: "default-character",
      generationProfileKey: "e2e-portrait",
      generationProfileVersion: 1,
      workflowKey: "e2e-identity",
      workflowVersion: 1,
      visualProfileHash: characterVisualProfileSnapshotHash(visualProfile),
      referenceSetHash: referenceSetSnapshotHash(referenceSnapshot),
      characterQa: {
        status: "passed",
        qaRunId: releaseQaRunId,
        evidenceHash: `e2e-qa-evidence-${suffix}`,
      },
    };
    const releasePlacementManifest = {
      placements: [{ slotKey: "character_avatar", assetId: releaseMediaId, slotVersion: 1 }],
    };
    const releaseSnapshot = {
      projectId: releaseProjectId,
      revisionId: releaseRevisionId,
      characterContentVersionId: releaseContentId,
      visualProfileId: releaseProfileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: releaseReferenceSetId,
      generationProvenance,
      releasePlacementManifest,
    };
    const sharedRelease = {
      ...releaseSnapshot,
      snapshotHash: characterReleaseSnapshotHash(releaseSnapshot),
      readiness: "ready",
      legacy: false,
    };
    await prisma.characterRelease.createMany({
      data: [
        {
          id: oldReleaseId,
          ...sharedRelease,
          status: "published",
          publishedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000),
        },
        {
          id: candidateReleaseId,
          ...sharedRelease,
          status: "approved",
          readiness: "unknown",
        },
      ],
    });
    await prisma.characterServing.create({
      data: {
        characterId: releaseCharacterId,
        state: "live",
        currentReleaseId: oldReleaseId,
        version: 1,
      },
    });
  });

  test.afterAll(async () => {
    const characters = await prisma.character.findMany({ where: { name: { startsWith: "E2E V2 Companion " } }, select: { id: true } });
    const characterIds = [...new Set([
      ...characters.map((character) => character.id),
      ...(wizardCharacterId ? [wizardCharacterId] : []),
    ])];
    if (characterIds.length > 0) {
      const projects = await prisma.characterProject.findMany({ where: { characterId: { in: characterIds } }, select: { id: true } });
      const projectIds = projects.map((project) => project.id);
      await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: projectIds } } });
      await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: projectIds } } });
      await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: projectIds } } });
      await prisma.controlPlaneCommand.deleteMany({ where: { actorId, targetId: { in: projectIds } } });
      await prisma.characterRevision.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.characterServing.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.characterProject.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    }
    const commandIds = (await prisma.controlPlaneCommand.findMany({
      where: { targetId: { in: [creativeRunId, incidentId, caseId, candidateReleaseId, releaseCharacterId] } },
      select: { id: true },
    })).map((command) => command.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commandIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: [creativeRunId, creativeItemId, incidentId, caseId, releaseProjectId, oldReleaseId, candidateReleaseId, releaseCharacterId] } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { in: [creativeRunId, creativeItemId, incidentId, caseId, releaseProjectId, oldReleaseId, candidateReleaseId, releaseCharacterId] } },
    });
    await prisma.decisionRecord.deleteMany({ where: { sourceId: caseId } });
    await prisma.incidentPostmortem.deleteMany({ where: { incidentId } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId } });
    await prisma.caseEvidence.deleteMany({ where: { caseId } });
    await prisma.adminCase.deleteMany({ where: { id: caseId } });
    await prisma.opsIncident.deleteMany({ where: { id: incidentId } });
    await prisma.generationAttempt.deleteMany({ where: { id: incidentAttemptId } });
    await prisma.generationJob.deleteMany({ where: { id: incidentRequestId } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: retryAttemptId } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: retryRequestId } });
    await prisma.generationJob.deleteMany({ where: { id: retryRequestId } });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: creativeItemId } });
    await prisma.mediaAssetPlacement.deleteMany({ where: { mediaAssetId: creativeAssetId } });
    await prisma.contentProductionItem.deleteMany({ where: { id: creativeItemId } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: creativeRunId } });
    await prisma.mediaAsset.deleteMany({ where: { id: creativeAssetId } });

    const releaseIds = (await prisma.characterRelease.findMany({
      where: { projectId: releaseProjectId },
      select: { id: true },
    })).map((release) => release.id);
    const releaseValidationIds = (await prisma.releaseValidationRun.findMany({
      where: { releaseId: { in: releaseIds } },
      select: { id: true },
    })).map((run) => run.id);
    await prisma.releaseCheckResult.deleteMany({ where: { validationRunId: { in: releaseValidationIds } } });
    await prisma.releaseValidationRun.deleteMany({ where: { id: { in: releaseValidationIds } } });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await prisma.characterReleaseEvent.deleteMany({ where: { characterId: releaseCharacterId } });
    await prisma.adminCollaborationActivity.deleteMany({
      where: { targetId: { in: [releaseProjectId, ...releaseIds] } },
    });
    await prisma.characterServing.deleteMany({ where: { characterId: releaseCharacterId } });
    await prisma.characterRelease.deleteMany({ where: { id: { in: releaseIds } } });
    await prisma.characterQaRun.deleteMany({ where: { projectId: releaseProjectId } });
    await prisma.characterRevision.deleteMany({ where: { projectId: releaseProjectId } });
    await prisma.characterProject.deleteMany({ where: { id: releaseProjectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: releaseCharacterId } });
    await prisma.generationRouteQualification.deleteMany({ where: { routeFingerprint: releaseRouteFingerprint } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({ where: { referenceSetRevisionId: releaseReferenceSetId } });
    await prisma.referenceSetRevision.deleteMany({ where: { id: releaseReferenceSetId } });
    await prisma.characterVisualProfile.deleteMany({ where: { id: releaseProfileId } });
    await prisma.character.deleteMany({ where: { id: releaseCharacterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: releaseMediaId } });
    await prisma.$disconnect();
  });

  test("creates and resumes an authoritative Character Project through the responsive wizard", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${adminBaseURL()}/admin/characters/new`);
    await expect(page.getByRole("heading", { level: 2, name: "Create Character Project" })).toBeVisible();
    await page.getByRole("button", { name: "Save positioning & continue" }).click();
    await page.getByLabel("Name").fill(characterName);
    await page.getByRole("button", { name: "Save & continue" }).click();
    await page.getByRole("button", { name: "Save & continue" }).click();
    await page.getByRole("button", { name: "Save & continue" }).click();
    await page.getByRole("button", { name: "Save and open project" }).click();
    await expect(page).toHaveURL(/\/admin\/characters\/[^/?]+/);
    wizardCharacterId = new URL(page.url()).pathname.split("/").at(-1) ?? null;
    await expect(page.getByRole("heading", { level: 2, name: characterName })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Character workspace" })).toBeVisible();
    await page.getByRole("tab", { name: "project" }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: "preview" })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/tab=preview/);
    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("validates, publishes, monitors, and rolls back an immutable Character Release", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(`${adminBaseURL()}/admin/characters/${releaseCharacterId}?tab=preview`);
    await expect(page.getByRole("heading", { level: 2, name: releaseCharacterName })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Real user-surface renderer" })).toBeVisible();
    await expect(page.getByTitle("Live real frontend renderer")).toBeVisible();
    await expect(page.getByText(releaseQaRunId)).toBeVisible();

    await page.getByRole("tab", { name: "release" }).click();
    const candidateCard = page.locator("article").filter({ hasText: candidateReleaseId });
    await expect(candidateCard).toContainText("unknown");
    await expect(page.getByRole("button", { name: "Publish candidate" })).toBeDisabled();
    await page.getByLabel("Exact confirmation").fill(`${releaseCharacterId}:${candidateReleaseId}:validate`);
    await page.getByRole("button", { name: "Validate pinned snapshot" }).click();
    await expect(candidateCard).toContainText("ready");

    await page.getByLabel("Exact confirmation").fill(`${releaseCharacterId}:${candidateReleaseId}:publish`);
    await page.getByRole("button", { name: "Publish candidate" }).click();
    await expect.poll(async () => prisma.controlPlaneCommand.findFirst({
      where: { commandType: "character.release.publish", targetId: candidateReleaseId },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    })).not.toBeNull();
    const publishCommand = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: { commandType: "character.release.publish", targetId: candidateReleaseId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await executeCharacterReleaseCommand(prisma, {
      commandId: publishCommand.id,
      workerId: `playwright-release-publish-${suffix}`,
    });
    await expect.poll(async () => prisma.characterServing.findUnique({
      where: { characterId: releaseCharacterId },
      select: { currentReleaseId: true, state: true },
    })).toEqual({ currentReleaseId: candidateReleaseId, state: "live" });
    await page.reload();
    await page.getByRole("tab", { name: "release" }).click();
    await expect(page.locator("article").filter({ hasText: candidateReleaseId })).toContainText("serving now");

    await page.getByRole("tab", { name: "monitor" }).click();
    await page.getByRole("button", { name: "Refresh 24h" }).click();
    await expect.poll(async () => prisma.releaseMonitor.findUnique({
      where: { releaseId_window: { releaseId: candidateReleaseId, window: "24h" } },
      select: { status: true },
    })).not.toBeNull();
    await expect(page.getByRole("heading", { level: 3, name: "24h guardrail" })).toBeVisible();

    await page.getByRole("tab", { name: "release" }).click();
    await page.getByLabel("Exact confirmation").fill(`${releaseCharacterId}:${oldReleaseId}:rollback`);
    await page.getByRole("button", { name: "Roll back to selected snapshot" }).click();
    await expect.poll(async () => prisma.controlPlaneCommand.findFirst({
      where: { commandType: "character.release.rollback", targetId: releaseCharacterId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    })).not.toBeNull();
    const rollbackCommand = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: { commandType: "character.release.rollback", targetId: releaseCharacterId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await executeCharacterReleaseCommand(prisma, {
      commandId: rollbackCommand.id,
      workerId: `playwright-release-rollback-${suffix}`,
    });
    await expect.poll(async () => prisma.characterServing.findUnique({
      where: { characterId: releaseCharacterId },
      select: { currentReleaseId: true },
    })).toMatchObject({ currentReleaseId: expect.stringMatching(/^rollback:/) });
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId: releaseCharacterId },
      select: { currentReleaseId: true },
    });
    const rollbackRelease = await prisma.characterRelease.findUniqueOrThrow({ where: { id: serving.currentReleaseId! } });
    const oldRelease = await prisma.characterRelease.findUniqueOrThrow({ where: { id: oldReleaseId } });
    expect(rollbackRelease).toMatchObject({ rollbackOfReleaseId: oldReleaseId, status: "published" });
    expect(rollbackRelease.snapshotHash).toBe(oldRelease.snapshotHash);
    await page.reload();
    await page.getByRole("tab", { name: "release" }).click();
    await expect(page.locator("article").filter({ hasText: rollbackRelease.id })).toContainText("serving now");
    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("closes Creative, Incident, and Case loops through UI and authoritative facts", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1366, height: 900 });

    await page.goto(`${adminBaseURL()}/admin/creative/runs`);
    await expect(page.locator("#creative-runs-title")).toBeVisible();
    await page.locator(`a[href="/admin/creative/runs/${creativeRunId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/creative/runs/${creativeRunId}$`));
    await expect(page.getByRole("heading", { level: 2, name: `E2E Creative Run ${suffix}` })).toBeVisible();
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("approved · passed")).toBeVisible();
    await page.getByLabel("Target type").fill("campaign");
    await page.getByLabel("Target ID").fill(`campaign-${suffix}`);
    await page.getByRole("button", { name: "Publish placement" }).click();
    await expect(page.getByText("campaign · verifying")).toBeVisible();
    await page.getByRole("button", { name: "Verify live slot" }).click();
    await expect(page.getByText("campaign · passed")).toBeVisible();

    await expect.poll(async () => prisma.contentProductionBatch.findUnique({
      where: { id: creativeRunId },
      select: { workflowStage: true, verificationState: true, version: true },
    })).toEqual({ workflowStage: "verification", verificationState: "passed", version: 4 });
    await expect.poll(async () => prisma.creativeReviewDecision.count({
      where: { runItemId: creativeItemId, decision: "approved" },
    })).toBe(1);
    await expect.poll(async () => prisma.mediaAssetPlacement.count({
      where: { mediaAssetId: creativeAssetId, status: "published", verificationState: "passed" },
    })).toBe(1);

    await page.goto(`${adminBaseURL()}/admin/ops/incidents?search=${encodeURIComponent(suffix)}`);
    await expect(page.getByRole("heading", { level: 2, name: "Incidents" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`E2E provider regression ${suffix}`) }).click();
    await expect(page).toHaveURL(new RegExp(`incident=${incidentId}`));
    await expect(page.getByRole("heading", { level: 3, name: `E2E provider regression ${suffix}` })).toBeVisible();
    await page.getByLabel("Audit reason").fill("Recovery window and settlement reviewed");
    await page.getByLabel("Supplemental evidence reference (optional for authority check)").fill(`monitor://e2e/${suffix}`);
    await page.getByRole("button", { name: "Run authority verification" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Authority recovery verification evaluated" })).toBeVisible();
    await page.getByRole("button", { name: "Resolve incident" }).click();
    await expect(page.getByRole("heading", { level: 4, name: "Postmortem and close" })).toBeVisible();
    await page.getByLabel("Summary", { exact: true }).fill("Provider route recovered and all affected requests were reconciled.");
    await page.getByLabel("Root cause").fill("Provider route regression");
    await page.getByLabel("Contributing factors (one per line)").fill("Capacity signal lag");
    await page.getByLabel("Corrective actions (one per line)").fill("Add a route-level recovery canary");
    await page.getByLabel("Type close confirmation").fill(`${incidentId}:close`);
    await page.getByRole("button", { name: "Record postmortem and close" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Postmortem recorded and Incident closed" })).toBeVisible();

    await expect.poll(async () => prisma.opsIncident.findUnique({
      where: { id: incidentId },
      select: { status: true, verificationState: true, activeCorrelationKey: true },
    })).toEqual({ status: "closed", verificationState: "passed", activeCorrelationKey: null });
    await expect.poll(async () => prisma.incidentPostmortem.count({
      where: { incidentId, rootCause: "Provider route regression" },
    })).toBe(1);

    await page.goto(`${adminBaseURL()}/admin/cases?view=mine&search=${encodeURIComponent(caseTargetId)}`);
    await expect(page.getByRole("heading", { level: 2, name: "Cases" })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(caseTargetId) }).click();
    await expect(page).toHaveURL(new RegExp(`case=${caseId}`));
    await expect(page.getByRole("heading", { level: 4, name: "Evidence" })).toBeVisible();
    await expect(page.getByText("Customer supplied immutable reproduction evidence.")).toBeVisible();
    const caseDecision = page.locator('section[aria-labelledby="case-decision-title"]');
    await caseDecision.locator("select").selectOption("incident_escalated");
    await page.getByLabel("Outcome reference").fill(`incident:${incidentId}`);
    await page.getByLabel("Resolution summary").fill("Escalated the customer impact to the recovered Incident and verified its authority state.");
    await page.getByRole("button", { name: "Record action" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Customer Case action recorded" })).toBeVisible();
    await page.getByRole("button", { name: "Verify from authority" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Downstream outcome verified" })).toBeVisible();
    await page.getByLabel("Audit reason").fill("Authority outcome verified for closure");
    await page.getByLabel("Type confirmation").fill(`${caseId}:close`);
    await page.getByRole("button", { name: "Close case", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Case close command accepted" })).toBeVisible();

    await expect.poll(async () => prisma.adminCase.findUnique({
      where: { id: caseId },
      select: { status: true, verificationState: true, activeKey: true },
    })).toEqual({ status: "closed", verificationState: "passed", activeKey: null });
    await expect.poll(async () => prisma.decisionRecord.count({
      where: { sourceId: caseId, decision: "incident_escalated" },
    })).toBe(1);
    await expect.poll(async () => prisma.adminAuditLog.count({
      where: { targetId: { in: [creativeItemId, incidentId, caseId] } },
    })).toBeGreaterThanOrEqual(8);

    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("projects verified domain outcomes into Today recently resolved with working deep links", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${adminBaseURL()}/admin/today`);
    await expect(page.getByTestId("today-view")).toBeVisible();
    await expect(page.getByText("Authoritative Today projection")).toBeVisible();

    const resolved = page.getByTestId("today-queue-recently-resolved");
    await expect(resolved.getByText(`user ${caseTargetId} is closed`)).toBeVisible();
    await expect(resolved.getByText(`E2E provider regression ${suffix}`)).toBeVisible();
    await resolved.locator(`a[href="/admin/cases/${caseId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/cases/${caseId}$`));
    await expect(page.getByRole("heading", { level: 4, name: "Evidence" })).toBeVisible();

    await page.goto(`${adminBaseURL()}/admin/today`);
    await page.getByTestId("today-queue-recently-resolved").locator(`a[href="/admin/ops/incidents/${incidentId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/ops/incidents/${incidentId}$`));
    await expect(page.getByRole("heading", { level: 3, name: `E2E provider regression ${suffix}` })).toBeVisible();
    expect(failures).toEqual([]);
  });

  test("opens a Job authority deep link without losing query or selection state", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.goto(`${adminBaseURL()}/admin/ops/jobs?job=${encodeURIComponent(incidentRequestId)}`);
    await expect(page).toHaveURL(new RegExp(`job=${incidentRequestId}`));
    await expect(page.getByText("Generation Request authority")).toBeVisible();
    await expect(page.getByText("Immutable Attempt events")).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page).not.toHaveURL(/(?:\?|&)job=/);
    await expect(page.getByText("Generation Request authority")).toHaveCount(0);
    expect(failures).toEqual([]);
  });

  test("keeps retry errors in an accessible focus-trapped dialog and restores focus", async ({ page }) => {
    const failures = consoleFailures(page, [/server responded with a status of 409 \(Conflict\)/]);
    await login(page);
    await page.goto(`${adminBaseURL()}/admin/ops/jobs?search=${encodeURIComponent(retryRequestId)}&mode=image&sort=created_desc&limit=25`);
    const trigger = page.getByRole("button", { name: "Retry" });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: new RegExp("Retry Generation Request") });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Reason (≥3)")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.getByLabel("Reason (≥3)").fill("Retry after authority recovery verification");
    await page.getByLabel("Type the name to confirm").fill(`${retryRequestId}:retry`);
    await prisma.generationJob.update({ where: { id: retryRequestId }, data: { version: { increment: 1 } } });
    await page.getByRole("button", { name: "Create retry attempt" }).click();
    await expect(dialog.getByRole("alert")).toContainText("changed before retry");
    await expect(page.getByLabel("Reason (≥3)")).toHaveValue("Retry after authority recovery verification");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(failures).toEqual([]);
  });

  test("meets automated WCAG 2.2 AA gates across the core operator surfaces", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const routes = [
      `/admin/characters/${releaseCharacterId}?tab=release`,
      `/admin/creative/runs/${creativeRunId}`,
      `/admin/ops/incidents/${incidentId}`,
      `/admin/cases/${caseId}`,
      `/admin/ops/jobs?job=${encodeURIComponent(incidentRequestId)}`,
      "/admin/today",
    ];
    for (const route of routes) {
      await page.goto(`${adminBaseURL()}${route}`);
      await expect(page.locator("#admin-main-content")).toBeVisible();
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("a.admin-skip-link")).toHaveAttribute("href", "#admin-main-content");
      await expectWcag22AA(page);
    }
    expect(failures).toEqual([]);
  });

  test("keeps all four core workspaces usable at 375px and exposes filtered-empty recovery", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 375, height: 812 });
    const routes = [
      ["/admin/characters", "Portfolio & Projects", 2],
      ["/admin/creative/runs", "Creative Runs", 2],
      ["/admin/ops/incidents", "Incidents", 2],
      ["/admin/cases?view=mine", "Cases", 2],
    ] as const;
    for (const [route, heading, level] of routes) {
      await page.goto(`${adminBaseURL()}${route}`);
      const locator = heading === "Creative Runs"
        ? page.locator("#creative-runs-title")
        : heading === "Portfolio & Projects"
          ? page.locator("#character-portfolio-title")
          : page.getByRole("heading", { level, name: heading });
      await expect(locator).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
    await page.getByLabel("Search all cases").fill(`missing-${suffix}`);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("heading", { level: 3, name: "No work matches these filters" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText(caseTargetId)).toBeVisible();
    expect(failures).toEqual([]);
  });

  test("keeps the four core authority details usable at the tablet breakpoint", async ({ page }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 834, height: 1_112 });
    const routes = [
      `/admin/characters/${releaseCharacterId}?tab=release`,
      `/admin/creative/runs/${creativeRunId}`,
      `/admin/ops/incidents/${incidentId}`,
      `/admin/cases/${caseId}`,
    ];
    for (const route of routes) {
      await page.goto(`${adminBaseURL()}${route}`);
      await expect(page.locator("#admin-main-content")).toBeVisible();
      await expect(page.locator("h1")).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
    }
    expect(failures).toEqual([]);
  });
});
