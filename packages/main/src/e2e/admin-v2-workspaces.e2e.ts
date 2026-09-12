import { expect, test, type Page } from "@playwright/test";
import type { Prisma } from "@prisma/client";
import {
  characterProjectCreateResponseSchema,
  characterReleaseAssetPlacement,
  parseCharacterReleaseAssetManifest,
} from "@idream/shared/admin";
import { compileCharacterSoul } from "@idream/shared";
import axe, { type AxeResults } from "axe-core";
import { prisma } from "@/server/lib/db";
import { executeCharacterReleaseCommand } from "@/server/modules/admin-v2/characters/release-executor";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-validation";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import { jobQueue } from "@/server/jobs/queue";
import { env } from "@/server/lib/env";
import { drainTargetAdminCommand } from "@/processes/admin-command-worker";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { validateCharacterReleaseSnapshot } from "@/server/modules/admin-v2/characters/release-validation";

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
const oldReleaseId = `e2e-v2-release-old-${suffix}`;
const candidateReleaseId = `e2e-v2-release-candidate-${suffix}`;
const releaseRouteFingerprint = `e2e-v2-release-route-${suffix}`;
const wizardRouteFingerprint = `e2e-v2-wizard-route-${suffix}`;
const wizardBootstrapProfileId = `e2e-v2-bootstrap-profile-${suffix}`;
const wizardBootstrapProfileKey = `000-e2e-v2-bootstrap-pipeline-${suffix}`;
const wizardIdentityProfileId = `e2e-v2-identity-profile-${suffix}`;
const wizardIdentityProfileKey = `e2e-v2-identity-pipeline-${suffix}`;
const wizardVisualStyle = "realistic";
let identityWorkflowVersion: number;
let wizardCharacterId: string | null = null;
let wizardBootstrapRunId: string | null = null;
const wizardRunIds: string[] = [];

type ResponsiveCoreFixture = {
  label: "mobile" | "tablet";
  viewport: { width: 375 | 834; height: number };
  candidateReleaseId: string;
  creativeRunId: string;
  creativeItemId: string;
  creativeAssetId: string;
  creativeJobId: string;
  creativeAttemptId: string;
  incidentId: string;
  incidentRequestId: string;
  incidentAttemptId: string;
  incidentOccurrenceId: string;
  caseId: string;
  caseTargetId: string;
  caseEvidenceId: string;
};

const responsiveCoreFixtures: ResponsiveCoreFixture[] = (
  [
    ["mobile", 375, 812],
    ["tablet", 834, 1_112],
  ] as const
).map(([label, width, height]) => ({
  label,
  viewport: { width, height },
  candidateReleaseId: `e2e-v2-release-${label}-${suffix}`,
  creativeRunId: `e2e-v2-creative-${label}-${suffix}`,
  creativeItemId: `e2e-v2-creative-item-${label}-${suffix}`,
  creativeAssetId: `e2e-v2-creative-asset-${label}-${suffix}`,
  creativeJobId: `e2e-v2-creative-job-${label}-${suffix}`,
  creativeAttemptId: `e2e-v2-creative-attempt-${label}-${suffix}`,
  incidentId: `e2e-v2-incident-${label}-${suffix}`,
  incidentRequestId: `e2e-v2-incident-request-${label}-${suffix}`,
  incidentAttemptId: `e2e-v2-incident-attempt-${label}-${suffix}`,
  incidentOccurrenceId: `e2e-v2-incident-occurrence-${label}-${suffix}`,
  caseId: `e2e-v2-case-${label}-${suffix}`,
  caseTargetId: `e2e-v2-customer-${label}-${suffix}`,
  caseEvidenceId: `e2e-v2-evidence-${label}-${suffix}`,
}));

function adminBaseURL() {
  if (process.env.PW_ADMIN_BASE_URL)
    return process.env.PW_ADMIN_BASE_URL.replace(/\/$/, "");
  const url = new URL(process.env.PW_BASE_URL ?? "http://127.0.0.1:3000");
  url.port = String(Number(url.port || "3000") + 1);
  return url.toString().replace(/\/$/, "");
}

function mainBaseURL() {
  return (process.env.PW_BASE_URL ?? "http://127.0.0.1:3000").replace(
    /\/$/,
    "",
  );
}

function internalToken() {
  return process.env.INTERNAL_TOKEN ?? "development-internal-token";
}

async function openCharacterTab(page: Page, tab: "assets" | "visual" | "preview" | "release" | "monitor") {
  const area = tab === "assets" ? "Character assets" : tab === "visual" ? "Character settings" : "Character operations";
  const labels = { assets: "Images", visual: "Visual identity", preview: "Launch preview", release: "Release", monitor: "Live monitoring" };
  await page.getByRole("button", { name: area, exact: true }).click();
  const mobilePage = page.getByLabel("Workspace page", { exact: true });
  if (await mobilePage.isVisible()) await mobilePage.selectOption(tab);
  else await page.getByRole("tab", { name: labels[tab], exact: true }).click();
  if (tab === "assets") {
    const create = page.getByRole("button", { name: "Create images", exact: true });
    if (await create.isVisible()) await create.click();
  }
  if (tab === "visual") {
    const settings = page.locator("#visual-production-readiness");
    if (await settings.getAttribute("open") === null) {
      await settings.locator("summary").first().click();
    }
  }
  if (tab === "monitor") await page.getByText("Release monitoring", { exact: true }).click();
}

function pendingCharacterCommandStorageKey(characterId: string) {
  return `idream:admin:character:${encodeURIComponent(actorId)}:${encodeURIComponent(characterId)}:pending-command`;
}

async function drainCreativeRun(
  page: Page,
  runId: string,
  expectedItemCount: number,
) {
  await expect
    .poll(
      async () => {
        const response = await page.request.post(
          `${mainBaseURL()}/api/internal/worker`,
          {
            headers: { authorization: `Bearer ${internalToken()}` },
            timeout: 90_000,
          },
        );
        if (!response.ok()) throw new Error(await response.text());
        return prisma.contentProductionItem.count({
          where: {
            batchId: runId,
            status: "generated",
            mediaAssetId: { not: null },
          },
        });
      },
      {
        timeout: 30_000,
        intervals: [100, 250, 500, 1_000],
      },
    )
    .toBe(expectedItemCount);
  const generatedItems = await prisma.contentProductionItem.findMany({
    where: {
      batchId: runId,
      status: "generated",
      mediaAssetId: { not: null },
    },
    select: { jobId: true, mediaAssetId: true },
  });
  const generatedAssetIds = generatedItems.flatMap((item) =>
    item.mediaAssetId ? [item.mediaAssetId] : [],
  );
  const generatedJobIds = generatedItems.flatMap((item) =>
    item.jobId ? [item.jobId] : [],
  );
  expect(generatedAssetIds).toHaveLength(expectedItemCount);
  expect(generatedJobIds).toHaveLength(expectedItemCount);
  expect(
    await prisma.generationJob.count({
      where: {
        id: { in: generatedJobIds },
        provider: "pipeline",
      },
    }),
  ).toBe(expectedItemCount);
  expect(
    await prisma.generationAttempt.count({
      where: {
        requestId: { in: generatedJobIds },
        provider: "pipeline",
        status: "succeeded",
      },
    }),
  ).toBe(expectedItemCount);
  const generatedAssets = await prisma.mediaAsset.findMany({
    where: { id: { in: generatedAssetIds } },
    select: { metadata: true },
  });
  expect(generatedAssets).toHaveLength(expectedItemCount);
  expect(
    generatedAssets.every((asset) => {
      const metadata = asset.metadata as Record<string, unknown>;
      return metadata.provider === "pipeline" && metadata.synthetic === false;
    }),
  ).toBe(true);
}

async function generateCharacterAssetRun(
  page: Page,
  buttonName: string,
  expectedItemCount: number,
) {
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/admin/creative/runs",
  );
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(202);
  const createPayload = (await createResponse.json()) as {
    data: { batch: { id: string } };
  };
  const runId = createPayload.data.batch.id;
  wizardRunIds.push(runId);
  await drainCreativeRun(page, runId, expectedItemCount);
  await expect(
    page.getByRole("button", { name: /View candidate/ }),
  ).toHaveCount(expectedItemCount);
  await page.getByRole("button", { name: "View candidate 1", exact: true }).click();
  const inspectTab = page.getByRole("tab", { name: "Inspect", exact: true });
  await inspectTab.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect.poll(() => inspectTab.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  return runId;
}

type SelectedAssetLineage = {
  assetId: string;
  runId: string;
  itemId: string;
  generationJobId: string;
  attemptId: string;
  attemptNo: number;
  provider: string | null;
  profileKey: string | null;
  profileVersion: number | null;
  workflowKey: string | null;
  workflowVersion: number | null;
};

async function selectedAssetLineage(input: {
  runId: string;
  assetId: string;
  purpose: "character_cover" | "character_hero" | "character_chat";
}) {
  const item = await prisma.contentProductionItem.findFirstOrThrow({
    where: {
      batchId: input.runId,
      mediaAssetId: input.assetId,
      status: "generated",
    },
    include: { batch: true, job: true, mediaAsset: true },
  });
  expect(item.batch).toMatchObject({
    id: input.runId,
    purpose: input.purpose,
    targetType: "character",
    targetId: wizardCharacterId,
  });
  expect(item.job).not.toBeNull();
  expect(item.mediaAsset).toMatchObject({
    id: input.assetId,
    characterId: wizardCharacterId,
    sourceJobId: item.jobId,
    safetyStatus: "passed",
    deletedAt: null,
  });
  expect(
    await prisma.creativeReviewDecision.count({ where: { runItemId: item.id } }),
  ).toBe(0);
  const attempt = await prisma.generationAttempt.findFirstOrThrow({
    where: {
      requestId: item.jobId!,
      status: "succeeded",
    },
    orderBy: { attemptNo: "desc" },
  });
  expect(item.job).toMatchObject({
    id: item.jobId,
    sourceType: "content_production_item",
    sourceId: item.id,
    status: "completed",
    deliveredOutputCount: 1,
  });
  expect(attempt).toMatchObject({
    requestId: item.jobId,
    provider: item.job!.provider,
    profileKey: item.job!.profileId,
    profileVersion: item.job!.profileVersion,
    workflowKey: item.job!.model,
  });
  return {
    assetId: input.assetId,
    runId: input.runId,
    itemId: item.id,
    generationJobId: item.jobId!,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    provider: attempt.provider,
    profileKey: attempt.profileKey,
    profileVersion: attempt.profileVersion,
    workflowKey: attempt.workflowKey,
    workflowVersion: attempt.workflowVersion,
  } satisfies SelectedAssetLineage;
}

async function completeGenericCreativePlacement(
  page: Page,
  input: {
    readonly targetId: string;
    readonly eyebrow: string;
    readonly title: string;
    readonly reason: string;
    readonly keyboard?: boolean;
  },
) {
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Score", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Destination", { exact: true })).toHaveValue(
    "Campaign collection",
  );
  await page.getByLabel("Campaign destination key").fill(input.targetId);
  await page.getByLabel("Campaign eyebrow").fill(input.eyebrow);
  await page.getByLabel("Campaign title").fill(input.title);
  await page.getByLabel("Staging reason", { exact: true }).fill(input.reason);
  const stagePlacement = page.getByRole("button", {
    name: "Stage campaign candidate",
  });
  await expect(stagePlacement).toBeEnabled();
  if (input.keyboard) {
    await stagePlacement.focus();
    await expect(stagePlacement).toBeFocused();
    await stagePlacement.press("Enter");
  } else {
    await stagePlacement.click();
  }
  await expect(page.getByText("campaign · verifying")).toBeVisible();
}

async function login(page: Page) {
  const response = await page.request.post(
    `${adminBaseURL()}/api/admin-auth/login`,
    {
      data: { username: "admin", password: "admin123" },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function completeCharacterCreateDraft(
  page: Page,
  name: string,
  assertNotCreated: () => Promise<void>,
) {
  await assertNotCreated();

  await page.getByLabel("Name", { exact: true }).fill(name);
  await page
    .getByLabel("Character promise")
    .fill("A warm, precise place to put the day down");
  await page
    .getByLabel("First message")
    .fill("You made it. What do you need to put down tonight?");
  await page
    .getByLabel("Additional details · Markdown (optional)")
    .fill(
      "## Personality and voice\nObservant, measured, warm, and gently challenging.\n\n## Background\nYears hosting a late-night radio show taught her to notice what people leave unsaid.",
    );
  await page.getByRole("button", { name: "Continue to visual direction", exact: true }).click();
  await assertNotCreated();

  await page
    .getByLabel("Identity anchor")
    .fill("Composed late-night radio host with a recognizable adult face");
  await page
    .getByLabel("Stable traits (one per line)")
    .fill("Dark wavy hair\nWarm brown eyes");
  await page
    .getByLabel("Reference direction")
    .fill("Low-key tungsten portraiture with an intimate editorial crop");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await assertNotCreated();

  await expect(page.getByRole("heading", { name: "Review & create", exact: true })).toBeVisible();
}

function consoleFailures(page: Page, expected: RegExp[] = []) {
  const failures: string[] = [];
  page.on("console", (message) => {
    const actionableNextImageWarning =
      message.type() === "warning" &&
      message
        .text()
        .includes("was detected as the Largest Contentful Paint (LCP)");
    if (
      (message.type() === "error" || actionableNextImageWarning) &&
      !expected.some((pattern) => pattern.test(message.text()))
    ) {
      failures.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (!expected.some((pattern) => pattern.test(error.message)))
      failures.push(error.message);
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
      .filter(
        (element) => element.right > window.innerWidth + 1 || element.left < -1,
      )
      .slice(0, 8),
  }));
  expect(
    metrics.documentWidth,
    JSON.stringify(metrics, null, 2),
  ).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

async function expectWcag22AA(page: Page) {
  await page.addScriptTag({ content: axe.source });
  const results = (await page.evaluate(async () => {
    const runner = (window as typeof window & { axe: typeof axe }).axe;
    return runner.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
  })) as AxeResults;
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      failureSummary: node.failureSummary,
    })),
  }));
  expect(
    violations,
    `${page.url()}\n${JSON.stringify(violations, null, 2)}`,
  ).toEqual([]);
}

function requiredInputJson(
  value: Prisma.JsonValue,
  field: string,
): Prisma.InputJsonValue {
  if (value === null)
    throw new Error(`${field} fixture must contain JSON evidence`);
  return value;
}

async function seedResponsiveCoreFixture(fixture: ResponsiveCoreFixture) {
  await prisma.generationJob.create({
    data: {
      id: fixture.creativeJobId,
      userId: actorId,
      mode: "image",
      controls: {},
      presetIds: [],
      status: "completed",
      outputCount: 1,
      deliveredOutputCount: 1,
      provider: "pipeline",
      sourceType: "content_production_item",
      sourceId: fixture.creativeItemId,
      completedAt: new Date(),
    },
  });
  await prisma.generationAttempt.create({
    data: {
      id: fixture.creativeAttemptId,
      requestId: fixture.creativeJobId,
      attemptNo: 1,
      provider: "pipeline",
      status: "succeeded",
      finishedAt: new Date(),
    },
  });
  await prisma.mediaAsset.create({
    data: {
      id: fixture.creativeAssetId,
      ownerId: actorId,
      sourceJobId: fixture.creativeJobId,
      type: "image",
      url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%2396a68d'/%3E%3C/svg%3E",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { source: `admin_v2_playwright_${fixture.label}` },
    },
  });
  await prisma.contentProductionBatch.create({
    data: {
      id: fixture.creativeRunId,
      title: `E2E ${fixture.label} Creative Run ${suffix}`,
      purpose: "campaign",
      targetType: "campaign",
      targetId: `campaign-${fixture.label}-${suffix}`,
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
          id: fixture.creativeItemId,
          itemIndex: 0,
          jobId: fixture.creativeJobId,
          status: "generated",
          mediaAssetId: fixture.creativeAssetId,
          tags: [],
        },
      },
    },
  });

  const incidentLastSeen = new Date(Date.now() - 30 * 60_000);
  await prisma.generationJob.create({
    data: {
      id: fixture.incidentRequestId,
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
      id: fixture.incidentAttemptId,
      requestId: fixture.incidentRequestId,
      attemptNo: 1,
      provider: `e2e-${fixture.label}-provider`,
      profileKey: `e2e-${fixture.label}-profile`,
      workflowKey: `e2e-${fixture.label}-workflow`,
      status: "succeeded",
      finishedAt: new Date(incidentLastSeen.getTime() + 5 * 60_000),
    },
  });
  await prisma.opsIncident.create({
    data: {
      id: fixture.incidentId,
      signature: `provider:profile:e2e-${fixture.label}-${suffix}`,
      signatureVersion: "v1",
      activeCorrelationKey: `e2e-${fixture.label}-active-${suffix}`,
      status: "monitoring",
      severity: "high",
      ownerId: actorId,
      firstSeen: new Date(incidentLastSeen.getTime() - 5 * 60_000),
      lastSeen: incidentLastSeen,
      slaDueAt: new Date(Date.now() + 3_600_000),
      impact: {
        affectedRequests: 2,
        affectedUsers: 1,
        failedCostMicros: 900,
        refundedDreamcoins: 0,
      },
      mitigation: {
        recommendedActions: ["inspect responsive route"],
        signatureComponents: {
          provider: `e2e-${fixture.label}-provider`,
          profileKey: `e2e-${fixture.label}-profile`,
          workflowKey: `e2e-${fixture.label}-workflow`,
          errorClass: "provider_regression",
          normalizedError: `e2e-${fixture.label}-regression-${suffix}`,
        },
      },
      suspectedCause: `E2E ${fixture.label} provider regression ${suffix}`,
      confidence: 0.8,
    },
  });
  await prisma.opsIncidentOccurrence.create({
    data: {
      id: fixture.incidentOccurrenceId,
      incidentId: fixture.incidentId,
      requestId: fixture.incidentRequestId,
      attemptId: fixture.incidentAttemptId,
      occurrenceKey: `e2e-${fixture.label}-recovered:${suffix}`,
      observedAt: incidentLastSeen,
    },
  });

  await prisma.adminCase.create({
    data: {
      id: fixture.caseId,
      type: "support_request",
      targetType: "user",
      targetId: fixture.caseTargetId,
      caseKey: `support:e2e:${fixture.label}:${suffix}`,
      activeKey: `support_request:user:${fixture.caseTargetId}:support:e2e:${fixture.label}:${suffix}`,
      status: "in_progress",
      priority: "high",
      ownerId: actorId,
      slaDueAt: new Date(Date.now() + 3_600_000),
      resolution: { severity: "high" },
    },
  });
  await prisma.caseEvidence.create({
    data: {
      id: fixture.caseEvidenceId,
      caseId: fixture.caseId,
      sourceType: "support_message",
      sourceId: `support-message-${fixture.label}-${suffix}`,
      snapshot: {
        description: `Customer supplied immutable ${fixture.label} reproduction evidence.`,
      },
      occurredAt: new Date(),
    },
  });
}

async function seedStrictCharacterCandidate(candidateId: string) {
  if (!wizardCharacterId) {
    throw new Error(
      "The complete Character Asset Studio journey must publish before lifecycle candidates are cloned.",
    );
  }
  const characterId = wizardCharacterId;
  const serving = await prisma.characterServing.findUniqueOrThrow({
    where: { characterId },
  });
  if (!serving.currentReleaseId) {
    throw new Error("The complete Character has no current immutable Release.");
  }
  const source = await prisma.characterRelease.findUniqueOrThrow({
    where: { id: serving.currentReleaseId },
  });
  const candidate = await prisma.characterRelease.create({
    data: {
      id: candidateId,
      projectId: source.projectId,
      revisionId: source.revisionId,
      characterContentVersionId: source.characterContentVersionId,
      visualProfileId: source.visualProfileId,
      visualProfileVersion: source.visualProfileVersion,
      referenceSetRevisionId: source.referenceSetRevisionId,
      generationProvenance: requiredInputJson(
        source.generationProvenance,
        "generationProvenance",
      ),
      releasePlacementManifest: requiredInputJson(
        source.releasePlacementManifest,
        "releasePlacementManifest",
      ),
      snapshotHash: source.snapshotHash,
      readiness: "unknown",
      legacy: false,
      status: "approved",
      supersedesId: serving.currentReleaseId,
    },
  });
  await prisma.$transaction(async (tx) => {
    const validation = await validateCharacterReleaseSnapshot(tx, candidate, CHARACTER_RELEASE_POLICY_VERSION, new Date());
    expect(validation.failed).toEqual([]);
    await tx.characterRelease.update({ where: { id: candidate.id }, data: { readiness: "ready" } });
  });
  return { characterId, source };
}

async function seedResponsiveCharacterCandidate(
  fixture: ResponsiveCoreFixture,
) {
  return seedStrictCharacterCandidate(fixture.candidateReleaseId);
}

async function completeResponsiveCoreFlows(
  page: Page,
  fixture: ResponsiveCoreFixture,
) {
  const failures = consoleFailures(page);
  await login(page);
  await page.setViewportSize(fixture.viewport);
  const lifecycle = await seedResponsiveCharacterCandidate(fixture);
  const lifecycleCharacterId = lifecycle.characterId;

  await page.goto(
    `${adminBaseURL()}/admin/characters/${lifecycleCharacterId}?tab=assets`,
  );
  await expect(
    page.getByRole("heading", { level: 2, name: characterName }),
  ).toBeVisible();
  if (fixture.label === "mobile") {
    await expect(page.getByLabel("Workspace page", { exact: true })).toHaveValue("assets");
  } else {
    await expect(page.getByRole("tab", { name: "Images", exact: true })).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.getByRole("heading", { name: `All images for ${characterName}`, exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  const importImage = page
    .locator("#character-panel-assets")
    .getByRole("button", {
      name: "Import image",
      exact: true,
    })
    .and(page.locator("button"));
  await importImage.focus();
  await expect(importImage).toBeFocused();

  await page.goto(`${adminBaseURL()}/admin/creative/runs`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Generation History", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "Create images" }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Creative brief")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);

  await page.goto(`${adminBaseURL()}/admin/content/assets`);
  await expect(
    page.getByRole("heading", { name: "Operational Assets", level: 1, exact: true }),
  ).toBeVisible();
  const uploadImages = page
    .getByRole("region", { name: "Upload operational images", exact: true })
    .getByRole("button", { name: "Upload images", exact: true });
  await expect(uploadImages).toBeVisible();
  await uploadImages.focus();
  await expect(uploadImages).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);

  await page.goto(
    `${adminBaseURL()}/admin/content/assets/${fixture.creativeAssetId}`,
  );
  await expect(
    page.getByRole("heading", { name: fixture.creativeAssetId.slice(0, 8) }),
  ).toBeVisible();
  await expect(page.getByText("Authority & usage")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);

  await page.goto(
    `${adminBaseURL()}/admin/characters/${lifecycleCharacterId}?tab=release`,
  );
  await expect(
    page.getByRole("heading", { level: 2, name: characterName }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  if (fixture.label === "mobile") {
    const workspacePage = page.getByLabel("Workspace page", { exact: true });
    await workspacePage.focus();
    await expect(workspacePage).toBeFocused();
    await workspacePage.selectOption("monitor");
    await expect(workspacePage).toHaveValue("monitor");
    await workspacePage.selectOption("release");
  } else {
    const releaseTab = page.getByRole("tab", { name: "Release", exact: true });
    await releaseTab.focus();
    await expect(releaseTab).toBeFocused();
    await releaseTab.press("ArrowRight");
    const monitorTab = page.getByRole("tab", { name: "Live monitoring", exact: true });
    await expect(monitorTab).toBeFocused();
    await expect(monitorTab).toHaveAttribute("aria-selected", "true");
    await monitorTab.press("ArrowLeft");
    await expect(releaseTab).toBeFocused();
  }
  const candidateCard = page
    .locator("article")
    .filter({ hasText: fixture.candidateReleaseId });
  await expect(candidateCard).toContainText("ready");
  const publishRelease = page.getByRole("button", {
    name: "Publish Character",
  });
  await publishRelease.focus();
  await expect(publishRelease).toBeFocused();
  await publishRelease.press("Enter");
  await expect
    .poll(async () =>
      prisma.controlPlaneCommand.findFirst({
        where: {
          commandType: "character.release.publish",
          targetId: fixture.candidateReleaseId,
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
    )
    .not.toBeNull();
  const queuedPublish = await prisma.controlPlaneCommand.findFirstOrThrow({
    where: {
      commandType: "character.release.publish",
      targetId: fixture.candidateReleaseId,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  await executeCharacterReleaseCommand(prisma, {
    commandId: queuedPublish.id,
    workerId: `playwright-release-${fixture.label}-${suffix}`,
  });
  await expect
    .poll(async () =>
      prisma.characterServing.findUnique({
        where: { characterId: lifecycleCharacterId },
        select: { currentReleaseId: true, state: true },
      }),
    )
    .toEqual({ currentReleaseId: fixture.candidateReleaseId, state: "live" });
  await page.reload();
  await expect(
    page.locator("article").filter({ hasText: fixture.candidateReleaseId }),
  ).toContainText("serving now");

  await page.goto(
    `${adminBaseURL()}/admin/creative/runs/${fixture.creativeRunId}`,
  );
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: `E2E ${fixture.label} Creative Run ${suffix}`,
    }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  await completeGenericCreativePlacement(page, {
    targetId: `campaign-${fixture.label}-${suffix}`,
    eyebrow: `E2E ${fixture.label} feature`,
    title: `Selected ${fixture.label} campaign ${suffix}`,
    reason: `Stage the selected ${fixture.label} candidate for authoritative campaign verification.`,
    keyboard: true,
  });
  const verifyPlacement = page.getByRole("button", {
    name: "Verify & activate",
  });
  await verifyPlacement.focus();
  await expect(verifyPlacement).toBeFocused();
  await verifyPlacement.press("Enter");
  await expect(page.getByText("campaign · passed")).toBeVisible();
  await expect
    .poll(async () =>
      prisma.contentProductionBatch.findUnique({
        where: { id: fixture.creativeRunId },
        select: { workflowStage: true, verificationState: true },
      }),
    )
    .toEqual({ workflowStage: "verification", verificationState: "passed" });
  await expect
    .poll(async () =>
      prisma.creativeReviewDecision.count({
        where: { runItemId: fixture.creativeItemId },
      }),
    )
    .toBe(0);
  await expect
    .poll(async () =>
      prisma.mediaAssetPlacement.count({
        where: {
          mediaAssetId: fixture.creativeAssetId,
          status: "published",
          verificationState: "passed",
        },
      }),
    )
    .toBe(1);

  await page.goto(
    `${adminBaseURL()}/admin/ops/incidents/${fixture.incidentId}`,
  );
  await expect(
    page.getByRole("heading", {
      level: 3,
      name: `E2E ${fixture.label} provider regression ${suffix}`,
    }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  await page
    .getByLabel("Audit reason", { exact: true })
    .fill(`Recovery authority reviewed at ${fixture.label}`);
  await page
    .getByLabel(
      "Supplemental evidence reference (optional for authority check)",
    )
    .fill(`monitor://e2e/${fixture.label}/${suffix}`);
  const verifyIncident = page.getByRole("button", {
    name: "Run authority verification",
  });
  await verifyIncident.focus();
  await expect(verifyIncident).toBeFocused();
  await verifyIncident.press("Enter");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Authority recovery verification evaluated" }),
  ).toBeVisible();
  const resolveIncident = page.getByRole("button", {
    name: "Resolve incident",
  });
  await expect(resolveIncident).toBeEnabled();
  await resolveIncident.focus();
  await expect(resolveIncident).toBeFocused();
  await resolveIncident.press("Enter");
  await expect
    .poll(
      async () =>
        prisma.opsIncident.findUnique({
          where: { id: fixture.incidentId },
          select: { status: true },
        }),
      { timeout: 45_000 },
    )
    .toEqual({ status: "resolved" });
  await page.goto(
    `${adminBaseURL()}/admin/ops/incidents/${fixture.incidentId}`,
  );
  await expect(
    page.getByRole("heading", { level: 4, name: "Postmortem and close" }),
  ).toBeVisible();
  await page
    .getByLabel("Audit reason", { exact: true })
    .fill(`Recovery authority reviewed at ${fixture.label}`);
  await page
    .getByLabel(
      "Supplemental evidence reference (optional for authority check)",
    )
    .fill(`monitor://e2e/${fixture.label}/${suffix}`);
  await page
    .getByLabel("Summary", { exact: true })
    .fill(
      `Provider route recovered and ${fixture.label} authority evidence was reconciled.`,
    );
  await page
    .getByLabel("Root cause")
    .fill(`${fixture.label} provider route regression`);
  await page
    .getByLabel("Contributing factors (one per line)")
    .fill("Capacity signal lag");
  await page
    .getByLabel("Corrective actions (one per line)")
    .fill("Keep the responsive authority canary active");
  await page
    .getByLabel("Type close confirmation")
    .fill(`${fixture.incidentId}:close`);
  await page.getByLabel("Close audit reason").fill("Verified recovery and recorded the postmortem");
  const closeIncident = page.getByRole("button", {
    name: "Record postmortem and close",
  });
  await closeIncident.focus();
  await expect(closeIncident).toBeFocused();
  await closeIncident.press("Enter");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Postmortem recorded and Incident closed" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      prisma.opsIncident.findUnique({
        where: { id: fixture.incidentId },
        select: {
          status: true,
          verificationState: true,
          activeCorrelationKey: true,
        },
      }),
    )
    .toEqual({
      status: "closed",
      verificationState: "passed",
      activeCorrelationKey: null,
    });

  await page.goto(`${adminBaseURL()}/admin/cases/${fixture.caseId}`);
  if (fixture.label === "mobile") {
    await page.locator('[data-case-mobile-step="evidence"]').click();
  }
  await expect(
    page.getByRole("heading", { level: 4, name: "Evidence" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Evidence", exact: true }).getByText(
      `Customer supplied immutable ${fixture.label} reproduction evidence.`,
      { exact: true },
    ),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  if (fixture.label === "mobile") {
    const nextStep = page.locator("[data-case-mobile-actions]").getByRole("button", { name: "Next", exact: true });
    await nextStep.focus();
    await expect(nextStep).toBeFocused();
    await nextStep.press("Enter");
    await expect(page.locator('[data-case-mobile-step="decision"]')).toHaveAttribute("aria-current", "step");
  }
  const caseDecision = page.locator(
    'section[aria-labelledby="case-decision-title"]',
  );
  await caseDecision.locator("select").selectOption("incident_escalated");
  await page
    .getByLabel("Outcome reference")
    .fill(`incident:${fixture.incidentId}`);
  await page
    .getByLabel("Resolution summary")
    .fill(
      `Escalated the ${fixture.label} customer impact and verified the recovered Incident authority state.`,
    );
  const recordCaseAction = caseDecision.getByRole("button", { name: "Record action" });
  await recordCaseAction.focus();
  await expect(recordCaseAction).toBeFocused();
  await recordCaseAction.press("Enter");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Customer Case action recorded" }),
  ).toBeVisible();
  const verifyCase = page.getByRole("button", {
    name: "Verify from authority",
  });
  await expect(verifyCase).toBeEnabled();
  await verifyCase.focus();
  await expect(verifyCase).toBeFocused();
  await verifyCase.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Downstream outcome verified" }),
  ).toBeVisible();
  const closeCase = caseDecision.getByRole("button", {
    name: "Close case",
    exact: true,
  });
  await closeCase.focus();
  await expect(closeCase).toBeFocused();
  await closeCase.press("Enter");
  const closeDialog = page.getByRole("dialog", { name: "Close case" });
  await closeDialog.getByLabel("Reason (≥3)").fill(`${fixture.label} authority outcome verified for closure`);
  await closeDialog.getByLabel("Type confirmation").fill(`${fixture.caseId}:close`);
  await closeDialog.getByRole("button", { name: "Close case", exact: true }).press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Case close command accepted" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      prisma.adminCase.findUnique({
        where: { id: fixture.caseId },
        select: { status: true, verificationState: true, activeKey: true },
      }),
    )
    .toEqual({
      status: "closed",
      verificationState: "passed",
      activeKey: null,
    });
  await expect
    .poll(async () =>
      prisma.decisionRecord.count({
        where: { sourceId: fixture.caseId, decision: "incident_escalated" },
      }),
    )
    .toBe(1);
  await expectNoHorizontalOverflow(page);

  if (fixture.label === "mobile") {
    await page.goto(`${adminBaseURL()}/admin/cases?view=mine`);
    await page.getByLabel("Search all cases").fill(`missing-${suffix}`);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(
      page.getByText("No work matches these filters", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
  }
  expect(failures).toEqual([]);
}

test.describe.serial("Admin v2 operator workspaces", () => {
  test.describe.configure({ retries: 0 });
  test.beforeAll(async () => {
    const identityWorkflow = await generationWorkflowDescriptor(
      "qwen-image-edit-img2img",
    );
    if (!identityWorkflow) throw new Error("E2E identity workflow is unavailable");
    identityWorkflowVersion = identityWorkflow.version;
    await prisma.generationModelProfile.createMany({
      data: [
        {
          id: wizardBootstrapProfileId,
          profileKey: wizardBootstrapProfileKey,
          label: "E2E pipeline identity bootstrap",
          mode: "image",
          runner: "comfyui",
          pipelineModel: "redcraft-krea2-redmix3-fp8",
          workflowKey: "redcraft-krea2-redmix3-txt2img",
          runnerConfig: {
            capabilities: {
              textToImage: true,
              stableSeed: true,
              referenceImages: false,
              initImage: false,
              lora: false,
            },
          },
          allowedOrientations: ["4:5", "16:9"],
          maxCount: 4,
          concurrencyLimit: 2,
          enabled: true,
          rolloutPercent: 100,
          version: 1,
          status: "active",
          publishedAt: new Date(),
        },
        {
          id: wizardIdentityProfileId,
          profileKey: wizardIdentityProfileKey,
          label: "E2E pipeline identity route",
          mode: "image",
          runner: "comfyui",
          pipelineModel: "qwen-image-edit",
          workflowKey: "qwen-image-edit-img2img",
          runnerConfig: {
            capabilities: {
              textToImage: false,
              stableSeed: true,
              referenceImages: true,
              initImage: true,
              lora: false,
            },
          },
          allowedOrientations: ["4:5", "16:9"],
          maxCount: 6,
          concurrencyLimit: 2,
          enabled: true,
          rolloutPercent: 100,
          version: 1,
          status: "active",
          publishedAt: new Date(),
        },
      ],
    });
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
    await prisma.generationJob.create({
      data: {
        id: retryRequestId,
        userId: actorId,
        mode: "image",
        controls: {},
        presetIds: [],
        status: "failed",
        outputCount: 1,
        errorCode: "e2e_retryable_failure",
        version: 1,
      },
    });
    await prisma.generationAttempt.create({
      data: {
        id: retryAttemptId,
        requestId: retryRequestId,
        attemptNo: 1,
        status: "failed",
        errorCode: "e2e_retryable_failure",
        retryability: "retryable",
        finishedAt: new Date(),
      },
    });
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
        impact: {
          affectedRequests: 3,
          affectedUsers: 2,
          failedCostMicros: 1200,
          refundedDreamcoins: 0,
        },
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
        snapshot: {
          description: "Customer supplied immutable reproduction evidence.",
        },
        occurredAt: new Date(),
      },
    });

    await prisma.mediaAsset.create({
      data: {
        id: releaseMediaId,
        ownerId: actorId,
        type: "image",
        url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='400'%3E%3Crect width='320' height='400' fill='%233a3347'/%3E%3Ccircle cx='160' cy='150' r='72' fill='%23d9b9a5'/%3E%3C/svg%3E",
        storageKey: `playwright/admin-v2/${releaseMediaId}.svg`,
        contentType: "image/svg+xml",
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
        advancedDetails: {
          firstMessage: "Welcome back. What should we make space for today?",
        },
      },
    });
    await prisma.mediaAsset.update({
      where: { id: releaseMediaId },
      data: { characterId: releaseCharacterId },
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
      adapterRefs: {},
      evidenceState: "qualified",
      createdFrom: "playwright",
    } satisfies Prisma.CharacterVisualProfileUncheckedCreateInput;
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
      references: [
        {
          mediaAssetId: releaseMediaId,
          position: 0,
          role: "primary_face",
          weight: 1,
        },
      ],
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
        generationProfileKey: wizardIdentityProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: identityWorkflowVersion,
        style: "realistic",
        matrixKey: "default-character",
        sampleCount: 40,
        passCount: 37,
        identityMatch: 0.925,
        result: "qualified",
        evidence: {
          reviewerId: actorId,
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const compiledSoulResult = compileCharacterSoul({
      name: releaseCharacterName,
      age: 29,
      gender: "female",
      characterPromise: "A grounded daily reflection partner.",
      detailsMarkdown:
        "Attentive, warm, and concise. A host who remembers the important details.",
    });
    if (!compiledSoulResult.ok)
      throw new Error("E2E Soul fixture must compile");
    const compiledSoul = compiledSoulResult.snapshot;
    await prisma.characterContentVersion.create({
      data: {
        id: releaseContentId,
        characterId: releaseCharacterId,
        version: 1,
        contentHash: `e2e-content-hash-${suffix}`,
        personaSnapshot: compiledSoul as unknown as Prisma.InputJsonValue,
        openingSnapshot: {
          firstMessage: "Welcome back. What should we make space for today?",
        },
        appearanceSnapshot: { style: "realistic", eyes: "amber" },
        sourceType: "playwright",
      },
    });
    await prisma.characterProject.create({
      data: {
        id: releaseProjectId,
        characterId: releaseCharacterId,
        activeKey: `official:${releaseCharacterId}`,
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: releaseRevisionId,
        projectId: releaseProjectId,
        revision: 1,
        characterContentVersionId: releaseContentId,
        projectSnapshot: {
          hypothesis: "A grounded tone improves repeat conversation.",
        },
      },
    });
    const generationProvenance = {
      routeFingerprint: releaseRouteFingerprint,
      matrixKey: "default-character",
      generationProfileKey: wizardIdentityProfileKey,
      generationProfileVersion: 1,
      workflowKey: "qwen-image-edit-img2img",
      workflowVersion: identityWorkflowVersion,
      visualProfileHash: characterVisualProfileSnapshotHash(visualProfile),
      referenceSetHash: referenceSetSnapshotHash(referenceSnapshot),
    };
    const releasePlacementManifest = {
      placements: [
        {
          slotKey: "character_avatar",
          assetId: releaseMediaId,
          slotVersion: 1,
        },
      ],
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
    await prisma.characterRelease.create({
      data: {
        id: oldReleaseId,
        ...sharedRelease,
        status: "published",
        publishedAt: new Date(Date.now() - 7 * 24 * 60 * 60_000),
        legacy: true,
      },
    });
    await prisma.characterServing.create({
      data: {
        characterId: releaseCharacterId,
        state: "live",
        currentReleaseId: oldReleaseId,
        version: 1,
      },
    });
    for (const fixture of responsiveCoreFixtures) {
      await seedResponsiveCoreFixture(fixture);
    }
  });

  test.afterAll(async () => {
    const responsiveCreativeRunIds = responsiveCoreFixtures.map(
      (fixture) => fixture.creativeRunId,
    );
    const responsiveCreativeItemIds = responsiveCoreFixtures.map(
      (fixture) => fixture.creativeItemId,
    );
    const responsiveCreativeAssetIds = responsiveCoreFixtures.map(
      (fixture) => fixture.creativeAssetId,
    );
    const responsiveCreativeJobIds = responsiveCoreFixtures.map(
      (fixture) => fixture.creativeJobId,
    );
    const responsiveCreativeAttemptIds = responsiveCoreFixtures.map(
      (fixture) => fixture.creativeAttemptId,
    );
    const responsiveIncidentIds = responsiveCoreFixtures.map(
      (fixture) => fixture.incidentId,
    );
    const responsiveIncidentRequestIds = responsiveCoreFixtures.map(
      (fixture) => fixture.incidentRequestId,
    );
    const responsiveIncidentAttemptIds = responsiveCoreFixtures.map(
      (fixture) => fixture.incidentAttemptId,
    );
    const responsiveCaseIds = responsiveCoreFixtures.map(
      (fixture) => fixture.caseId,
    );
    const responsiveReleaseIds = responsiveCoreFixtures.map(
      (fixture) => fixture.candidateReleaseId,
    );
    const wizardRuns =
      wizardRunIds.length > 0
        ? await prisma.contentProductionBatch.findMany({
            where: { id: { in: wizardRunIds } },
            include: {
              items: {
                include: {
                  job: {
                    include: { assets: true },
                  },
                },
              },
            },
          })
        : [];
    const wizardItemIds = wizardRuns.flatMap((run) =>
      run.items.map((item) => item.id),
    );
    const wizardJobIds = wizardRuns.flatMap((run) =>
      run.items.flatMap((item) => (item.jobId ? [item.jobId] : [])),
    );
    const wizardAssetIds = wizardRuns.flatMap((run) =>
      run.items.flatMap((item) => {
        const assetIds = [
          ...(item.mediaAssetId ? [item.mediaAssetId] : []),
          ...(item.job?.assets.map((asset) => asset.id) ?? []),
        ];
        return assetIds;
      }),
    );
    const wizardPlacementIds =
      wizardAssetIds.length > 0
        ? (
            await prisma.mediaAssetPlacement.findMany({
              where: { mediaAssetId: { in: wizardAssetIds } },
              select: { id: true },
            })
          ).map((placement) => placement.id)
        : [];
    const wizardAttemptIds =
      wizardJobIds.length > 0
        ? (
            await prisma.generationAttempt.findMany({
              where: { requestId: { in: wizardJobIds } },
              select: { id: true },
            })
          ).map((attempt) => attempt.id)
        : [];
    if (wizardRuns.length > 0) {
      await Promise.all(
        wizardJobIds.flatMap((jobId) => [
          jobQueue.removeByDedupePrefix(`generation:${jobId}`, [
            "ai.image.generate",
          ]),
          jobQueue.removeByDedupePrefix(`generation-finalize:${jobId}:`, [
            "app.ai.finalize",
          ]),
        ]),
      );
      const wizardProject = wizardCharacterId
        ? await prisma.characterProject.findFirst({
            where: { characterId: wizardCharacterId },
            select: { id: true },
          })
        : null;
      const wizardAuthorityTargetIds = [
        ...wizardRuns.map((run) => run.id),
        ...wizardItemIds,
        ...wizardJobIds,
        ...wizardPlacementIds,
        ...(wizardCharacterId ? [wizardCharacterId] : []),
        ...(wizardProject ? [wizardProject.id] : []),
      ];
      const wizardCommandIds = (
        await prisma.controlPlaneCommand.findMany({
          where: { targetId: { in: wizardAuthorityTargetIds } },
          select: { id: true },
        })
      ).map((command) => command.id);
      await prisma.controlPlaneCommandAttempt.deleteMany({
        where: { commandId: { in: wizardCommandIds } },
      });
      await prisma.controlPlaneCommand.deleteMany({
        where: { id: { in: wizardCommandIds } },
      });
      await prisma.mainOutboxEvent.deleteMany({
        where: {
          OR: [
            {
              id: {
                in: wizardRuns.flatMap((run) =>
                  run.items.map(
                    (item) => `creative_initial_${run.id}_${item.id}`,
                  ),
                ),
              },
            },
            { aggregateId: { in: wizardAuthorityTargetIds } },
          ],
        },
      });
      await prisma.adminAuditLog.deleteMany({
        where: { targetId: { in: wizardAuthorityTargetIds } },
      });
      await prisma.mediaAssetPlacement.deleteMany({
        where: { mediaAssetId: { in: wizardAssetIds } },
      });
      await prisma.moderationEvent.deleteMany({
        where: { targetId: { in: wizardJobIds } },
      });
      await prisma.generationDelivery.deleteMany({
        where: { requestId: { in: wizardJobIds } },
      });
      await prisma.generationArtifact.deleteMany({
        where: { attemptId: { in: wizardAttemptIds } },
      });
      await prisma.generationTransportExecution.deleteMany({
        where: { attemptId: { in: wizardAttemptIds } },
      });
      await prisma.generationAttemptEvent.deleteMany({
        where: { attemptId: { in: wizardAttemptIds } },
      });
      await prisma.generationAttempt.deleteMany({
        where: { id: { in: wizardAttemptIds } },
      });
      await prisma.generationSettlementLink.deleteMany({
        where: { requestId: { in: wizardJobIds } },
      });
      await prisma.creativeReviewDecision.deleteMany({
        where: { runItemId: { in: wizardItemIds } },
      });
      await prisma.contentProductionItem.deleteMany({
        where: { id: { in: wizardItemIds } },
      });
      await prisma.contentProductionBatch.deleteMany({
        where: { id: { in: wizardRuns.map((run) => run.id) } },
      });
    }
    const authorityTargetIds = [
      creativeRunId,
      creativeItemId,
      incidentId,
      caseId,
      candidateReleaseId,
      releaseCharacterId,
      ...responsiveCreativeRunIds,
      ...responsiveCreativeItemIds,
      ...responsiveIncidentIds,
      ...responsiveCaseIds,
      ...responsiveReleaseIds,
    ];
    const characters = await prisma.character.findMany({
      where: { name: { startsWith: "E2E V2 Companion " } },
      select: { id: true },
    });
    const characterIds = [
      ...new Set([
        ...characters.map((character) => character.id),
        ...(wizardCharacterId ? [wizardCharacterId] : []),
      ]),
    ];
    if (characterIds.length > 0) {
      const characterVisualProfileIds = (
        await prisma.characterVisualProfile.findMany({
          where: { characterId: { in: characterIds } },
          select: { id: true },
        })
      ).map((profile) => profile.id);
      const characterReferenceSetIds =
        characterVisualProfileIds.length > 0
          ? (
              await prisma.referenceSetRevision.findMany({
                where: { visualProfileId: { in: characterVisualProfileIds } },
                select: { id: true },
              })
            ).map((referenceSet) => referenceSet.id)
          : [];
      const projects = await prisma.characterProject.findMany({
        where: { characterId: { in: characterIds } },
        select: { id: true },
      });
      const projectIds = projects.map((project) => project.id);
      const characterReleaseIds = (
        await prisma.characterRelease.findMany({
          where: { projectId: { in: projectIds } },
          select: { id: true },
        })
      ).map((release) => release.id);
      const characterValidationRunIds = (
        await prisma.releaseValidationRun.findMany({
          where: { releaseId: { in: characterReleaseIds } },
          select: { id: true },
        })
      ).map((run) => run.id);
      const characterAuthorityIds = [
        ...projectIds,
        ...characterIds,
        ...characterReleaseIds,
      ];
      const characterCommandIds = (
        await prisma.controlPlaneCommand.findMany({
          where: { targetId: { in: characterAuthorityIds } },
          select: { id: true },
        })
      ).map((command) => command.id);
      await prisma.controlPlaneCommandAttempt.deleteMany({
        where: { commandId: { in: characterCommandIds } },
      });
      await prisma.controlPlaneCommand.deleteMany({
        where: { id: { in: characterCommandIds } },
      });
      await prisma.mainOutboxEvent.deleteMany({
        where: { aggregateId: { in: characterAuthorityIds } },
      });
      await prisma.adminCollaborationActivity.deleteMany({
        where: { targetId: { in: [...projectIds, ...characterReleaseIds] } },
      });
      await prisma.adminAuditLog.deleteMany({
        where: {
          targetId: {
            in: [...characterAuthorityIds, ...characterReferenceSetIds],
          },
        },
      });
      await prisma.publicCatalogQualification.deleteMany({
        where: { releaseId: { in: characterReleaseIds } },
      });
      await prisma.releaseCheckResult.deleteMany({
        where: { validationRunId: { in: characterValidationRunIds } },
      });
      await prisma.releaseValidationRun.deleteMany({
        where: { id: { in: characterValidationRunIds } },
      });
      await prisma.releaseMonitor.deleteMany({
        where: { releaseId: { in: characterReleaseIds } },
      });
      await prisma.characterReleaseEvent.deleteMany({
        where: { characterId: { in: characterIds } },
      });
      await prisma.characterServing.deleteMany({
        where: { characterId: { in: characterIds } },
      });
      await prisma.characterRelease.deleteMany({
        where: { id: { in: characterReleaseIds } },
      });
      await prisma.characterRevision.deleteMany({
        where: { projectId: { in: projectIds } },
      });
      await prisma.characterContentVersion.deleteMany({
        where: { characterId: { in: characterIds } },
      });
      await prisma.characterProject.deleteMany({
        where: { characterId: { in: characterIds } },
      });
      await prisma.character.deleteMany({
        where: { id: { in: characterIds } },
      });
    }
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: wizardAssetIds } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: wizardJobIds } },
    });
    const commandIds = (
      await prisma.controlPlaneCommand.findMany({
        where: { targetId: { in: authorityTargetIds } },
        select: { id: true },
      })
    ).map((command) => command.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commandIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { id: { in: commandIds } },
    });
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        aggregateId: {
          in: [...authorityTargetIds, releaseProjectId, oldReleaseId],
        },
      },
    });
    await prisma.adminAuditLog.deleteMany({
      where: {
        targetId: {
          in: [...authorityTargetIds, releaseProjectId, oldReleaseId],
        },
      },
    });
    await prisma.decisionRecord.deleteMany({
      where: { sourceId: { in: [caseId, ...responsiveCaseIds] } },
    });
    await prisma.incidentPostmortem.deleteMany({
      where: { incidentId: { in: [incidentId, ...responsiveIncidentIds] } },
    });
    await prisma.opsIncidentOccurrence.deleteMany({
      where: { incidentId: { in: [incidentId, ...responsiveIncidentIds] } },
    });
    await prisma.caseEvidence.deleteMany({
      where: { caseId: { in: [caseId, ...responsiveCaseIds] } },
    });
    await prisma.adminCase.deleteMany({
      where: { id: { in: [caseId, ...responsiveCaseIds] } },
    });
    await prisma.opsIncident.deleteMany({
      where: { id: { in: [incidentId, ...responsiveIncidentIds] } },
    });
    await prisma.generationAttempt.deleteMany({
      where: {
        id: { in: [incidentAttemptId, ...responsiveIncidentAttemptIds] },
      },
    });
    await prisma.generationJob.deleteMany({
      where: {
        id: { in: [incidentRequestId, ...responsiveIncidentRequestIds] },
      },
    });
    await prisma.generationAttemptEvent.deleteMany({
      where: { attemptId: retryAttemptId },
    });
    await prisma.generationAttempt.deleteMany({
      where: { requestId: retryRequestId },
    });
    await prisma.generationJob.deleteMany({ where: { id: retryRequestId } });
    await prisma.creativeReviewDecision.deleteMany({
      where: {
        runItemId: { in: [creativeItemId, ...responsiveCreativeItemIds] },
      },
    });
    await prisma.mediaAssetPlacement.deleteMany({
      where: {
        mediaAssetId: { in: [creativeAssetId, ...responsiveCreativeAssetIds] },
      },
    });
    await prisma.contentProductionItem.deleteMany({
      where: { id: { in: [creativeItemId, ...responsiveCreativeItemIds] } },
    });
    await prisma.contentProductionBatch.deleteMany({
      where: { id: { in: [creativeRunId, ...responsiveCreativeRunIds] } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: [creativeAssetId, ...responsiveCreativeAssetIds] } },
    });
    await prisma.generationAttempt.deleteMany({
      where: { id: { in: responsiveCreativeAttemptIds } },
    });
    await prisma.generationJob.deleteMany({
      where: { id: { in: responsiveCreativeJobIds } },
    });

    const releaseIds = (
      await prisma.characterRelease.findMany({
        where: { projectId: releaseProjectId },
        select: { id: true },
      })
    ).map((release) => release.id);
    const releaseValidationIds = (
      await prisma.releaseValidationRun.findMany({
        where: { releaseId: { in: releaseIds } },
        select: { id: true },
      })
    ).map((run) => run.id);
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId: { in: releaseIds } },
    });
    await prisma.releaseCheckResult.deleteMany({
      where: { validationRunId: { in: releaseValidationIds } },
    });
    await prisma.releaseValidationRun.deleteMany({
      where: { id: { in: releaseValidationIds } },
    });
    await prisma.releaseMonitor.deleteMany({
      where: { releaseId: { in: releaseIds } },
    });
    await prisma.characterReleaseEvent.deleteMany({
      where: { characterId: releaseCharacterId },
    });
    await prisma.adminCollaborationActivity.deleteMany({
      where: { targetId: { in: [releaseProjectId, ...releaseIds] } },
    });
    await prisma.characterServing.deleteMany({
      where: { characterId: releaseCharacterId },
    });
    await prisma.characterRelease.deleteMany({
      where: { id: { in: releaseIds } },
    });
    await prisma.characterRevision.deleteMany({
      where: { projectId: releaseProjectId },
    });
    await prisma.characterProject.deleteMany({
      where: { id: releaseProjectId },
    });
    await prisma.characterContentVersion.deleteMany({
      where: { characterId: releaseCharacterId },
    });
    await prisma.generationRouteQualification.deleteMany({
      where: { routeFingerprint: releaseRouteFingerprint },
    });
    await prisma.generationRouteQualification.deleteMany({
      where: { routeFingerprint: wizardRouteFingerprint },
    });
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { referenceSetRevisionId: releaseReferenceSetId },
    });
    await prisma.referenceSetRevision.deleteMany({
      where: { id: releaseReferenceSetId },
    });
    await prisma.characterVisualProfile.deleteMany({
      where: { id: releaseProfileId },
    });
    await prisma.character.deleteMany({ where: { id: releaseCharacterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: releaseMediaId } });
    await prisma.generationModelProfile.deleteMany({
      where: {
        id: { in: [wizardBootstrapProfileId, wizardIdentityProfileId] },
      },
    });
    await prisma.$disconnect();
  });

  test("takes one blank Character through automatic checks, identity, a complete image pack, and a verified Release", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const failures = consoleFailures(page);
    const createRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/v2/admin/characters"
      ) {
        createRequests.push(request.url());
      }
    });
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${adminBaseURL()}/admin/characters/new`);
    await expect(
      page.getByRole("heading", { level: 2, name: "Create Character", exact: true }),
    ).toBeVisible();
    const assertNotCreated = async () => {
      expect(createRequests).toHaveLength(0);
      expect(
        await prisma.character.count({
          where: { name: characterName },
        }),
      ).toBe(0);
    };
    await completeCharacterCreateDraft(page, characterName, assertNotCreated);
    expect(
      await page.evaluate(
        (key) => window.localStorage.getItem(key),
        `idream.admin.character-create-draft.v3:${actorId}`,
      ),
    ).not.toBeNull();
    const characterCreateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v2/admin/characters",
    );
    await page
      .getByRole("button", {
        name: "Save character",
      })
      .click();
    const createdResponse = await characterCreateResponse;
    expect(createdResponse.status()).toBe(201);
    const createdCharacter = characterProjectCreateResponseSchema.parse(
      (await createdResponse.json()).data,
    );
    await expect(page).toHaveURL(
      `${adminBaseURL()}/admin/characters/${createdCharacter.characterId}?tab=assets`,
    );
    expect(createRequests).toHaveLength(1);
    expect(
      await page.evaluate(
        (key) => window.localStorage.getItem(key),
        `idream.admin.character-create-draft.v3:${actorId}`,
      ),
    ).toBeNull();
    wizardCharacterId = new URL(page.url()).pathname.split("/").at(-1) ?? null;
    if (!wizardCharacterId)
      throw new Error("Character wizard did not return a Character id");
    const initialProject = await prisma.characterProject.findFirstOrThrow({
      where: { characterId: wizardCharacterId },
    });
    expect(
      await prisma.characterVisualProfile.count({
        where: { characterId: wizardCharacterId },
      }),
    ).toBe(0);
    await openCharacterTab(page, "assets");

    await expect(
      page.getByRole("heading", {
        name: "Establish the face customers will recognize",
      }),
    ).toBeVisible();
    await expect(page.getByText(/No reference image is needed\./)).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Generate 1 portrait",
      }),
    ).toBeEnabled();
    await openCharacterTab(page, "visual");
    const advancedIdentity = page.locator("#visual-identity-version");
    if (await advancedIdentity.getAttribute("open") === null) {
      await advancedIdentity.locator("summary").first().click();
    }
    await expect(
      page.getByText(
        "Choose the first identity portrait in the image library before creating later identity versions.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create & activate version" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Open Character Assets" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Establish the face customers will recognize",
      }),
    ).toBeVisible();
    await expect(page.getByText(/No reference image is needed\./)).toBeVisible();

    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v2/admin/creative/runs",
    );
    await page.getByRole("button", { name: "Generate 1 portrait" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(202);
    const createPayload = (await createResponse.json()) as {
      data: { batch: { id: string } };
    };
    wizardBootstrapRunId = createPayload.data.batch.id;
    wizardRunIds.push(wizardBootstrapRunId);

    const createdRun = await prisma.contentProductionBatch.findUniqueOrThrow({
      where: { id: wizardBootstrapRunId },
      include: {
        items: {
          orderBy: { itemIndex: "asc" },
          include: { job: true },
        },
      },
    });
    expect(createdRun.items).toHaveLength(1);
    expect(createdRun.items.every((item) => item.job)).toBe(true);
    const outboxIds = createdRun.items.map(
      (item) => `creative_initial_${createdRun.id}_${item.id}`,
    );
    expect(
      await prisma.mainOutboxEvent.count({
        where: { id: { in: outboxIds }, status: "delivered" },
      }),
    ).toBe(1);
    for (const item of createdRun.items) {
      expect(
        await jobQueue.getByDedupeKey(
          "ai.image.generate",
          `generation:${item.jobId}:attempt:1`,
        ),
      ).not.toBeNull();
      expect(item.job).toMatchObject({
        characterId: wizardCharacterId,
        provider: "pipeline",
        profileId: wizardBootstrapProfileKey,
        referenceAssetIds: null,
        referenceSetRevisionId: null,
        outputCount: 1,
        status: "queued",
        sourceMeta: expect.objectContaining({
          bootstrapIdentity: true,
          bootstrapProjectVersion: initialProject.version,
          characterContentVersionId: expect.any(String),
          visualBriefHash: expect.any(String),
          bootstrapAuthorityState: "new",
          expectedIdentityHistoryFingerprint: expect.any(String),
          expectedIdentityVersion: 1,
        }),
      });
    }

    await drainCreativeRun(page, wizardBootstrapRunId, 1);
    const assetStudioRefresh = page.getByRole("region", { name: "Image creator", exact: true }).getByRole("button", {
      name: "Refresh",
      exact: true,
    });
    await expect(assetStudioRefresh).toBeEnabled();
    await assetStudioRefresh.click();
    await expect(
      page.getByRole("button", { name: /View candidate/ }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "View candidate 1", exact: true }).getByRole("img", {
        name: /Primary portrait Candidate 1$/i,
      }),
    ).toHaveJSProperty("complete", true);
    await page.getByRole("button", { name: "View candidate 1", exact: true }).click();
    expect(
      await prisma.creativeReviewDecision.count({
        where: { runItemId: { in: createdRun.items.map((item) => item.id) } },
      }),
    ).toBe(0);
    expect(
      await prisma.characterProject.findUniqueOrThrow({
        where: { id: initialProject.id },
        select: { version: true },
      }),
    ).toEqual({ version: initialProject.version });

    // Daily selection is the operator's decision; automated safety and exact
    // generation lineage remain required without manufacturing a review receipt.
    await expect(page.getByRole("region", {
      name: "Record the visible review evidence",
    })).toHaveCount(0);
    await expect(page.getByRole("button", {
      name: "Approve current candidate",
    })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Set as identity", exact: true }),
    ).toBeEnabled();

    await prisma.generationRouteQualification.create({
      data: {
        routeFingerprint: wizardRouteFingerprint,
        generationProfileKey: wizardIdentityProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: identityWorkflowVersion,
        style: wizardVisualStyle,
        matrixKey: "e2e-character-asset-pack",
        sampleCount: 40,
        passCount: 40,
        identityMatch: 1,
        result: "qualified",
        evidence: {
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
          source: "same-character-playwright-journey",
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const bootstrapResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/v2/admin/characters/${wizardCharacterId}/identity-bootstrap`,
    );
    await page.getByRole("button", { name: "Set as identity", exact: true }).click();
    const bootstrapResponse = await bootstrapResponsePromise;
    expect(bootstrapResponse.ok(), await bootstrapResponse.text()).toBeTruthy();

    const selectedItem = await prisma.contentProductionItem.findFirstOrThrow({
      where: { batchId: wizardBootstrapRunId, status: "generated" },
      include: { job: true, mediaAsset: true },
    });
    const coverLineage = await selectedAssetLineage({
      runId: wizardBootstrapRunId,
      assetId: selectedItem.mediaAssetId!,
      purpose: "character_cover",
    });
    const profile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId: wizardCharacterId, status: "active" },
    });
    expect(profile).toMatchObject({
      version: 1,
      style: wizardVisualStyle,
      evidenceState: "reviewed_bootstrap",
      anchorAssetIds: [selectedItem.mediaAssetId],
    });
    expect(profile.immutableHash).toBe(
      characterVisualProfileSnapshotHash(profile),
    );
    const referenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profile.id, status: "active" },
      include: { references: { orderBy: { position: "asc" } } },
    });
    expect(referenceSet.revision).toBe(1);
    expect(referenceSet.references).toEqual([
      expect.objectContaining({
        mediaAssetId: selectedItem.mediaAssetId,
        role: "primary_face",
        qualityScore: null,
      }),
    ]);
    expect(referenceSet.snapshotHash).toBe(
      referenceSetSnapshotHash(referenceSet),
    );
    const updatedProject = await prisma.characterProject.findUniqueOrThrow({
      where: { id: initialProject.id },
    });
    expect(updatedProject.version).toBe(initialProject.version + 1);
    expect(updatedProject.draftImageAssetId).toBe(selectedItem.mediaAssetId);
    expect(updatedProject.draftAssetPack).toMatchObject({
      character_cover: {
        assetId: selectedItem.mediaAssetId,
        runId: wizardBootstrapRunId,
        itemId: selectedItem.id,
        generationJobId: selectedItem.jobId,
        bootstrapIdentity: true,
      },
    });
    expect(
      await prisma.character.findUniqueOrThrow({
        where: { id: wizardCharacterId },
      }),
    ).toMatchObject({ imageAssetId: null });
    await expect(page.getByRole("button", { name: "Generate 1 hero image" })).toBeEnabled();
    await openCharacterTab(page, "visual");
    const referencePublication = page.getByRole("region", { name: "Anchors & published references", exact: true });
    await expect(referencePublication.getByRole("heading", { name: "Publish Reference Set revision", exact: true })).toBeVisible();
    await expect(referencePublication.locator("label").filter({ hasText: selectedItem.mediaAssetId! }).getByRole("checkbox")).toBeChecked();
    await openCharacterTab(page, "assets");

    const heroRunId = await generateCharacterAssetRun(
      page,
      "Generate 1 hero image",
      1,
    );
    const selectHero = page.getByRole("button", {
      name: "Select hero · next asset",
    });
    await expect(selectHero).toBeEnabled();
    const heroSelectionResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname ===
          `/api/v2/admin/characters/${wizardCharacterId}/draft-image`,
    );
    await selectHero.click();
    const heroSelectionResponse = await heroSelectionResponsePromise;
    expect(
      heroSelectionResponse.ok(),
      await heroSelectionResponse.text(),
    ).toBeTruthy();
    const heroSelectionPayload = (await heroSelectionResponse.json()) as {
      data: { selectedAssetId: string };
    };
    const heroLineage = await selectedAssetLineage({
      runId: heroRunId,
      assetId: heroSelectionPayload.data.selectedAssetId,
      purpose: "character_hero",
    });
    await expect(
      page.getByRole("button", { name: "Generate 1 chat image" }),
    ).toBeEnabled();

    const chatRunId = await generateCharacterAssetRun(
      page,
      "Generate 1 chat image",
      1,
    );
    const selectChat = page.getByRole("button", {
      name: "Select chat asset · preview",
    });
    await expect(selectChat).toBeEnabled();
    const chatSelectionResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname ===
          `/api/v2/admin/characters/${wizardCharacterId}/draft-image`,
    );
    await selectChat.click();
    const chatSelectionResponse = await chatSelectionResponsePromise;
    expect(
      chatSelectionResponse.ok(),
      await chatSelectionResponse.text(),
    ).toBeTruthy();
    const chatSelectionPayload = (await chatSelectionResponse.json()) as {
      data: { selectedAssetId: string };
    };
    const chatLineage = await selectedAssetLineage({
      runId: chatRunId,
      assetId: chatSelectionPayload.data.selectedAssetId,
      purpose: "character_chat",
    });

    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Real user-surface renderer",
      }),
    ).toBeVisible();
    await expect(
      page.getByTitle("Draft Preview real frontend renderer"),
    ).toBeVisible();
    const releaseProject = await prisma.characterProject.findFirstOrThrow({
      where: { characterId: wizardCharacterId },
    });

    await openCharacterTab(page, "release");
    await page.getByRole("button", { name: "Publish Character" }).click();
    const proposedRelease = await expect
      .poll(async () =>
        prisma.characterRelease.findFirst({
          where: { projectId: releaseProject.id, status: "approved" },
          orderBy: { createdAt: "desc" },
        }),
      )
      .not.toBeNull()
      .then(async () =>
        prisma.characterRelease.findFirstOrThrow({
          where: { projectId: releaseProject.id, status: "approved" },
          orderBy: { createdAt: "desc" },
        }),
      );
    await expect
      .poll(async () =>
        prisma.characterRelease.findUnique({
          where: { id: proposedRelease.id },
          select: { readiness: true },
        }),
      )
      .toEqual({ readiness: "ready" });
    const publishCommand = await expect
      .poll(async () =>
        prisma.controlPlaneCommand.findFirst({
          where: {
            commandType: "character.release.publish",
            targetId: proposedRelease.id,
          },
          orderBy: { createdAt: "desc" },
        }),
      )
      .not.toBeNull()
      .then(async () =>
        prisma.controlPlaneCommand.findFirstOrThrow({
          where: {
            commandType: "character.release.publish",
            targetId: proposedRelease.id,
          },
          orderBy: { createdAt: "desc" },
        }),
      );
    await expect(
      drainTargetAdminCommand(prisma, {
        commandId: publishCommand.id,
        workerId: `playwright-wizard-release-${suffix}`,
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({
      examined: 1,
      succeeded: 1,
      failed: 0,
    });
    await expect
      .poll(async () =>
        prisma.characterServing.findUnique({
          where: { characterId: wizardCharacterId! },
          select: { currentReleaseId: true, state: true },
        }),
      )
      .toEqual({ currentReleaseId: proposedRelease.id, state: "live" });

    await page.reload();
    await openCharacterTab(page, "monitor");
    await page.getByRole("button", { name: "Refresh 24h" }).click();
    await expect
      .poll(async () =>
        prisma.releaseMonitor.findUnique({
          where: {
            releaseId_window: {
              releaseId: proposedRelease.id,
              window: "24h",
            },
          },
          select: { status: true, observed: true, verification: true },
        }),
      )
      .toMatchObject({
        status: "monitoring",
        observed: {
          operationalChecks: {
            releaseAssetManifestComplete: true,
            releaseAvatarRenderable: true,
            releaseAvatarVisible: true,
            releaseHeroRenderable: true,
            releaseHeroVisible: true,
            releaseChatRenderable: true,
            releaseChatVisible: true,
            chatAuthorityReady: true,
          },
        },
        verification: {
          operationalPassed: true,
          recommendation: "continue_monitoring",
        },
      });

    const finalProject = await prisma.characterProject.findFirstOrThrow({
      where: { characterId: wizardCharacterId },
    });
    const finalRelease = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: proposedRelease.id },
    });
    const finalCharacter = await prisma.character.findUniqueOrThrow({
      where: { id: wizardCharacterId },
    });
    const draftAssetPack = finalProject.draftAssetPack as Record<
      string,
      {
        assetId: string;
        runId: string;
        itemId: string;
        generationJobId: string;
        bootstrapIdentity?: boolean;
      }
    >;
    expect(draftAssetPack).toMatchObject({
      character_cover: {
        assetId: coverLineage.assetId,
        runId: coverLineage.runId,
        itemId: coverLineage.itemId,
        generationJobId: coverLineage.generationJobId,
        bootstrapIdentity: true,
      },
      character_hero: {
        assetId: heroLineage.assetId,
        runId: heroLineage.runId,
        itemId: heroLineage.itemId,
        generationJobId: heroLineage.generationJobId,
      },
      character_chat: {
        assetId: chatLineage.assetId,
        runId: chatLineage.runId,
        itemId: chatLineage.itemId,
        generationJobId: chatLineage.generationJobId,
      },
    });
    expect(finalRelease).toMatchObject({
      status: "published",
      readiness: "ready",
      visualProfileId: profile.id,
      visualProfileVersion: profile.version,
      referenceSetRevisionId: referenceSet.id,
    });
    const releaseManifest = parseCharacterReleaseAssetManifest(
      finalRelease.releasePlacementManifest,
    );
    if (!releaseManifest)
      throw new Error("Published Release manifest is not strict v2");
    expect(
      characterReleaseAssetPlacement(releaseManifest, "character_avatar"),
    ).toMatchObject({
      slotKey: "character_avatar",
      assetId: coverLineage.assetId,
      runId: coverLineage.runId,
      itemId: coverLineage.itemId,
      generationJobId: coverLineage.generationJobId,
      bootstrapIdentity: true,
    });
    expect(
      characterReleaseAssetPlacement(releaseManifest, "character_hero"),
    ).toMatchObject({
      slotKey: "character_hero",
      assetId: heroLineage.assetId,
      runId: heroLineage.runId,
      itemId: heroLineage.itemId,
      generationJobId: heroLineage.generationJobId,
    });
    expect(
      characterReleaseAssetPlacement(releaseManifest, "character_chat"),
    ).toMatchObject({
      slotKey: "character_chat",
      assetId: chatLineage.assetId,
      runId: chatLineage.runId,
      itemId: chatLineage.itemId,
      generationJobId: chatLineage.generationJobId,
    });
    expect(finalRelease.generationProvenance).toMatchObject({
      schemaVersion: "character-release-generation-provenance-v2",
    });
    const provenancePlacements = Array.isArray(
      (finalRelease.generationProvenance as Record<string, unknown>).placements,
    )
      ? (
          finalRelease.generationProvenance as {
            placements: Array<Record<string, unknown>>;
          }
        ).placements
      : [];
    const provenanceBySlot = new Map(
      provenancePlacements.map((placement) => [placement.slotKey, placement]),
    );
    for (const [slotKey, lineage] of [
      ["character_avatar", coverLineage],
      ["character_hero", heroLineage],
      ["character_chat", chatLineage],
    ] as const) {
      expect(provenanceBySlot.get(slotKey)).toMatchObject({
        slotKey,
        assetId: lineage.assetId,
        runId: lineage.runId,
        itemId: lineage.itemId,
        reviewDecisionId: null,
        generationJobId: lineage.generationJobId,
        attemptId: lineage.attemptId,
        attemptNo: lineage.attemptNo,
        provider: lineage.provider,
        generationProfileKey: lineage.profileKey,
        generationProfileVersion: lineage.profileVersion,
        workflowKey: lineage.workflowKey,
        workflowVersion: lineage.workflowVersion,
      });
      expect(characterReleaseAssetPlacement(releaseManifest, slotKey))
        .not.toHaveProperty("reviewDecisionId");
    }
    for (const entry of Object.values(draftAssetPack)) {
      expect(entry).not.toHaveProperty("reviewDecisionId");
    }
    await expect(
      prisma.mediaAsset.findMany({
        where: {
          id: {
            in: [
              coverLineage.assetId,
              heroLineage.assetId,
              chatLineage.assetId,
            ],
          },
        },
        select: { id: true, visibility: true },
        orderBy: { id: "asc" },
      }),
    ).resolves.toEqual(
      [coverLineage.assetId, heroLineage.assetId, chatLineage.assetId]
        .sort()
        .map((id) => ({ id, visibility: "public_pack" })),
    );
    expect(finalRelease.snapshotHash).toBe(
      characterReleaseSnapshotHash({
        projectId: finalRelease.projectId,
        revisionId: finalRelease.revisionId,
        characterContentVersionId: finalRelease.characterContentVersionId,
        visualProfileId: finalRelease.visualProfileId,
        visualProfileVersion: finalRelease.visualProfileVersion,
        referenceSetRevisionId: finalRelease.referenceSetRevisionId,
        generationProvenance: finalRelease.generationProvenance,
        releasePlacementManifest: finalRelease.releasePlacementManifest,
      }),
    );
    expect(finalCharacter).toMatchObject({
      name: characterName,
      status: "approved",
      visibility: "public",
      imageAssetId: draftAssetPack.character_cover.assetId,
    });
    const ageGate = await page.request.post(
      `${mainBaseURL()}/api/v1/age-gate/accept`,
      { data: { sourcePath: `/characters/${wizardCharacterId}` } },
    );
    expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
    const detailResponse = await page.request.get(
      `${mainBaseURL()}/api/v1/characters/${wizardCharacterId}`,
    );
    expect(detailResponse.ok(), await detailResponse.text()).toBeTruthy();
    const detailPayload = (await detailResponse.json()) as {
      data: {
        character: {
          currentReleaseId: string | null;
          imageAssetId: string | null;
          heroImageAssetId: string | null;
          heroImage: string;
        };
      };
    };
    expect(detailPayload.data.character).toMatchObject({
      currentReleaseId: proposedRelease.id,
      imageAssetId: coverLineage.assetId,
      heroImageAssetId: heroLineage.assetId,
    });
    const heroContent = await page.request.get(
      new URL(detailPayload.data.character.heroImage, mainBaseURL()).toString(),
    );
    expect(heroContent.ok(), await heroContent.text()).toBeTruthy();
    await page.goto(`${mainBaseURL()}/characters/${wizardCharacterId}`);
    const publicHero = page.getByTestId("character-detail-hero-image");
    await expect(publicHero).toHaveAttribute(
      "data-asset-id",
      heroLineage.assetId,
    );
    await expect
      .poll(() =>
        publicHero.evaluate((image: HTMLImageElement) => ({
          complete: image.complete,
          naturalWidth: image.naturalWidth,
        })),
      )
      .toEqual({ complete: true, naturalWidth: expect.any(Number) });
    expect(
      await publicHero.evaluate(
        (image: HTMLImageElement) => image.naturalWidth,
      ),
    ).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(publicHero).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("validates, publishes, monitors, and rolls back an immutable Character Release", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto(
      `${adminBaseURL()}/admin/characters/${releaseCharacterId}?tab=preview`,
    );
    await expect(
      page.getByRole("heading", { level: 2, name: releaseCharacterName }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "Launch preview is waiting for the image pack",
      }),
    ).toBeVisible();
    // This fixture intentionally represents a pre-Asset-Studio, avatar-only
    // Release. Preview must fail closed instead of reusing one image across
    // hero and chat; the complete three-image renderer is exercised above by
    // the real Character Asset Studio journey.
    await expect(page.getByTitle("Live real frontend renderer")).toHaveCount(0);
    await expect(page.getByTitle("Draft Preview real frontend renderer")).toHaveCount(0);
    await expect(page.getByText("2 image slots missing", { exact: true })).toBeVisible();
    await expect(page.getByText("3 image slots missing", { exact: true })).toBeVisible();
    const lifecycle = await seedStrictCharacterCandidate(candidateReleaseId);
    const lifecycleCharacterId = lifecycle.characterId;
    const lifecycleOldReleaseId = lifecycle.source.id;
    const lifecycleManifest = parseCharacterReleaseAssetManifest(
      lifecycle.source.releasePlacementManifest,
    );
    if (!lifecycleManifest) {
      throw new Error(
        "The lifecycle candidate source must carry a strict three-image manifest.",
      );
    }
    const lifecycleAvatarAssetId = characterReleaseAssetPlacement(
      lifecycleManifest,
      "character_avatar",
    )?.assetId;
    const lifecycleProvenance = lifecycle.source.generationProvenance as Record<
      string,
      unknown
    >;
    const lifecycleRequiredRoute =
      lifecycleProvenance.requiredReleaseRoute as Record<string, unknown>;
    const lifecycleRouteFingerprint = lifecycleRequiredRoute?.routeFingerprint;
    if (
      !lifecycleAvatarAssetId ||
      typeof lifecycleRouteFingerprint !== "string"
    ) {
      throw new Error(
        "The lifecycle candidate source is missing exact asset or route evidence.",
      );
    }

    await page.goto(
      `${adminBaseURL()}/admin/characters/${lifecycleCharacterId}?tab=release`,
    );
    await expect(
      page.getByRole("heading", { level: 2, name: characterName }),
    ).toBeVisible();
    const candidateCard = page
      .locator("article")
      .filter({ hasText: candidateReleaseId });
    await expect(candidateCard).toContainText("ready");
    await candidateCard
      .getByText("Technical evidence", { exact: true })
      .click();
    await expect(candidateCard).toContainText(candidateReleaseId);
    // Publishing runs the server validation before accepting the command.
    await expect(
      page.getByRole("button", { name: "Publish Character" }),
    ).toBeEnabled();

    const publishPath = `/api/v2/admin/characters/${lifecycleCharacterId}/releases/${candidateReleaseId}/commands/publish`;
    const pendingCommandKey =
      pendingCharacterCommandStorageKey(lifecycleCharacterId);
    const publishIdempotencyKeys: string[] = [];
    let publishInterceptions = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === publishPath
      ) {
        const key = request.headers()["idempotency-key"];
        if (key) publishIdempotencyKeys.push(key);
      }
    });
    const publishRoute = async (route: import("@playwright/test").Route) => {
      publishInterceptions += 1;
      if (publishInterceptions === 1) {
        const response = await route.fetch();
        expect(response.ok(), await response.text()).toBeTruthy();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{",
        });
        return;
      }
      if (publishInterceptions === 2) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: {
              code: "forbidden",
              message: "Session changed while replaying the unknown command.",
            },
          }),
        });
        return;
      }
      await route.continue();
    };
    await page.route(`**${publishPath}`, publishRoute);
    await page.getByRole("button", { name: "Publish Character" }).click();
    await expect.poll(() => publishInterceptions).toBeGreaterThanOrEqual(2);
    await expect(
      page.getByText(
        /acceptance cannot be proven with the current session or permissions.*Character writes remain locked/,
      ),
    ).toBeVisible();
    await expect
      .poll(
        () =>
          failures.filter((failure) =>
            failure.includes("status of 403 (Forbidden)"),
          ).length,
      )
      .toBe(1);
    const injectedForbiddenConsoleError = failures.findIndex((failure) =>
      failure.includes("status of 403 (Forbidden)"),
    );
    expect(injectedForbiddenConsoleError).toBeGreaterThanOrEqual(0);
    failures.splice(injectedForbiddenConsoleError, 1);
    await expect(page.getByRole("button", { name: "Character settings", exact: true })).toBeDisabled();
    await expect
      .poll(async () =>
        page.evaluate((storageKey) => {
          const raw = window.localStorage.getItem(storageKey);
          if (!raw) return "missing";
          const parsed = JSON.parse(raw) as { commandId?: string | null };
          return parsed.commandId ?? "unknown";
        }, pendingCommandKey),
      )
      .toBe("unknown");
    await expect(
      prisma.controlPlaneCommand.count({
        where: {
          commandType: "character.release.publish",
          targetId: candidateReleaseId,
        },
      }),
    ).resolves.toBe(1);
    await expect
      .poll(async () =>
        page.evaluate((storageKey) => {
          const raw = window.localStorage.getItem(storageKey);
          if (!raw) return null;
          const parsed = JSON.parse(raw) as { commandId?: string | null };
          return parsed.commandId ?? null;
        }, pendingCommandKey),
      )
      .not.toBeNull();
    await page.unroute(`**${publishPath}`, publishRoute);
    await expect
      .poll(() => publishIdempotencyKeys.length)
      .toBeGreaterThanOrEqual(3);
    expect(new Set(publishIdempotencyKeys).size).toBe(1);
    await expect
      .poll(async () =>
        prisma.controlPlaneCommand.findFirst({
          where: {
            commandType: "character.release.publish",
            targetId: candidateReleaseId,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, status: true },
        }),
      )
      .not.toBeNull();
    const publishCommand = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: {
        commandType: "character.release.publish",
        targetId: candidateReleaseId,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await expect(
      prisma.controlPlaneCommand.count({
        where: {
          commandType: "character.release.publish",
          targetId: candidateReleaseId,
        },
      }),
    ).resolves.toBe(1);
    await page.evaluate((storageKey) => {
      window.localStorage.removeItem(storageKey);
      window.sessionStorage.removeItem(storageKey);
    }, pendingCommandKey);
    await page.reload();
    await expect(
      page.getByText(
        "release publish command is pending. Character writes stay locked until the worker records a terminal result and the workspace refreshes.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Character settings", exact: true })).toBeDisabled();
    await expect(page.getByRole("tab", { name: "Release", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await executeCharacterReleaseCommand(prisma, {
      commandId: publishCommand.id,
      workerId: `playwright-release-publish-${suffix}`,
    });
    await expect
      .poll(async () =>
        prisma.characterServing.findUnique({
          where: { characterId: lifecycleCharacterId },
          select: { currentReleaseId: true, state: true },
        }),
      )
      .toEqual({ currentReleaseId: candidateReleaseId, state: "live" });
    await prisma.releaseMonitor.upsert({
      where: {
        releaseId_window: {
          releaseId: candidateReleaseId,
          window: "route_qualification",
        },
      },
      create: {
        id: `e2e-v2-release-route-monitor-${suffix}`,
        releaseId: candidateReleaseId,
        window: "route_qualification",
        status: "action_required",
        baseline: { policyVersion: CHARACTER_RELEASE_POLICY_VERSION },
        observed: {
          routeFingerprint: lifecycleRouteFingerprint,
          qualification: "expired",
        },
        verification: { recommendation: "refresh_route_qualification" },
        finishedAt: new Date(),
      },
      update: {
        status: "action_required",
        baseline: { policyVersion: CHARACTER_RELEASE_POLICY_VERSION },
        observed: {
          routeFingerprint: lifecycleRouteFingerprint,
          qualification: "expired",
        },
        verification: { recommendation: "refresh_route_qualification" },
        finishedAt: new Date(),
      },
    });
    await page.reload();
    await openCharacterTab(page, "release");
    await expect(
      page.locator("article").filter({ hasText: candidateReleaseId }),
    ).toContainText("serving now");

    await openCharacterTab(page, "monitor");
    const refresh24h = page.getByRole("button", { name: "Refresh 24h" });
    await refresh24h.click();
    await expect
      .poll(async () =>
        prisma.releaseMonitor.findUnique({
          where: {
            releaseId_window: { releaseId: candidateReleaseId, window: "24h" },
          },
          select: { status: true },
        }),
      )
      .not.toBeNull();
    await expect(
      page.getByRole("heading", { level: 3, name: "24h guardrail" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 3, name: "72h guardrail" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: "route qualification guardrail",
      }),
    ).toBeVisible();
    const routeGuardrail = page.locator("article").filter({
      has: page.getByRole("heading", {
        level: 3,
        name: "route qualification guardrail",
      }),
    });
    await expect(routeGuardrail).toContainText(lifecycleRouteFingerprint);
    await expect(routeGuardrail).toContainText("expired");
    await expect(routeGuardrail).toContainText(
      "Recommendation: refresh_route_qualification",
    );
    await expect(refresh24h).toBeEnabled();
    await routeGuardrail
      .getByRole("button", {
        name: "Open image route",
      })
      .click();
    await page.getByText("Official identity and production settings", { exact: true }).click();
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: "Visual Identity authority",
      }),
    ).toBeVisible();
    await openCharacterTab(page, "release");
    await page.getByText("Character availability and rollback", { exact: true }).click();
    await page.getByLabel("I confirm this release action").check();
    await page.getByRole("button", { name: "Roll back" }).click();
    await expect
      .poll(async () =>
        prisma.controlPlaneCommand.findFirst({
          where: {
            commandType: "character.release.rollback",
            targetId: lifecycleCharacterId,
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        }),
      )
      .not.toBeNull();
    const rollbackCommand = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: {
        commandType: "character.release.rollback",
        targetId: lifecycleCharacterId,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await executeCharacterReleaseCommand(prisma, {
      commandId: rollbackCommand.id,
      workerId: `playwright-release-rollback-${suffix}`,
    });
    await expect
      .poll(async () =>
        prisma.characterServing.findUnique({
          where: { characterId: lifecycleCharacterId },
          select: { currentReleaseId: true },
        }),
      )
      .toMatchObject({ currentReleaseId: expect.stringMatching(/^rollback:/) });
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId: lifecycleCharacterId },
      select: { currentReleaseId: true },
    });
    const rollbackRelease = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: serving.currentReleaseId! },
    });
    const oldRelease = await prisma.characterRelease.findUniqueOrThrow({
      where: { id: lifecycleOldReleaseId },
    });
    expect(rollbackRelease).toMatchObject({
      rollbackOfReleaseId: lifecycleOldReleaseId,
      status: "published",
    });
    expect(rollbackRelease.snapshotHash).toBe(oldRelease.snapshotHash);
    await page.reload();
    await openCharacterTab(page, "release");
    await expect(
      page.locator("article").filter({ hasText: rollbackRelease.id }),
    ).toContainText("serving now");
    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("closes Creative, Incident, and Case loops through UI and authoritative facts", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1366, height: 900 });

    const dynamicTitle = `E2E existing campaign placement ${suffix}`;
    const dynamicBrief =
      "One cinematic editorial campaign image with a clear subject, quiet confidence, warm practical lighting, and generous negative space for launch copy.";
    const createResponse = await page.request.post(
      `${adminBaseURL()}/api/v2/admin/creative/runs`,
      {
        headers: {
          "idempotency-key": `e2e-existing-campaign-${suffix}`,
        },
        data: {
          title: dynamicTitle,
          purpose: "campaign",
          targetType: "none",
          profileId: wizardBootstrapProfileKey,
          presetIds: [],
          orientation: "16:9",
          count: 1,
          brief: dynamicBrief,
          consistencyMode: "balanced",
          priority: "normal",
          reason: "Seed an existing reviewed-campaign fixture outside the removed Admin creation UI",
        },
      },
    );
    const createRaw = await createResponse.text();
    expect(createResponse.status(), createRaw).toBe(202);
    const createPayload = JSON.parse(createRaw) as {
      ok: true;
      data: { batch: { id: string } };
    };
    const dynamicCreativeRunId = createPayload.data.batch.id;
    wizardRunIds.push(dynamicCreativeRunId);

    await page.goto(
      `${adminBaseURL()}/admin/creative/runs/${dynamicCreativeRunId}`,
    );
    await expect(page).toHaveURL(
      new RegExp(`/admin/creative/runs/${dynamicCreativeRunId}$`),
    );
    await expect(
      page.getByRole("heading", { level: 2, name: dynamicTitle }),
    ).toBeVisible();
    await expect(
      prisma.contentProductionBatch.findUniqueOrThrow({
        where: { id: dynamicCreativeRunId },
      }),
    ).resolves.toMatchObject({
      purpose: "campaign",
      targetType: "none",
      targetId: null,
      profileId: wizardBootstrapProfileKey,
      orientation: "16:9",
      brief: dynamicBrief,
      count: 1,
    });

    await drainCreativeRun(page, dynamicCreativeRunId, 1);
    await expect(page.getByAltText("Creative item 1")).toBeVisible({
      timeout: 10_000,
    });
    const reviewContext = page.getByRole("region", {
      name: "Generation brief",
    });
    await expect(reviewContext).toContainText(dynamicBrief);
    await expect(reviewContext).toContainText("campaign");
    await expect(reviewContext).toContainText("16:9");
    await expect(reviewContext).toContainText(
      "E2E pipeline identity bootstrap · v1",
    );
    await expect(reviewContext).toContainText(/Reference images\s*0/);
    const dynamicItem = await prisma.contentProductionItem.findFirstOrThrow({
      where: { batchId: dynamicCreativeRunId },
      include: { job: true, mediaAsset: true },
    });
    expect(dynamicItem).toMatchObject({
      status: "generated",
      job: {
        provider: "pipeline",
        profileId: wizardBootstrapProfileKey,
        orientation: "16:9",
        status: "completed",
      },
      mediaAsset: {
        safetyStatus: "passed",
      },
    });
    const beforePlacement = await prisma.contentProductionBatch.findUniqueOrThrow({
      where: { id: dynamicCreativeRunId },
      select: { version: true },
    });
    const dynamicStagingReason =
      "Stage this selected candidate for authoritative campaign verification.";
    const dynamicStagedWithdrawalReason =
      "Withdraw the staged campaign candidate because the launch direction was retired before activation.";
    const dynamicCampaignEyebrow = "E2E operator feature";
    const dynamicCampaignTitle = `Selected campaign ${suffix}`;
    await completeGenericCreativePlacement(page, {
      targetId: `campaign-${suffix}`,
      eyebrow: dynamicCampaignEyebrow,
      title: dynamicCampaignTitle,
      reason: dynamicStagingReason,
    });
    const dynamicStagedPlacement =
      await prisma.mediaAssetPlacement.findFirstOrThrow({
        where: {
          mediaAssetId: dynamicItem.mediaAssetId!,
          status: "scheduled",
          verificationState: "verifying",
          metadata: {
            path: ["creativeRunId"],
            equals: dynamicCreativeRunId,
          },
        },
      });
    expect(dynamicStagedPlacement.metadata).toMatchObject({
      eyebrow: dynamicCampaignEyebrow,
      title: dynamicCampaignTitle,
    });
    await page
      .getByLabel("Withdrawal reason", { exact: true })
      .fill(dynamicStagedWithdrawalReason);
    await page
      .getByRole("button", { name: "Withdraw staged placement" })
      .click();
    await expect(
      page.getByRole("button", { name: "Stage campaign candidate" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Staging reason", { exact: true }),
    ).toHaveValue("");
    await expect(
      page.getByRole("heading", { level: 4, name: "Terminal disposition" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { level: 2, name: dynamicTitle }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stage campaign candidate" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Staging reason", { exact: true }),
    ).toHaveValue("");

    await expect
      .poll(async () =>
        prisma.contentProductionBatch.findUnique({
          where: { id: dynamicCreativeRunId },
          select: {
            lifecycleState: true,
            workflowStage: true,
            verificationState: true,
            version: true,
          },
        }),
      )
      .toEqual({
        lifecycleState: "active",
        workflowStage: "placement",
        verificationState: "pending",
        version: beforePlacement.version + 2,
      });
    await expect
      .poll(async () =>
        prisma.creativeReviewDecision.count({
          where: { runItemId: dynamicItem.id },
        }),
      )
      .toBe(0);
    await expect
      .poll(async () =>
        prisma.mediaAssetPlacement.findUnique({
          where: { id: dynamicStagedPlacement.id },
          select: {
            status: true,
            verificationState: true,
            verificationEvidence: true,
            version: true,
          },
        }),
      )
      .toEqual({
        status: "archived",
        verificationState: "overridden",
        verificationEvidence: {
          disposition: "operator_withdrawn",
          reason: dynamicStagedWithdrawalReason,
          withdrawnAt: expect.any(String),
          rollbackPlacementId: null,
        },
        version: 2,
      });
    await expect(
      prisma.adminAuditLog.findFirstOrThrow({
        where: {
          action: "creative.placement.staged",
          targetId: dynamicStagedPlacement.id,
        },
        orderBy: { createdAt: "desc" },
        select: { reason: true },
      }),
    ).resolves.toEqual({ reason: dynamicStagingReason });
    await expect(
      prisma.adminAuditLog.findFirstOrThrow({
        where: {
          action: "creative.placement.withdrawn",
          targetId: dynamicStagedPlacement.id,
        },
        orderBy: { createdAt: "desc" },
        select: { reason: true },
      }),
    ).resolves.toEqual({ reason: dynamicStagedWithdrawalReason });
    await expect(
      prisma.mainOutboxEvent.count({
        where: {
          aggregateId: dynamicCreativeRunId,
          eventType: "creative.placement.withdrawn.v2",
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.mediaAssetPlacement.count({
        where: {
          mediaAssetId: dynamicItem.mediaAssetId!,
          status: "published",
          metadata: {
            path: ["creativeRunId"],
            equals: dynamicCreativeRunId,
          },
        },
      }),
    ).resolves.toBe(0);

    // A withdrawn staging remains available to select again. Daily campaign
    // publication closes only after the actual runtime verifies the new placement.
    await completeGenericCreativePlacement(page, {
      targetId: `campaign-${suffix}`,
      eyebrow: dynamicCampaignEyebrow,
      title: dynamicCampaignTitle,
      reason: "Stage the same image again after confirming the campaign direction.",
    });
    const restagedPlacement = await prisma.mediaAssetPlacement.findFirstOrThrow({
      where: {
        mediaAssetId: dynamicItem.mediaAssetId!,
        status: "scheduled",
        verificationState: "verifying",
        metadata: { path: ["creativeRunId"], equals: dynamicCreativeRunId },
      },
    });
    expect(restagedPlacement.id).not.toBe(dynamicStagedPlacement.id);
    await page.getByRole("button", { name: "Verify & activate" }).click();
    await expect(page.getByText("campaign · passed")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Withdraw approval" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Stage campaign candidate" }),
    ).toHaveCount(0);
    await expect
      .poll(async () =>
        prisma.contentProductionBatch.findUnique({
          where: { id: dynamicCreativeRunId },
          select: {
            lifecycleState: true,
            status: true,
            workflowStage: true,
            verificationState: true,
            version: true,
          },
        }),
      )
      .toEqual({
        lifecycleState: "closed",
        status: "completed",
        workflowStage: "verification",
        verificationState: "passed",
        version: beforePlacement.version + 4,
      });
    await expect(
      prisma.contentProductionItem.findUniqueOrThrow({
        where: { id: dynamicItem.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "published" });
    await expect(prisma.creativeReviewDecision.count({
      where: { runItemId: dynamicItem.id },
    })).resolves.toBe(0);
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: restagedPlacement.id },
      select: { status: true, verificationState: true },
    })).resolves.toEqual({ status: "published", verificationState: "passed" });
    await expect(prisma.mediaAssetPlacement.findUniqueOrThrow({
      where: { id: dynamicStagedPlacement.id },
      select: { status: true, verificationState: true },
    })).resolves.toEqual({ status: "archived", verificationState: "overridden" });
    await expect(prisma.adminAuditLog.count({
      where: {
        targetId: restagedPlacement.id,
        action: "creative.placement.verified",
      },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: {
        aggregateId: dynamicCreativeRunId,
        eventType: "creative.placement.verified.v2",
      },
    })).resolves.toBe(1);

    await page.goto(
      `${adminBaseURL()}/admin/ops/incidents?search=${encodeURIComponent(suffix)}`,
    );
    await expect(
      page.getByRole("heading", { level: 2, name: "Incidents" }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: new RegExp(`E2E provider regression ${suffix}`),
      })
      .click();
    await expect(page).toHaveURL(new RegExp(`incident=${incidentId}`));
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: `E2E provider regression ${suffix}`,
      }),
    ).toBeVisible();
    await page
      .getByLabel("Audit reason", { exact: true })
      .fill("Recovery window and settlement reviewed");
    await page
      .getByLabel(
        "Supplemental evidence reference (optional for authority check)",
      )
      .fill(`monitor://e2e/${suffix}`);
    await page
      .getByRole("button", { name: "Run authority verification" })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Authority recovery verification evaluated" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Resolve incident" }).click();
    await expect(
      page.getByRole("heading", { level: 4, name: "Postmortem and close" }),
    ).toBeVisible();
    await page
      .getByLabel("Summary", { exact: true })
      .fill(
        "Provider route recovered and all affected requests were reconciled.",
      );
    await page.getByLabel("Root cause").fill("Provider route regression");
    await page
      .getByLabel("Contributing factors (one per line)")
      .fill("Capacity signal lag");
    await page
      .getByLabel("Corrective actions (one per line)")
      .fill("Add a route-level recovery canary");
    await page
      .getByLabel("Type close confirmation")
      .fill(`${incidentId}:close`);
    await page.getByLabel("Close audit reason").fill("Verified recovery and recorded the postmortem");
    await page
      .getByRole("button", { name: "Record postmortem and close" })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Postmortem recorded and Incident closed" }),
    ).toBeVisible();

    await expect
      .poll(async () =>
        prisma.opsIncident.findUnique({
          where: { id: incidentId },
          select: {
            status: true,
            verificationState: true,
            activeCorrelationKey: true,
          },
        }),
      )
      .toEqual({
        status: "closed",
        verificationState: "passed",
        activeCorrelationKey: null,
      });
    await expect
      .poll(async () =>
        prisma.incidentPostmortem.count({
          where: { incidentId, rootCause: "Provider route regression" },
        }),
      )
      .toBe(1);

    await page.goto(
      `${adminBaseURL()}/admin/cases?view=mine&search=${encodeURIComponent(caseTargetId)}`,
    );
    await expect(
      page.getByRole("heading", { level: 2, name: "Cases" }),
    ).toBeVisible();
    await page.getByRole("button", { name: new RegExp(caseTargetId) }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/cases/${caseId}\\?`));
    await expect(
      page.getByRole("heading", { level: 4, name: "Evidence" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Evidence", exact: true }).getByText(
        "Customer supplied immutable reproduction evidence.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByLabel("Owner ID").fill(actorId);
    await page.getByLabel("Audit reason", { exact: true }).fill("Assign the verified incident follow-up");
    await page.getByRole("button", { name: "Save assignment" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Case assignment saved" })).toBeVisible();
    await expect.poll(() => prisma.adminCase.findUnique({
      where: { id: caseId }, select: { ownerId: true, version: true },
    })).toEqual({ ownerId: actorId, version: 2 });
    const caseDecision = page.locator(
      'section[aria-labelledby="case-decision-title"]',
    );
    await caseDecision.locator("select").selectOption("incident_escalated");
    await page.getByLabel("Outcome reference").fill(`incident:${incidentId}`);
    await page
      .getByLabel("Resolution summary")
      .fill(
        "Escalated the customer impact to the recovered Incident and verified its authority state.",
      );
    await page.getByRole("button", { name: "Record action" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Customer Case action recorded" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Verify from authority" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Downstream outcome verified" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close case", exact: true }).click();
    const closeDialog = page.getByRole("dialog", { name: "Close case" });
    await closeDialog.getByLabel("Reason (≥3)").fill("Authority outcome verified for closure");
    await closeDialog.getByLabel("Type confirmation").fill(`${caseId}:close`);
    await closeDialog.getByRole("button", { name: "Close case", exact: true }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Case close command accepted" }),
    ).toBeVisible();

    await expect
      .poll(async () =>
        prisma.adminCase.findUnique({
          where: { id: caseId },
          select: { status: true, verificationState: true, activeKey: true },
        }),
      )
      .toEqual({
        status: "closed",
        verificationState: "passed",
        activeKey: null,
      });
    await expect
      .poll(async () =>
        prisma.decisionRecord.count({
          where: { sourceId: caseId, decision: "incident_escalated" },
        }),
      )
      .toBe(1);
    await expect
      .poll(async () =>
        prisma.adminAuditLog.count({
          where: { targetId: { in: [
            dynamicItem.id,
            dynamicStagedPlacement.id,
            restagedPlacement.id,
            incidentId,
            caseId,
          ] } },
        }),
      )
      .toBeGreaterThanOrEqual(8);

    await expectNoHorizontalOverflow(page);
    expect(failures).toEqual([]);
  });

  test("projects verified domain outcomes into Today recently resolved with working deep links", async ({
    page,
  }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${adminBaseURL()}/admin/today`);
    await expect(page.getByTestId("today-view")).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Queue health" }),
    ).toContainText("Fresh as of");
    const todayNavigation = page.getByRole("navigation", { name: "Today view", exact: true });
    await todayNavigation.getByText("Row density", { exact: true }).click();
    const comfortableDensity = todayNavigation.getByRole("button", { name: "Comfortable", exact: true });
    await comfortableDensity.click();
    await expect(comfortableDensity).toHaveAttribute("aria-pressed", "true");
    const recentlyResolved = todayNavigation.getByRole("button", { name: /^Recently resolved\b/ });
    await recentlyResolved.click();
    await expect(recentlyResolved).toHaveAttribute("aria-current", "page");

    const resolved = page.getByTestId("today-queue-recently-resolved");
    const casePreview = resolved
      .getByRole("button", { name: "Preview support request case", exact: true })
      .filter({ hasText: `user ${caseTargetId} is closed` });
    const incidentPreview = resolved.getByRole("button", {
      name: `Preview Incident: provider:profile:e2e-${suffix}`,
      exact: true,
    });
    await expect(casePreview.getByText(`user ${caseTargetId} is closed`, { exact: true })).toBeVisible();
    await expect(incidentPreview.getByText(`E2E provider regression ${suffix}`, { exact: true })).toBeVisible();
    await casePreview.click();
    await expect(casePreview).toHaveAttribute("aria-pressed", "true");
    const openSourceRecord = resolved
      .getByTestId("today-preview")
      .getByRole("link", { name: "Open source record", exact: true });
    await expect(openSourceRecord).toHaveAttribute("href", `/admin/cases/${caseId}`);
    await openSourceRecord.click();
    await expect(page).toHaveURL(new RegExp(`/admin/cases/${caseId}$`));
    await expect(
      page.getByRole("heading", { level: 4, name: "Evidence" }),
    ).toBeVisible();

    await page.goto(`${adminBaseURL()}/admin/today`);
    await recentlyResolved.click();
    await incidentPreview.click();
    await expect(incidentPreview).toHaveAttribute("aria-pressed", "true");
    await expect(openSourceRecord).toHaveAttribute("href", `/admin/ops/incidents/${incidentId}`);
    await openSourceRecord.click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/ops/incidents/${incidentId}$`),
    );
    await expect(
      page.getByRole("heading", {
        level: 3,
        name: `E2E provider regression ${suffix}`,
      }),
    ).toBeVisible();
    expect(failures).toEqual([]);
  });

  test("opens a Job authority deep link without losing query or selection state", async ({
    page,
  }) => {
    const failures = consoleFailures(page);
    await login(page);
    await page.goto(
      `${adminBaseURL()}/admin/ops/jobs?job=${encodeURIComponent(incidentRequestId)}`,
    );
    await expect(page).toHaveURL(new RegExp(`job=${incidentRequestId}`));
    await expect(page.getByText("Generation Request authority")).toBeVisible();
    await expect(page.getByText("Immutable Attempt events")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page).not.toHaveURL(/(?:\?|&)job=/);
    await expect(page.getByText("Generation Request authority")).toHaveCount(0);
    expect(failures).toEqual([]);
  });

  test("keeps retry errors in an accessible focus-trapped dialog and restores focus", async ({
    page,
  }) => {
    const failures = consoleFailures(page, [
      /server responded with a status of 409 \(Conflict\)/,
    ]);
    await login(page);
    await page.goto(
      `${adminBaseURL()}/admin/ops/jobs?search=${encodeURIComponent(retryRequestId)}&mode=image&sort=created_desc&limit=25`,
    );
    const trigger = page.getByRole("button", { name: "Retry", exact: true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByRole("dialog", {
      name: new RegExp("Retry Generation Request"),
    });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Reason (≥3)")).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page
      .getByLabel("Reason (≥3)")
      .fill("Retry after authority recovery verification");
    await page
      .getByLabel("Type the name to confirm")
      .fill(`${retryRequestId}:retry`);
    await prisma.generationJob.update({
      where: { id: retryRequestId },
      data: { version: { increment: 1 } },
    });
    await page.getByRole("button", { name: "Create retry attempt" }).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "changed before retry",
    );
    await expect(page.getByLabel("Reason (≥3)")).toHaveValue(
      "Retry after authority recovery verification",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(failures).toEqual([]);
  });

  test("meets automated WCAG 2.2 AA gates across the core operator surfaces", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const failures = consoleFailures(page);
    await login(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    const routes = [
      `/admin/characters/${releaseCharacterId}?tab=assets`,
      `/admin/characters/${releaseCharacterId}?tab=release`,
      "/admin/creative/runs",
      `/admin/creative/runs/${creativeRunId}`,
      "/admin/content/assets",
      `/admin/content/assets/${creativeAssetId}`,
      `/admin/ops/incidents/${incidentId}`,
      `/admin/cases/${caseId}`,
      `/admin/ops/jobs?job=${encodeURIComponent(incidentRequestId)}`,
      "/admin/today",
    ];
    for (const route of routes) {
      await page.goto(`${adminBaseURL()}${route}`);
      await expect(page.locator("#admin-main-content")).toBeVisible();
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("a.admin-skip-link")).toHaveAttribute(
        "href",
        "#admin-main-content",
      );
      await expectWcag22AA(page);
    }
    expect(failures).toEqual([]);
  });

  for (const fixture of responsiveCoreFixtures) {
    test(`completes all four authority workflows with keyboard and WCAG gates at ${fixture.viewport.width}px`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await completeResponsiveCoreFlows(page, fixture);
    });
  }
});
