import { expect, test, type Page } from "@playwright/test";
import type { Prisma } from "@prisma/client";
import {
  characterReleaseAssetPlacement,
  parseCharacterReleaseAssetManifest,
} from "@idream/shared/admin";
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
import { jobQueue } from "@/server/jobs/queue";
import { env } from "@/server/lib/env";
import { drainTargetAdminCommand } from "@/processes/admin-command-worker";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

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
const wizardRouteFingerprint = `e2e-v2-wizard-route-${suffix}`;
const wizardBootstrapProfileId = `e2e-v2-bootstrap-profile-${suffix}`;
const wizardBootstrapProfileKey = `000-e2e-v2-bootstrap-pipeline-${suffix}`;
const wizardIdentityProfileId = `e2e-v2-identity-profile-${suffix}`;
const wizardIdentityProfileKey = `e2e-v2-identity-pipeline-${suffix}`;
const wizardVisualStyle = "realistic";
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

const responsiveCoreFixtures: ResponsiveCoreFixture[] = ([
  ["mobile", 375, 812],
  ["tablet", 834, 1_112],
] as const).map(([label, width, height]) => ({
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
  if (process.env.PW_ADMIN_BASE_URL) return process.env.PW_ADMIN_BASE_URL.replace(/\/$/, "");
  const url = new URL(process.env.PW_BASE_URL ?? "http://127.0.0.1:3000");
  url.port = String(Number(url.port || "3000") + 1);
  return url.toString().replace(/\/$/, "");
}

function mainBaseURL() {
  return (process.env.PW_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
}

function internalToken() {
  return process.env.INTERNAL_TOKEN ?? "development-internal-token";
}

function pendingCharacterCommandStorageKey(characterId: string) {
  return `idream:admin:character:${encodeURIComponent(actorId)}:${encodeURIComponent(characterId)}:pending-command`;
}

async function drainCreativeRun(page: Page, runId: string, expectedItemCount: number) {
  await expect.poll(async () => {
    const response = await page.request.post(`${mainBaseURL()}/api/internal/worker`, {
      headers: { authorization: `Bearer ${internalToken()}` },
      timeout: 90_000,
    });
    if (!response.ok()) throw new Error(await response.text());
    return prisma.contentProductionItem.count({
      where: {
        batchId: runId,
        status: "generated",
        mediaAssetId: { not: null },
      },
    });
  }, {
    timeout: 30_000,
    intervals: [100, 250, 500, 1_000],
  }).toBe(expectedItemCount);
  const generatedItems = await prisma.contentProductionItem.findMany({
    where: {
      batchId: runId,
      status: "generated",
      mediaAssetId: { not: null },
    },
    select: { jobId: true, mediaAssetId: true },
  });
  const generatedAssetIds = generatedItems.flatMap((item) =>
    item.mediaAssetId ? [item.mediaAssetId] : []
  );
  const generatedJobIds = generatedItems.flatMap((item) =>
    item.jobId ? [item.jobId] : []
  );
  expect(generatedAssetIds).toHaveLength(expectedItemCount);
  expect(generatedJobIds).toHaveLength(expectedItemCount);
  expect(await prisma.generationJob.count({
    where: {
      id: { in: generatedJobIds },
      provider: "pipeline",
    },
  })).toBe(expectedItemCount);
  expect(await prisma.generationAttempt.count({
    where: {
      requestId: { in: generatedJobIds },
      provider: "pipeline",
      status: "succeeded",
    },
  })).toBe(expectedItemCount);
  const generatedAssets = await prisma.mediaAsset.findMany({
    where: { id: { in: generatedAssetIds } },
    select: { metadata: true },
  });
  expect(generatedAssets).toHaveLength(expectedItemCount);
  expect(generatedAssets.every((asset) => {
    const metadata = asset.metadata as Record<string, unknown>;
    return metadata.provider === "pipeline" && metadata.synthetic === false;
  })).toBe(true);
}

async function generateCharacterAssetRun(
  page: Page,
  buttonName: string,
  expectedItemCount: number,
) {
  const createResponsePromise = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/api/v2/admin/creative/runs"
  );
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(202);
  const createPayload = await createResponse.json() as {
    data: { batch: { id: string } };
  };
  const runId = createPayload.data.batch.id;
  wizardRunIds.push(runId);
  await drainCreativeRun(page, runId, expectedItemCount);
  await page.getByLabel("assets").getByRole("button", {
    name: "Refresh",
    exact: true,
  }).click();
  await expect(page.getByRole("button", { name: /Select candidate/ })).toHaveCount(
    expectedItemCount,
  );
  return runId;
}

type SelectedAssetLineage = {
  assetId: string;
  runId: string;
  itemId: string;
  reviewDecisionId: string;
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
      status: { in: ["approved", "published"] },
    },
    include: { batch: true, job: true },
  });
  expect(item.batch).toMatchObject({
    id: input.runId,
    purpose: input.purpose,
    targetType: "character",
    targetId: wizardCharacterId,
  });
  expect(item.job).not.toBeNull();
  const decision = await prisma.creativeReviewDecision.findFirstOrThrow({
    where: { runItemId: item.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  expect(decision).toMatchObject({
    artifactId: input.assetId,
    decision: "approved",
  });
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
    reviewDecisionId: decision.id,
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

async function approveCurrentCharacterCandidate(
  page: Page,
  score: number,
  reason: string,
) {
  const reviewRegion = page.getByRole("region", {
    name: "Record the visible review evidence",
  });
  await reviewRegion.getByLabel("No visible artifacts").check();
  await reviewRegion.getByLabel("Exactly one intended subject").check();
  await reviewRegion.getByLabel("Composition matches the customer intent").check();
  await reviewRegion.getByLabel("No visible text, watermark, or contact sheet").check();
  await reviewRegion.getByLabel("Score", { exact: true }).fill(String(score));
  await reviewRegion.getByLabel("Evidence and reason").fill(reason);
  await reviewRegion.getByRole("button", { name: "Approve with evidence" }).click();
}

async function completeGenericCreativeReview(
  page: Page,
  input: {
    readonly score: number;
    readonly reason: string;
    readonly keyboard?: boolean;
  },
) {
  await page.getByLabel("Score", { exact: true }).fill(String(input.score));
  await expect(page.getByLabel("Identity consistency")).toHaveValue("unscored");
  await page.getByLabel("Evidence and reason").fill(input.reason);
  const approve = page.getByRole("button", { name: "Approve" });
  await expect(approve).toBeEnabled();
  if (input.keyboard) {
    await approve.focus();
    await expect(approve).toBeFocused();
    await approve.press("Enter");
  } else {
    await approve.click();
  }
  await expect(page.getByText("approved · unscored")).toBeVisible();
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
  await expect(page.getByLabel("Destination", { exact: true })).toHaveValue("Campaign collection");
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
  const response = await page.request.post(`${adminBaseURL()}/api/admin-auth/login`, {
    data: { username: "admin", password: "admin123" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function completeCharacterCreateDraft(
  page: Page,
  name: string,
  assertNotCreated: () => Promise<void>,
) {
  await page.getByLabel("Audience").fill(
    "Adults who want a calm, dependable evening companion",
  );
  await page.getByLabel("Companion need").fill(
    "A recurring ritual for decompressing and feeling understood",
  );
  await page.getByLabel("Hypothesis").fill(
    "A specific, consistent evening ritual increases qualified conversations",
  );
  await page.getByLabel("Differentiation").fill(
    "Observant guidance with a distinct point of view instead of generic affirmation",
  );
  await page.getByRole("button", { name: "Continue to persona" }).click();
  await assertNotCreated();

  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Relationship archetype").fill("Steady confidante");
  await page.getByLabel("Character promise").fill(
    "A warm, precise place to put the day down",
  );
  await page.getByLabel("Personality").fill(
    "Observant, measured, and gently challenging",
  );
  await page.getByLabel("Tone").fill("Warm, concise, and grounded");
  await page.getByLabel("Backstory").fill(
    "Years hosting a late-night radio show taught her to notice what people leave unsaid.",
  );
  await page.getByLabel("First message").fill(
    "You made it. What do you need to put down tonight?",
  );
  await page.getByLabel("Example dialogue (one per line)").fill(
    "Tell me the part you keep replaying.",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await assertNotCreated();

  await page.getByLabel("Identity anchor").fill(
    "Composed late-night radio host with a recognizable adult face",
  );
  await page.getByLabel("Stable traits (one per line)").fill(
    "Dark wavy hair\nWarm brown eyes",
  );
  await page.getByLabel("Reference direction").fill(
    "Low-key tungsten portraiture with an intimate editorial crop",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await assertNotCreated();

  await page.getByLabel("Success criteria (one per line)").fill(
    "Qualified conversations improve without a D7 retention regression",
  );
  await page.getByLabel("Production package").fill(
    "Primary portrait, hero, and chat image baseline",
  );
  await page.getByLabel("QA plan").fill(
    "Mobile and desktop preview plus a five-turn conversation review",
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await assertNotCreated();
}

function consoleFailures(page: Page, expected: RegExp[] = []) {
  const failures: string[] = [];
  page.on("console", (message) => {
    const actionableNextImageWarning =
      message.type() === "warning" &&
      message.text().includes("was detected as the Largest Contentful Paint (LCP)");
    if (
      (message.type() === "error" || actionableNextImageWarning) &&
      !expected.some((pattern) => pattern.test(message.text()))
    ) {
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

function requiredInputJson(value: Prisma.JsonValue, field: string): Prisma.InputJsonValue {
  if (value === null) throw new Error(`${field} fixture must contain JSON evidence`);
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
      impact: { affectedRequests: 2, affectedUsers: 1, failedCostMicros: 900, refundedDreamcoins: 0 },
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
      snapshot: { description: `Customer supplied immutable ${fixture.label} reproduction evidence.` },
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
  await prisma.characterRelease.create({
    data: {
      id: candidateId,
      projectId: source.projectId,
      revisionId: source.revisionId,
      characterContentVersionId: source.characterContentVersionId,
      visualProfileId: source.visualProfileId,
      visualProfileVersion: source.visualProfileVersion,
      referenceSetRevisionId: source.referenceSetRevisionId,
      generationProvenance: requiredInputJson(source.generationProvenance, "generationProvenance"),
      releasePlacementManifest: requiredInputJson(source.releasePlacementManifest, "releasePlacementManifest"),
      snapshotHash: source.snapshotHash,
      readiness: "unknown",
      legacy: false,
      status: "approved",
      supersedesId: serving.currentReleaseId,
    },
  });
  return { characterId, source };
}

async function seedResponsiveCharacterCandidate(fixture: ResponsiveCoreFixture) {
  return seedStrictCharacterCandidate(fixture.candidateReleaseId);
}

async function completeResponsiveCoreFlows(page: Page, fixture: ResponsiveCoreFixture) {
  const failures = consoleFailures(page);
  await login(page);
  await page.setViewportSize(fixture.viewport);
  const lifecycle = await seedResponsiveCharacterCandidate(fixture);
  const lifecycleCharacterId = lifecycle.characterId;

  await page.goto(`${adminBaseURL()}/admin/characters/${lifecycleCharacterId}?tab=assets`);
  await expect(page.getByRole("heading", { level: 2, name: characterName })).toBeVisible();
  const assetsTab = page.getByRole("tab", { name: "assets" });
  await expect(assetsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#asset-pack-title")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  const refreshAssets = page.locator("#character-panel-assets").getByRole("button", {
    name: "Refresh",
    exact: true,
  });
  await refreshAssets.focus();
  await expect(refreshAssets).toBeFocused();

  await page.goto(`${adminBaseURL()}/admin/creative/runs`);
  await expect(page.getByRole("heading", { level: 2, name: "Creative Runs" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Create images" })).toBeVisible();
  const creativeBrief = page.getByLabel("Creative brief");
  await expect(creativeBrief).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  await creativeBrief.focus();
  await expect(creativeBrief).toBeFocused();

  await page.goto(`${adminBaseURL()}/admin/content/assets`);
  await expect(page.getByRole("heading", { name: "Image Library" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);

  await page.goto(`${adminBaseURL()}/admin/content/assets/${fixture.creativeAssetId}`);
  await expect(page.getByRole("heading", { name: fixture.creativeAssetId.slice(0, 8) })).toBeVisible();
  await expect(page.getByText("Authority & usage")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);

  await page.goto(`${adminBaseURL()}/admin/characters/${lifecycleCharacterId}?tab=release`);
  await expect(page.getByRole("heading", { level: 2, name: characterName })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  const releaseTab = page.getByRole("tab", { name: "release" });
  await releaseTab.focus();
  await expect(releaseTab).toBeFocused();
  await releaseTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "monitor" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "monitor" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "monitor" }).press("ArrowLeft");
  await expect(releaseTab).toBeFocused();
  const candidateCard = page.locator("article").filter({ hasText: fixture.candidateReleaseId });
  await expect(candidateCard).toContainText("unknown");
  await page.getByLabel("Exact confirmation").fill(`${lifecycleCharacterId}:${fixture.candidateReleaseId}:validate`);
  const validateRelease = page.getByRole("button", { name: "Validate pinned snapshot" });
  await validateRelease.focus();
  await expect(validateRelease).toBeFocused();
  await validateRelease.press("Enter");
  await expect(candidateCard).toContainText("ready");
  await page.getByLabel("Exact confirmation").fill(`${lifecycleCharacterId}:${fixture.candidateReleaseId}:publish`);
  const publishRelease = page.getByRole("button", { name: "Publish candidate" });
  await publishRelease.focus();
  await expect(publishRelease).toBeFocused();
  await publishRelease.press("Enter");
  await expect.poll(async () => prisma.controlPlaneCommand.findFirst({
    where: { commandType: "character.release.publish", targetId: fixture.candidateReleaseId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  })).not.toBeNull();
  const queuedPublish = await prisma.controlPlaneCommand.findFirstOrThrow({
    where: { commandType: "character.release.publish", targetId: fixture.candidateReleaseId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  await executeCharacterReleaseCommand(prisma, {
    commandId: queuedPublish.id,
    workerId: `playwright-release-${fixture.label}-${suffix}`,
  });
  await expect.poll(async () => prisma.characterServing.findUnique({
    where: { characterId: lifecycleCharacterId },
    select: { currentReleaseId: true, state: true },
  })).toEqual({ currentReleaseId: fixture.candidateReleaseId, state: "live" });
  await page.reload();
  await expect(page.locator("article").filter({ hasText: fixture.candidateReleaseId })).toContainText("serving now");

  await page.goto(`${adminBaseURL()}/admin/creative/runs/${fixture.creativeRunId}`);
  await expect(page.getByRole("heading", { level: 2, name: `E2E ${fixture.label} Creative Run ${suffix}` })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  await completeGenericCreativeReview(page, {
    score: 90,
    reason: `Reviewed the ${fixture.label} campaign image against the intended composition and distribution use.`,
    keyboard: true,
  });
  await completeGenericCreativePlacement(page, {
    targetId: `campaign-${fixture.label}-${suffix}`,
    eyebrow: `E2E ${fixture.label} feature`,
    title: `Reviewed ${fixture.label} campaign ${suffix}`,
    reason: `Stage the reviewed ${fixture.label} candidate for authoritative campaign verification.`,
    keyboard: true,
  });
  const verifyPlacement = page.getByRole("button", { name: "Verify & activate" });
  await verifyPlacement.focus();
  await expect(verifyPlacement).toBeFocused();
  await verifyPlacement.press("Enter");
  await expect(page.getByText("campaign · passed")).toBeVisible();
  await expect.poll(async () => prisma.contentProductionBatch.findUnique({
    where: { id: fixture.creativeRunId },
    select: { workflowStage: true, verificationState: true },
  })).toEqual({ workflowStage: "verification", verificationState: "passed" });
  await expect.poll(async () => prisma.creativeReviewDecision.count({
    where: { runItemId: fixture.creativeItemId, decision: "approved" },
  })).toBe(1);
  await expect.poll(async () => prisma.mediaAssetPlacement.count({
    where: { mediaAssetId: fixture.creativeAssetId, status: "published", verificationState: "passed" },
  })).toBe(1);

  await page.goto(`${adminBaseURL()}/admin/ops/incidents/${fixture.incidentId}`);
  await expect(page.getByRole("heading", { level: 3, name: `E2E ${fixture.label} provider regression ${suffix}` })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  await page.getByLabel("Audit reason").fill(`Recovery authority reviewed at ${fixture.label}`);
  await page.getByLabel("Supplemental evidence reference (optional for authority check)").fill(`monitor://e2e/${fixture.label}/${suffix}`);
  const verifyIncident = page.getByRole("button", { name: "Run authority verification" });
  await verifyIncident.focus();
  await expect(verifyIncident).toBeFocused();
  await verifyIncident.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Authority recovery verification evaluated" })).toBeVisible();
  const resolveIncident = page.getByRole("button", { name: "Resolve incident" });
  await expect(resolveIncident).toBeEnabled();
  await resolveIncident.focus();
  await expect(resolveIncident).toBeFocused();
  await resolveIncident.press("Enter");
  await expect.poll(async () => prisma.opsIncident.findUnique({
    where: { id: fixture.incidentId },
    select: { status: true },
  }), { timeout: 45_000 }).toEqual({ status: "resolved" });
  await page.goto(`${adminBaseURL()}/admin/ops/incidents/${fixture.incidentId}`);
  await expect(page.getByRole("heading", { level: 4, name: "Postmortem and close" })).toBeVisible();
  await page.getByLabel("Audit reason").fill(`Recovery authority reviewed at ${fixture.label}`);
  await page.getByLabel("Supplemental evidence reference (optional for authority check)").fill(`monitor://e2e/${fixture.label}/${suffix}`);
  await page.getByLabel("Summary", { exact: true }).fill(`Provider route recovered and ${fixture.label} authority evidence was reconciled.`);
  await page.getByLabel("Root cause").fill(`${fixture.label} provider route regression`);
  await page.getByLabel("Contributing factors (one per line)").fill("Capacity signal lag");
  await page.getByLabel("Corrective actions (one per line)").fill("Keep the responsive authority canary active");
  await page.getByLabel("Type close confirmation").fill(`${fixture.incidentId}:close`);
  const closeIncident = page.getByRole("button", { name: "Record postmortem and close" });
  await closeIncident.focus();
  await expect(closeIncident).toBeFocused();
  await closeIncident.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Postmortem recorded and Incident closed" })).toBeVisible();
  await expect.poll(async () => prisma.opsIncident.findUnique({
    where: { id: fixture.incidentId },
    select: { status: true, verificationState: true, activeCorrelationKey: true },
  })).toEqual({ status: "closed", verificationState: "passed", activeCorrelationKey: null });

  await page.goto(`${adminBaseURL()}/admin/cases/${fixture.caseId}`);
  await expect(page.getByRole("heading", { level: 4, name: "Evidence" })).toBeVisible();
  await expect(page.getByText(`Customer supplied immutable ${fixture.label} reproduction evidence.`)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectWcag22AA(page);
  const caseDecision = page.locator('section[aria-labelledby="case-decision-title"]');
  await caseDecision.locator("select").selectOption("incident_escalated");
  await page.getByLabel("Outcome reference").fill(`incident:${fixture.incidentId}`);
  await page.getByLabel("Resolution summary").fill(`Escalated the ${fixture.label} customer impact and verified the recovered Incident authority state.`);
  const recordCaseAction = page.getByRole("button", { name: "Record action" });
  await recordCaseAction.focus();
  await expect(recordCaseAction).toBeFocused();
  await recordCaseAction.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Customer Case action recorded" })).toBeVisible();
  const verifyCase = page.getByRole("button", { name: "Verify from authority" });
  await expect(verifyCase).toBeEnabled();
  await verifyCase.focus();
  await expect(verifyCase).toBeFocused();
  await verifyCase.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Downstream outcome verified" })).toBeVisible();
  await page.getByLabel("Audit reason").fill(`${fixture.label} authority outcome verified for closure`);
  await page.getByLabel("Type confirmation").fill(`${fixture.caseId}:close`);
  const closeCase = page.getByRole("button", { name: "Close case", exact: true });
  await closeCase.focus();
  await expect(closeCase).toBeFocused();
  await closeCase.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Case close command accepted" })).toBeVisible();
  await expect.poll(async () => prisma.adminCase.findUnique({
    where: { id: fixture.caseId },
    select: { status: true, verificationState: true, activeKey: true },
  })).toEqual({ status: "closed", verificationState: "passed", activeKey: null });
  await expect.poll(async () => prisma.decisionRecord.count({
    where: { sourceId: fixture.caseId, decision: "incident_escalated" },
  })).toBe(1);
  await expectNoHorizontalOverflow(page);

  if (fixture.label === "mobile") {
    await page.goto(`${adminBaseURL()}/admin/cases?view=mine`);
    await page.getByLabel("Search all cases").fill(`missing-${suffix}`);
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("heading", { level: 3, name: "No work matches these filters" })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
  }
  expect(failures).toEqual([]);
}

test.describe.serial("Admin v2 operator workspaces", () => {
  test.describe.configure({ retries: 0 });
  test.beforeAll(async () => {
    await prisma.generationModelProfile.createMany({
      data: [
        {
          id: wizardBootstrapProfileId,
          profileKey: wizardBootstrapProfileKey,
          label: "E2E pipeline identity bootstrap",
          mode: "image",
          runner: "pipeline",
          pipelineModel: "redcraft-krea2-comfyui",
          workflowKey: "redcraft-krea2-txt2img",
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
          runner: "pipeline",
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
        advancedDetails: { firstMessage: "Welcome back. What should we make space for today?" },
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
        generationProfileKey: wizardIdentityProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
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
        visualProfileId: releaseProfileId,
        visualProfileVersion: 1,
        visualProfileHash: characterVisualProfileSnapshotHash(visualProfile),
        referenceSetRevisionId: releaseReferenceSetId,
        referenceSetRevision: 1,
        referenceSetHash: referenceSetSnapshotHash(referenceSnapshot),
        draftAssetPackHash: canonicalSha256({}),
        ownerId: actorId,
        status: "passed",
        checks: qaChecks,
        evidenceHash: `e2e-qa-evidence-${suffix}`,
      },
    });
    const generationProvenance = {
      routeFingerprint: releaseRouteFingerprint,
      matrixKey: "default-character",
      generationProfileKey: wizardIdentityProfileKey,
      generationProfileVersion: 1,
      workflowKey: "qwen-image-edit-img2img",
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
    const responsiveCreativeRunIds = responsiveCoreFixtures.map((fixture) => fixture.creativeRunId);
    const responsiveCreativeItemIds = responsiveCoreFixtures.map((fixture) => fixture.creativeItemId);
    const responsiveCreativeAssetIds = responsiveCoreFixtures.map((fixture) => fixture.creativeAssetId);
    const responsiveCreativeJobIds = responsiveCoreFixtures.map((fixture) => fixture.creativeJobId);
    const responsiveCreativeAttemptIds = responsiveCoreFixtures.map((fixture) => fixture.creativeAttemptId);
    const responsiveIncidentIds = responsiveCoreFixtures.map((fixture) => fixture.incidentId);
    const responsiveIncidentRequestIds = responsiveCoreFixtures.map((fixture) => fixture.incidentRequestId);
    const responsiveIncidentAttemptIds = responsiveCoreFixtures.map((fixture) => fixture.incidentAttemptId);
    const responsiveCaseIds = responsiveCoreFixtures.map((fixture) => fixture.caseId);
    const responsiveReleaseIds = responsiveCoreFixtures.map((fixture) => fixture.candidateReleaseId);
    const wizardRuns = wizardRunIds.length > 0
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
    const wizardItemIds = wizardRuns.flatMap((run) => run.items.map((item) => item.id));
    const wizardJobIds = wizardRuns.flatMap((run) =>
      run.items.flatMap((item) => item.jobId ? [item.jobId] : [])
    );
    const wizardAssetIds = wizardRuns.flatMap((run) => run.items.flatMap((item) => {
      const assetIds = [
        ...(item.mediaAssetId ? [item.mediaAssetId] : []),
        ...(item.job?.assets.map((asset) => asset.id) ?? []),
      ];
      return assetIds;
    }));
    const wizardPlacementIds = wizardAssetIds.length > 0
      ? (await prisma.mediaAssetPlacement.findMany({
          where: { mediaAssetId: { in: wizardAssetIds } },
          select: { id: true },
        })).map((placement) => placement.id)
      : [];
    const wizardAttemptIds = wizardJobIds.length > 0
      ? (await prisma.generationAttempt.findMany({
          where: { requestId: { in: wizardJobIds } },
          select: { id: true },
        })).map((attempt) => attempt.id)
      : [];
    if (wizardRuns.length > 0) {
      await Promise.all(wizardJobIds.flatMap((jobId) => [
        jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]),
        jobQueue.removeByDedupePrefix(`generation-finalize:${jobId}:`, ["app.ai.finalize"]),
      ]));
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
      const wizardCommandIds = (await prisma.controlPlaneCommand.findMany({
        where: { targetId: { in: wizardAuthorityTargetIds } },
        select: { id: true },
      })).map((command) => command.id);
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
                  run.items.map((item) => `creative_initial_${run.id}_${item.id}`)
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
    const characters = await prisma.character.findMany({ where: { name: { startsWith: "E2E V2 Companion " } }, select: { id: true } });
    const characterIds = [...new Set([
      ...characters.map((character) => character.id),
      ...(wizardCharacterId ? [wizardCharacterId] : []),
    ])];
    if (characterIds.length > 0) {
      const characterVisualProfileIds = (await prisma.characterVisualProfile.findMany({
        where: { characterId: { in: characterIds } },
        select: { id: true },
      })).map((profile) => profile.id);
      const characterReferenceSetIds = characterVisualProfileIds.length > 0
        ? (await prisma.referenceSetRevision.findMany({
            where: { visualProfileId: { in: characterVisualProfileIds } },
            select: { id: true },
          })).map((referenceSet) => referenceSet.id)
        : [];
      const projects = await prisma.characterProject.findMany({ where: { characterId: { in: characterIds } }, select: { id: true } });
      const projectIds = projects.map((project) => project.id);
      const characterReleaseIds = (await prisma.characterRelease.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true },
      })).map((release) => release.id);
      const characterQaRunIds = (await prisma.characterQaRun.findMany({
        where: { projectId: { in: projectIds } },
        select: { id: true },
      })).map((run) => run.id);
      const characterValidationRunIds = (await prisma.releaseValidationRun.findMany({
        where: { releaseId: { in: characterReleaseIds } },
        select: { id: true },
      })).map((run) => run.id);
      const characterAuthorityIds = [
        ...projectIds,
        ...characterIds,
        ...characterReleaseIds,
        ...characterQaRunIds,
      ];
      const characterCommandIds = (await prisma.controlPlaneCommand.findMany({
        where: { targetId: { in: characterAuthorityIds } },
        select: { id: true },
      })).map((command) => command.id);
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
      await prisma.characterServing.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.characterRelease.deleteMany({
        where: { id: { in: characterReleaseIds } },
      });
      await prisma.characterQaRun.deleteMany({
        where: { id: { in: characterQaRunIds } },
      });
      await prisma.characterRevision.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.characterProject.deleteMany({ where: { characterId: { in: characterIds } } });
      await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    }
    await prisma.mediaAsset.deleteMany({ where: { id: { in: wizardAssetIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: wizardJobIds } } });
    const commandIds = (await prisma.controlPlaneCommand.findMany({
      where: { targetId: { in: authorityTargetIds } },
      select: { id: true },
    })).map((command) => command.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({ where: { commandId: { in: commandIds } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { id: { in: commandIds } } });
    await prisma.mainOutboxEvent.deleteMany({
      where: { aggregateId: { in: [...authorityTargetIds, releaseProjectId, oldReleaseId] } },
    });
    await prisma.adminAuditLog.deleteMany({
      where: { targetId: { in: [...authorityTargetIds, releaseProjectId, oldReleaseId] } },
    });
    await prisma.decisionRecord.deleteMany({ where: { sourceId: { in: [caseId, ...responsiveCaseIds] } } });
    await prisma.incidentPostmortem.deleteMany({ where: { incidentId: { in: [incidentId, ...responsiveIncidentIds] } } });
    await prisma.opsIncidentOccurrence.deleteMany({ where: { incidentId: { in: [incidentId, ...responsiveIncidentIds] } } });
    await prisma.caseEvidence.deleteMany({ where: { caseId: { in: [caseId, ...responsiveCaseIds] } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: [caseId, ...responsiveCaseIds] } } });
    await prisma.opsIncident.deleteMany({ where: { id: { in: [incidentId, ...responsiveIncidentIds] } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: [incidentAttemptId, ...responsiveIncidentAttemptIds] } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: [incidentRequestId, ...responsiveIncidentRequestIds] } } });
    await prisma.generationAttemptEvent.deleteMany({ where: { attemptId: retryAttemptId } });
    await prisma.generationAttempt.deleteMany({ where: { requestId: retryRequestId } });
    await prisma.generationJob.deleteMany({ where: { id: retryRequestId } });
    await prisma.creativeReviewDecision.deleteMany({ where: { runItemId: { in: [creativeItemId, ...responsiveCreativeItemIds] } } });
    await prisma.mediaAssetPlacement.deleteMany({ where: { mediaAssetId: { in: [creativeAssetId, ...responsiveCreativeAssetIds] } } });
    await prisma.contentProductionItem.deleteMany({ where: { id: { in: [creativeItemId, ...responsiveCreativeItemIds] } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: [creativeRunId, ...responsiveCreativeRunIds] } } });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: [creativeAssetId, ...responsiveCreativeAssetIds] } } });
    await prisma.generationAttempt.deleteMany({ where: { id: { in: responsiveCreativeAttemptIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: responsiveCreativeJobIds } } });

    const releaseIds = (await prisma.characterRelease.findMany({
      where: { projectId: releaseProjectId },
      select: { id: true },
    })).map((release) => release.id);
    const releaseValidationIds = (await prisma.releaseValidationRun.findMany({
      where: { releaseId: { in: releaseIds } },
      select: { id: true },
    })).map((run) => run.id);
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId: { in: releaseIds } },
    });
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
    await prisma.generationRouteQualification.deleteMany({ where: { routeFingerprint: wizardRouteFingerprint } });
    await prisma.characterVisualReferenceSnapshot.deleteMany({ where: { referenceSetRevisionId: releaseReferenceSetId } });
    await prisma.referenceSetRevision.deleteMany({ where: { id: releaseReferenceSetId } });
    await prisma.characterVisualProfile.deleteMany({ where: { id: releaseProfileId } });
    await prisma.character.deleteMany({ where: { id: releaseCharacterId } });
    await prisma.mediaAsset.deleteMany({ where: { id: releaseMediaId } });
    await prisma.generationModelProfile.deleteMany({
      where: { id: { in: [wizardBootstrapProfileId, wizardIdentityProfileId] } },
    });
    await prisma.$disconnect();
  });

  test("takes one blank Character through identity, a complete image pack, QA, and a verified Release", async ({ page }) => {
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
    await expect(page.getByRole("heading", { level: 2, name: "Create Character Project" })).toBeVisible();
    const assertNotCreated = async () => {
      expect(createRequests).toHaveLength(0);
      expect(await prisma.character.count({
        where: { name: characterName },
      })).toBe(0);
    };
    await completeCharacterCreateDraft(
      page,
      characterName,
      assertNotCreated,
    );
    expect(await page.evaluate((key) =>
      window.localStorage.getItem(key),
    `idream.admin.character-create-draft.v1:${actorId}`)).not.toBeNull();
    const characterCreateResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/admin/characters"
    );
    await page.getByRole("button", {
      name: "Save character & open portrait studio",
    }).click();
    expect((await characterCreateResponse).status()).toBe(201);
    await expect(page).toHaveURL(
      /\/admin\/characters\/(?!new(?:[/?]|$))[^/?]+\?tab=assets$/,
    );
    expect(createRequests).toHaveLength(1);
    expect(await page.evaluate((key) =>
      window.localStorage.getItem(key),
    `idream.admin.character-create-draft.v1:${actorId}`)).toBeNull();
    wizardCharacterId = new URL(page.url()).pathname.split("/").at(-1) ?? null;
    if (!wizardCharacterId) throw new Error("Character wizard did not return a Character id");
    const initialProject = await prisma.characterProject.findFirstOrThrow({
      where: { characterId: wizardCharacterId },
    });
    expect(await prisma.characterVisualProfile.count({
      where: { characterId: wizardCharacterId },
    })).toBe(0);

    await expect(page.getByRole("heading", {
      name: "Establish the face customers will recognize",
    })).toBeVisible();
    await expect(page.getByText(/no reference input/i)).toBeVisible();
    await expect(page.getByRole("button", {
      name: "Generate 4 portraits",
    })).toBeEnabled();
    await page.getByRole("tab", { name: "visual" }).click();
    await page.getByText("Advanced identity controls", {
      exact: true,
    }).click();
    await expect(page.getByText(
      "Establish a reviewed portrait anchor in Character Assets before creating later identity versions.",
    )).toBeVisible();
    await expect(page.getByRole("button", { name: "Create & activate version" })).toBeDisabled();
    await page.getByRole("button", { name: "Open Character Assets" }).click();
    await expect(page.getByRole("heading", {
      name: "Establish the face customers will recognize",
    })).toBeVisible();
    await expect(page.getByText(/no reference input/i)).toBeVisible();

    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/admin/creative/runs"
    );
    await page.getByRole("button", { name: "Generate 4 portraits" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(202);
    const createPayload = await createResponse.json() as {
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
    expect(createdRun.items).toHaveLength(4);
    expect(createdRun.items.every((item) => item.job)).toBe(true);
    const outboxIds = createdRun.items.map(
      (item) => `creative_initial_${createdRun.id}_${item.id}`,
    );
    expect(await prisma.mainOutboxEvent.count({
      where: { id: { in: outboxIds }, status: "delivered" },
    })).toBe(4);
    for (const item of createdRun.items) {
      expect(await jobQueue.getByDedupeKey(
        "ai.image.generate",
        `generation:${item.jobId}:attempt:1`,
      )).not.toBeNull();
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

    await drainCreativeRun(page, wizardBootstrapRunId, 4);
    const assetStudioRefresh = page.getByLabel("assets").getByRole("button", {
      name: "Refresh",
      exact: true,
    });
    await expect(assetStudioRefresh).toBeEnabled();
    await assetStudioRefresh.click();
    await expect(page.getByRole("button", { name: /Select candidate/ })).toHaveCount(4);
    await expect(page.getByRole("img", {
      name: /Primary portrait Candidate 1$/i,
    })).toHaveJSProperty("complete", true);

    const reviewRegion = page.getByRole("region", {
      name: "Record the visible review evidence",
    });
    await reviewRegion.getByLabel("No visible artifacts").check();
    await reviewRegion.getByLabel("Exactly one intended subject").check();
    await reviewRegion.getByLabel("Composition matches the customer intent").check();
    await reviewRegion.getByLabel("No visible text, watermark, or contact sheet").check();
    await reviewRegion.getByLabel("Score", { exact: true }).fill("92");
    await expect(reviewRegion.getByLabel("Identity consistency")).toHaveValue("unscored");
    await expect(reviewRegion.getByLabel("Identity consistency")).toBeDisabled();
    await reviewRegion.getByLabel("Evidence and reason").fill(
      "Single intended subject, clean face and hands, no visible text, and a clear primary portrait composition.",
    );
    await reviewRegion.getByRole("button", { name: "Approve with evidence" }).click();
    await expect(page.getByRole("button", { name: "Set as identity anchor" })).toBeEnabled();

    await prisma.generationRouteQualification.create({
      data: {
        routeFingerprint: wizardRouteFingerprint,
        generationProfileKey: wizardIdentityProfileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
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
    const bootstrapResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v2/admin/characters/${wizardCharacterId}/identity-bootstrap`
    );
    await page.getByRole("button", { name: "Set as identity anchor" }).click();
    const bootstrapResponse = await bootstrapResponsePromise;
    expect(bootstrapResponse.ok(), await bootstrapResponse.text()).toBeTruthy();

    const selectedItem = await prisma.contentProductionItem.findFirstOrThrow({
      where: { batchId: wizardBootstrapRunId, status: "approved" },
      include: { job: true, mediaAsset: true },
    });
    const decision = await prisma.creativeReviewDecision.findFirstOrThrow({
      where: { runItemId: selectedItem.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(decision).toMatchObject({
      decision: "approved",
      identityConsistency: "unscored",
      score: 92,
      evidence: {
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
      },
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
      referenceAssetIds: [selectedItem.mediaAssetId],
    });
    expect(profile.immutableHash).toBe(characterVisualProfileSnapshotHash(profile));
    const referenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profile.id, status: "active" },
      include: { references: { orderBy: { position: "asc" } } },
    });
    expect(referenceSet.revision).toBe(1);
    expect(referenceSet.references).toEqual([
      expect.objectContaining({
        mediaAssetId: selectedItem.mediaAssetId,
        role: "primary_face",
        qualityScore: 92,
      }),
    ]);
    expect(referenceSet.snapshotHash).toBe(referenceSetSnapshotHash(referenceSet));
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
        reviewDecisionId: decision.id,
        generationJobId: selectedItem.jobId,
        bootstrapIdentity: true,
      },
    });
    expect(await prisma.character.findUniqueOrThrow({
      where: { id: wizardCharacterId },
    })).toMatchObject({ imageAssetId: null });
    await expect(page.getByRole("heading", {
      name: "Create the images customers will remember",
    })).toBeVisible();
    await page.getByRole("tab", { name: "visual" }).click();
    const referencePublication = page.getByRole("heading", {
      level: 4,
      name: "Publish Reference Set revision",
    }).locator("..");
    await expect(referencePublication.getByRole("checkbox", {
      name: `identity anchor · ${selectedItem.mediaAssetId}`,
      exact: true,
    })).toHaveCount(1);
    await page.getByRole("tab", { name: "assets" }).click();

    const heroRunId = await generateCharacterAssetRun(page, "Generate 4 heroes", 4);
    await expect(page.getByLabel("Identity consistency")).toHaveValue("passed");
    await approveCurrentCharacterCandidate(
      page,
      91,
      "Identity is preserved, the single subject reads clearly, and the wide composition is suitable for the character hero.",
    );
    const selectHero = page.getByRole("button", { name: "Select hero · next asset" });
    await expect(selectHero).toBeEnabled();
    const heroSelectionResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname ===
        `/api/v2/admin/characters/${wizardCharacterId}/draft-image`
    );
    await selectHero.click();
    const heroSelectionResponse = await heroSelectionResponsePromise;
    expect(heroSelectionResponse.ok(), await heroSelectionResponse.text()).toBeTruthy();
    const heroSelectionPayload = await heroSelectionResponse.json() as {
      data: { selectedAssetId: string };
    };
    const heroLineage = await selectedAssetLineage({
      runId: heroRunId,
      assetId: heroSelectionPayload.data.selectedAssetId,
      purpose: "character_hero",
    });
    await expect(page.getByRole("button", { name: "Generate 6 chat assets" })).toBeEnabled();

    const chatRunId = await generateCharacterAssetRun(page, "Generate 6 chat assets", 6);
    await expect(page.getByLabel("Identity consistency")).toHaveValue("passed");
    await approveCurrentCharacterCandidate(
      page,
      93,
      "Identity remains stable, the expression feels conversational, and the portrait is clean enough for a chat moment.",
    );
    const selectChat = page.getByRole("button", {
      name: "Select chat asset · preview",
    });
    await expect(selectChat).toBeEnabled();
    const chatSelectionResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname ===
        `/api/v2/admin/characters/${wizardCharacterId}/draft-image`
    );
    await selectChat.click();
    const chatSelectionResponse = await chatSelectionResponsePromise;
    expect(chatSelectionResponse.ok(), await chatSelectionResponse.text()).toBeTruthy();
    const chatSelectionPayload = await chatSelectionResponse.json() as {
      data: { selectedAssetId: string };
    };
    const chatLineage = await selectedAssetLineage({
      runId: chatRunId,
      assetId: chatSelectionPayload.data.selectedAssetId,
      purpose: "character_chat",
    });

    await expect(page.getByRole("heading", {
      level: 2,
      name: "Real user-surface renderer",
    })).toBeVisible();
    await expect(
      page.getByTitle("Draft Preview real frontend renderer"),
    ).toBeVisible();
    const qaKeys = [
      "explore_feed_card_desktop",
      "explore_feed_card_mobile",
      "character_detail_desktop",
      "character_detail_mobile",
      "opening_message",
      "five_turn_conversation",
      "chat_image",
    ] as const;
    for (const key of qaKeys) {
      const label = key.replaceAll("_", " ");
      await page.getByLabel(`${label} result`).selectOption("passed");
      await page.getByLabel(`${label} evidence reference`).fill(
        `playwright://${wizardCharacterId}/${key}`,
      );
      await page.getByLabel(`${label} comment`).fill(
        `Verified ${key} against the signed draft renderer and pinned character asset pack.`,
      );
    }
    await page.getByRole("button", { name: "Record immutable QA Run" }).click();
    await expect(page.getByText("current authority", { exact: true })).toBeVisible();
    const qaRun = await prisma.characterQaRun.findFirstOrThrow({
      where: { characterId: wizardCharacterId },
      orderBy: { createdAt: "desc" },
    });
    const qaProject = await prisma.characterProject.findFirstOrThrow({
      where: { characterId: wizardCharacterId },
    });
    expect(qaRun).toMatchObject({
      status: "passed",
      projectId: qaProject.id,
      projectVersion: qaProject.version,
      visualProfileId: profile.id,
      visualProfileVersion: profile.version,
      visualProfileHash: profile.immutableHash,
      referenceSetRevisionId: referenceSet.id,
      referenceSetRevision: referenceSet.revision,
      referenceSetHash: referenceSet.snapshotHash,
    });

    await page.getByRole("tab", { name: "release" }).click();
    await expect(page.getByLabel("Passed QA Run for this draft")).toHaveValue(qaRun.id);
    await page.getByLabel("Exact confirmation").fill(
      `${wizardCharacterId}:propose-release`,
    );
    await page.getByRole("button", { name: "Propose immutable Release" }).click();
    const proposedRelease = await expect.poll(async () =>
      prisma.characterRelease.findFirst({
        where: { projectId: qaProject.id, status: "in_review" },
        orderBy: { createdAt: "desc" },
      })
    ).not.toBeNull().then(async () =>
      prisma.characterRelease.findFirstOrThrow({
        where: { projectId: qaProject.id, status: "in_review" },
        orderBy: { createdAt: "desc" },
      })
    );
    await page.getByLabel("Exact confirmation").fill(
      `${wizardCharacterId}:${proposedRelease.id}:approved`,
    );
    await page.getByRole("button", { name: "Approve candidate" }).click();
    await expect.poll(async () => prisma.characterRelease.findUnique({
      where: { id: proposedRelease.id },
      select: { status: true },
    })).toEqual({ status: "approved" });

    await page.getByLabel("Exact confirmation").fill(
      `${wizardCharacterId}:${proposedRelease.id}:validate`,
    );
    await page.getByRole("button", { name: "Validate pinned snapshot" }).click();
    await expect.poll(async () => prisma.characterRelease.findUnique({
      where: { id: proposedRelease.id },
      select: { readiness: true },
    })).toEqual({ readiness: "ready" });

    await page.getByLabel("Exact confirmation").fill(
      `${wizardCharacterId}:${proposedRelease.id}:publish`,
    );
    await page.getByRole("button", { name: "Publish candidate" }).click();
    const publishCommand = await expect.poll(async () =>
      prisma.controlPlaneCommand.findFirst({
        where: {
          commandType: "character.release.publish",
          targetId: proposedRelease.id,
        },
        orderBy: { createdAt: "desc" },
      })
    ).not.toBeNull().then(async () =>
      prisma.controlPlaneCommand.findFirstOrThrow({
        where: {
          commandType: "character.release.publish",
          targetId: proposedRelease.id,
        },
        orderBy: { createdAt: "desc" },
      })
    );
    await expect(drainTargetAdminCommand(prisma, {
      commandId: publishCommand.id,
      workerId: `playwright-wizard-release-${suffix}`,
      leaseMs: 30_000,
    })).resolves.toMatchObject({
      examined: 1,
      succeeded: 1,
      failed: 0,
    });
    await expect.poll(async () => prisma.characterServing.findUnique({
      where: { characterId: wizardCharacterId! },
      select: { currentReleaseId: true, state: true },
    })).toEqual({ currentReleaseId: proposedRelease.id, state: "live" });

    await page.reload();
    await page.getByRole("tab", { name: "monitor" }).click();
    await page.getByRole("button", { name: "Refresh 24h" }).click();
    await expect.poll(async () => prisma.releaseMonitor.findUnique({
      where: {
        releaseId_window: {
          releaseId: proposedRelease.id,
          window: "24h",
        },
      },
      select: { status: true, observed: true, verification: true },
    })).toMatchObject({
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
    const draftAssetPack = finalProject.draftAssetPack as Record<string, {
      assetId: string;
      runId: string;
      itemId: string;
      reviewDecisionId: string;
      generationJobId: string;
      bootstrapIdentity?: boolean;
    }>;
    expect(draftAssetPack).toMatchObject({
      character_cover: {
        assetId: coverLineage.assetId,
        runId: coverLineage.runId,
        itemId: coverLineage.itemId,
        reviewDecisionId: coverLineage.reviewDecisionId,
        generationJobId: coverLineage.generationJobId,
        bootstrapIdentity: true,
      },
      character_hero: {
        assetId: heroLineage.assetId,
        runId: heroLineage.runId,
        itemId: heroLineage.itemId,
        reviewDecisionId: heroLineage.reviewDecisionId,
        generationJobId: heroLineage.generationJobId,
      },
      character_chat: {
        assetId: chatLineage.assetId,
        runId: chatLineage.runId,
        itemId: chatLineage.itemId,
        reviewDecisionId: chatLineage.reviewDecisionId,
        generationJobId: chatLineage.generationJobId,
      },
    });
    expect(finalRelease).toMatchObject({
      status: "published",
      readiness: "ready",
      characterContentVersionId: qaRun.characterContentVersionId,
      visualProfileId: profile.id,
      visualProfileVersion: profile.version,
      referenceSetRevisionId: referenceSet.id,
    });
    const releaseManifest = parseCharacterReleaseAssetManifest(
      finalRelease.releasePlacementManifest,
    );
    if (!releaseManifest) throw new Error("Published Release manifest is not strict v2");
    expect(
      characterReleaseAssetPlacement(releaseManifest, "character_avatar"),
    ).toMatchObject({
      slotKey: "character_avatar",
      assetId: coverLineage.assetId,
      runId: coverLineage.runId,
      itemId: coverLineage.itemId,
      reviewDecisionId: coverLineage.reviewDecisionId,
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
      reviewDecisionId: heroLineage.reviewDecisionId,
      generationJobId: heroLineage.generationJobId,
    });
    expect(
      characterReleaseAssetPlacement(releaseManifest, "character_chat"),
    ).toMatchObject({
      slotKey: "character_chat",
      assetId: chatLineage.assetId,
      runId: chatLineage.runId,
      itemId: chatLineage.itemId,
      reviewDecisionId: chatLineage.reviewDecisionId,
      generationJobId: chatLineage.generationJobId,
    });
    expect(finalRelease.generationProvenance).toMatchObject({
      schemaVersion: "character-release-generation-provenance-v2",
      characterQa: {
        qaRunId: qaRun.id,
        evidenceHash: qaRun.evidenceHash,
        projectVersion: qaRun.projectVersion,
        visualProfileHash: qaRun.visualProfileHash,
        referenceSetHash: qaRun.referenceSetHash,
        draftAssetPackHash: qaRun.draftAssetPackHash,
      },
    });
    const provenancePlacements = Array.isArray(
      (finalRelease.generationProvenance as Record<string, unknown>).placements,
    )
      ? (finalRelease.generationProvenance as {
          placements: Array<Record<string, unknown>>;
        }).placements
      : [];
    const provenanceBySlot = new Map(
      provenancePlacements.map((placement) => [
        placement.slotKey,
        placement,
      ]),
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
        reviewDecisionId: lineage.reviewDecisionId,
        generationJobId: lineage.generationJobId,
        attemptId: lineage.attemptId,
        attemptNo: lineage.attemptNo,
        provider: lineage.provider,
        generationProfileKey: lineage.profileKey,
        generationProfileVersion: lineage.profileVersion,
        workflowKey: lineage.workflowKey,
        workflowVersion: lineage.workflowVersion,
      });
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
    expect(finalRelease.snapshotHash).toBe(characterReleaseSnapshotHash({
      projectId: finalRelease.projectId,
      revisionId: finalRelease.revisionId,
      characterContentVersionId: finalRelease.characterContentVersionId,
      visualProfileId: finalRelease.visualProfileId,
      visualProfileVersion: finalRelease.visualProfileVersion,
      referenceSetRevisionId: finalRelease.referenceSetRevisionId,
      generationProvenance: finalRelease.generationProvenance,
      releasePlacementManifest: finalRelease.releasePlacementManifest,
    }));
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
    const detailPayload = await detailResponse.json() as {
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
    await expect(publicHero).toHaveAttribute("data-asset-id", heroLineage.assetId);
    await expect.poll(() =>
      publicHero.evaluate((image: HTMLImageElement) => ({
        complete: image.complete,
        naturalWidth: image.naturalWidth,
      })),
    ).toEqual({ complete: true, naturalWidth: expect.any(Number) });
    expect(
      await publicHero.evaluate((image: HTMLImageElement) => image.naturalWidth),
    ).toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(publicHero).toBeVisible();
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
    // This fixture intentionally represents a pre-Asset-Studio, avatar-only
    // Release. Preview must fail closed instead of reusing one image across
    // hero and chat; the complete three-image renderer is exercised above by
    // the real Character Asset Studio journey.
    await expect(page.getByTitle("Live real frontend renderer")).toHaveCount(0);
    await expect(page.getByText(
      "Renderer unavailable: avatar, hero, and chat must each resolve to their exact operational asset.",
      { exact: true },
    )).toHaveCount(2);
    await expect(page.getByText(releaseQaRunId)).toBeVisible();
    const qaCard = page.locator("article").filter({ hasText: releaseQaRunId });
    await expect(qaCard).toContainText("stale");
    await expect(page.getByText(
      "QA requires a complete cover, hero, and chat image pack under the current effective route.",
      { exact: false },
    )).toBeVisible();
    await qaCard.getByText("Checks, evidence, and repair paths", { exact: true }).click();
    await expect(qaCard.getByText("e2e://character/explore_feed_card_desktop", { exact: false })).toBeVisible();
    await expect(qaCard.getByText("Verified in the immutable browser fixture.", { exact: true }).first()).toBeVisible();
    await expect(qaCard.getByRole("link", { name: "Open fix path" }).first()).toBeVisible();

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
    const lifecycleProvenance =
      lifecycle.source.generationProvenance as Record<string, unknown>;
    const lifecycleCharacterQa =
      lifecycleProvenance.characterQa as Record<string, unknown>;
    const lifecycleRequiredRoute =
      lifecycleProvenance.requiredReleaseRoute as Record<string, unknown>;
    const lifecycleQaRunId = lifecycleCharacterQa?.qaRunId;
    const lifecycleRouteFingerprint =
      lifecycleRequiredRoute?.routeFingerprint;
    if (
      !lifecycleAvatarAssetId ||
      typeof lifecycleQaRunId !== "string" ||
      typeof lifecycleRouteFingerprint !== "string"
    ) {
      throw new Error(
        "The lifecycle candidate source is missing exact asset, QA, or route evidence.",
      );
    }

    await page.goto(
      `${adminBaseURL()}/admin/characters/${lifecycleCharacterId}?tab=release`,
    );
    await expect(
      page.getByRole("heading", { level: 2, name: characterName }),
    ).toBeVisible();
    const candidateCard = page.locator("article").filter({ hasText: candidateReleaseId });
    await expect(candidateCard).toContainText("unknown");
    await candidateCard.getByText("Pinned assets, generation, and review lineage", { exact: true }).click();
    await expect(candidateCard.getByText(lifecycleAvatarAssetId, { exact: false })).toBeVisible();
    await expect(candidateCard.getByText(lifecycleQaRunId, { exact: false })).toBeVisible();
    await expect(candidateCard.getByText(lifecycleRouteFingerprint, { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish candidate" })).toBeDisabled();
    await page.getByLabel("Exact confirmation").fill(`${lifecycleCharacterId}:${candidateReleaseId}:validate`);
    await page.getByRole("button", { name: "Validate pinned snapshot" }).click();
    await expect(candidateCard).toContainText("ready");

    const publishPath = `/api/v2/admin/characters/${lifecycleCharacterId}/releases/${candidateReleaseId}/commands/publish`;
    const pendingCommandKey = pendingCharacterCommandStorageKey(lifecycleCharacterId);
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
        await response.body();
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
    await page.getByLabel("Exact confirmation").fill(`${lifecycleCharacterId}:${candidateReleaseId}:publish`);
    await page.getByRole("button", { name: "Publish candidate" }).click();
    await expect.poll(() => publishInterceptions).toBeGreaterThanOrEqual(2);
    await expect(page.getByText(
      /acceptance cannot be proven with the current session or permissions.*Character writes remain locked/,
    )).toBeVisible();
    await expect.poll(() =>
      failures.filter((failure) =>
        failure.includes("status of 403 (Forbidden)")
      ).length
    ).toBe(1);
    const injectedForbiddenConsoleError = failures.findIndex((failure) =>
      failure.includes("status of 403 (Forbidden)")
    );
    expect(injectedForbiddenConsoleError).toBeGreaterThanOrEqual(0);
    failures.splice(injectedForbiddenConsoleError, 1);
    await expect(page.getByRole("tab", { name: "project" })).toBeDisabled();
    await expect.poll(async () => page.evaluate((storageKey) => {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return "missing";
      const parsed = JSON.parse(raw) as { commandId?: string | null };
      return parsed.commandId ?? "unknown";
    }, pendingCommandKey)).toBe("unknown");
    await expect(prisma.controlPlaneCommand.count({
      where: { commandType: "character.release.publish", targetId: candidateReleaseId },
    })).resolves.toBe(1);
    await expect.poll(async () => page.evaluate((storageKey) => {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { commandId?: string | null };
      return parsed.commandId ?? null;
    }, pendingCommandKey)).not.toBeNull();
    await page.unroute(`**${publishPath}`, publishRoute);
    await expect.poll(() => publishIdempotencyKeys.length).toBeGreaterThanOrEqual(3);
    expect(new Set(publishIdempotencyKeys).size).toBe(1);
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
    await expect(prisma.controlPlaneCommand.count({
      where: { commandType: "character.release.publish", targetId: candidateReleaseId },
    })).resolves.toBe(1);
    await page.evaluate((storageKey) => {
      window.localStorage.removeItem(storageKey);
      window.sessionStorage.removeItem(storageKey);
    }, pendingCommandKey);
    await page.reload();
    await expect(page.getByText(
      "release publish command is pending. Character writes stay locked until the worker records a terminal result and the workspace refreshes.",
      { exact: true },
    )).toBeVisible();
    await expect(page.getByRole("tab", { name: "project" })).toBeDisabled();
    await expect(page.getByRole("tab", { name: "release" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await executeCharacterReleaseCommand(prisma, {
      commandId: publishCommand.id,
      workerId: `playwright-release-publish-${suffix}`,
    });
    await expect.poll(async () => prisma.characterServing.findUnique({
      where: { characterId: lifecycleCharacterId },
      select: { currentReleaseId: true, state: true },
    })).toEqual({ currentReleaseId: candidateReleaseId, state: "live" });
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
    await page.getByRole("tab", { name: "release" }).click();
    await expect(page.locator("article").filter({ hasText: candidateReleaseId })).toContainText("serving now");

    await page.getByRole("tab", { name: "monitor" }).click();
    const refresh24h = page.getByRole("button", { name: "Refresh 24h" });
    await refresh24h.click();
    await expect.poll(async () => prisma.releaseMonitor.findUnique({
      where: { releaseId_window: { releaseId: candidateReleaseId, window: "24h" } },
      select: { status: true },
    })).not.toBeNull();
    await expect(page.getByRole("heading", { level: 3, name: "24h guardrail" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "72h guardrail" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "route qualification guardrail" })).toBeVisible();
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
    await routeGuardrail.getByRole("button", {
      name: "Open route qualification",
    }).click();
    await expect(page.getByRole("heading", {
      level: 3,
      name: "Visual Identity authority",
    })).toBeVisible();
    await page.getByRole("tab", { name: "monitor" }).click();

    await page.getByRole("tab", { name: "release" }).click();
    await page.getByLabel("Exact confirmation").fill(`${lifecycleCharacterId}:${lifecycleOldReleaseId}:rollback`);
    await page.getByRole("button", { name: "Roll back to selected snapshot" }).click();
    await expect.poll(async () => prisma.controlPlaneCommand.findFirst({
      where: { commandType: "character.release.rollback", targetId: lifecycleCharacterId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    })).not.toBeNull();
    const rollbackCommand = await prisma.controlPlaneCommand.findFirstOrThrow({
      where: { commandType: "character.release.rollback", targetId: lifecycleCharacterId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    await executeCharacterReleaseCommand(prisma, {
      commandId: rollbackCommand.id,
      workerId: `playwright-release-rollback-${suffix}`,
    });
    await expect.poll(async () => prisma.characterServing.findUnique({
      where: { characterId: lifecycleCharacterId },
      select: { currentReleaseId: true },
    })).toMatchObject({ currentReleaseId: expect.stringMatching(/^rollback:/) });
    const serving = await prisma.characterServing.findUniqueOrThrow({
      where: { characterId: lifecycleCharacterId },
      select: { currentReleaseId: true },
    });
    const rollbackRelease = await prisma.characterRelease.findUniqueOrThrow({ where: { id: serving.currentReleaseId! } });
    const oldRelease = await prisma.characterRelease.findUniqueOrThrow({ where: { id: lifecycleOldReleaseId } });
    expect(rollbackRelease).toMatchObject({ rollbackOfReleaseId: lifecycleOldReleaseId, status: "published" });
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

    const runOptionsPromise = page.waitForResponse((response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/v2/admin/creative/run-options"
    );
    await page.goto(`${adminBaseURL()}/admin/creative/runs`);
    const runOptionsResponse = await runOptionsPromise;
    expect(runOptionsResponse.ok(), await runOptionsResponse.text()).toBeTruthy();
    await expect(page.locator("#creative-runs-title")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Character Asset Studio" })).toHaveAttribute("href", "/admin/characters");
    await expect(page.getByLabel("Creative brief")).toBeVisible();
    await expect(page.getByText("Ready to create. Destination is chosen only after review.")).toHaveCount(0);
    const dynamicTitle = `E2E operator-created campaign ${suffix}`;
    const dynamicBrief = "One cinematic editorial campaign image with a clear subject, quiet confidence, warm practical lighting, and generous negative space for launch copy.";
    await page.getByLabel("Creative brief").fill(dynamicBrief);
    await page.getByLabel("Items").fill("1");
    await page.getByText("Advanced creation details", { exact: true }).click();
    await page.getByLabel("Run title").fill(dynamicTitle);
    await page.getByLabel("Image route").selectOption(wizardBootstrapProfileKey);
    await page.getByLabel("Canvas").selectOption("16:9");
    await expect(page.getByText("Ready to create. Destination is chosen only after review.")).toBeVisible();
    const createResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v2/admin/creative/runs"
    );
    await page.getByRole("button", { name: "Create and launch" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.status()).toBe(202);
    await expect(page).toHaveURL(/\/admin\/creative\/runs\/[^/?]+$/);
    const dynamicCreativeRunId = new URL(page.url()).pathname.split("/").at(-1);
    if (!dynamicCreativeRunId) throw new Error("Creative Run creation did not navigate to its detail");
    wizardRunIds.push(dynamicCreativeRunId);
    await expect(page).toHaveURL(new RegExp(`/admin/creative/runs/${dynamicCreativeRunId}$`));
    await expect(page.getByRole("heading", { level: 2, name: dynamicTitle })).toBeVisible();
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({
      where: { id: dynamicCreativeRunId },
    })).resolves.toMatchObject({
      purpose: "campaign",
      targetType: "none",
      targetId: null,
      profileId: wizardBootstrapProfileKey,
      orientation: "16:9",
      brief: dynamicBrief,
      count: 1,
    });

    await drainCreativeRun(page, dynamicCreativeRunId, 1);
    await expect(page.getByAltText("Creative item 1")).toBeVisible({ timeout: 10_000 });
    const reviewContext = page.getByRole("region", {
      name: "Review against the brief",
    });
    await expect(reviewContext).toContainText(dynamicBrief);
    await expect(reviewContext).toContainText("campaign");
    await expect(reviewContext).toContainText("16:9");
    await expect(reviewContext).toContainText("E2E pipeline identity bootstrap · v1");
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
    const dynamicReviewReason = "Reviewed the campaign image against the intended composition and distribution use.";
    const dynamicStagingReason = "Stage this reviewed candidate for authoritative campaign verification.";
    const dynamicStagedWithdrawalReason = "Withdraw the staged campaign candidate because the launch direction was retired before activation.";
    const dynamicApprovalWithdrawalReason = "Retire the approval because the campaign direction was cancelled after the staged candidate was withdrawn.";
    const dynamicCampaignEyebrow = "E2E operator feature";
    const dynamicCampaignTitle = `Reviewed campaign ${suffix}`;
    await completeGenericCreativeReview(page, {
      score: 90,
      reason: dynamicReviewReason,
    });
    await completeGenericCreativePlacement(page, {
      targetId: `campaign-${suffix}`,
      eyebrow: dynamicCampaignEyebrow,
      title: dynamicCampaignTitle,
      reason: dynamicStagingReason,
    });
    await expect(page.getByText("Use Withdraw staged placement below before superseding this approval.")).toBeVisible();
    const dynamicApprovedDecision = await prisma.creativeReviewDecision.findFirstOrThrow({
      where: {
        runItemId: dynamicItem.id,
        artifactId: dynamicItem.mediaAssetId!,
        decision: "approved",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const dynamicStagedPlacement = await prisma.mediaAssetPlacement.findFirstOrThrow({
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
    await page.getByLabel("Withdrawal reason", { exact: true }).fill(dynamicStagedWithdrawalReason);
    await page.getByRole("button", { name: "Withdraw staged placement" }).click();
    await expect(page.getByRole("button", { name: "Stage campaign candidate" })).toBeVisible();
    await expect(page.getByLabel("Staging reason", { exact: true })).toHaveValue("");
    await expect(page.getByRole("heading", { level: 4, name: "Terminal disposition" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: dynamicTitle })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stage campaign candidate" })).toBeVisible();
    await expect(page.getByLabel("Withdrawal reason", { exact: true })).toHaveValue("");

    await expect.poll(async () => prisma.contentProductionBatch.findUnique({
      where: { id: dynamicCreativeRunId },
      select: {
        lifecycleState: true,
        workflowStage: true,
        verificationState: true,
        version: true,
      },
    })).toEqual({
      lifecycleState: "active",
      workflowStage: "placement",
      verificationState: "pending",
      version: 4,
    });
    await expect.poll(async () => prisma.creativeReviewDecision.findFirst({
      where: {
        runItemId: dynamicItem.id,
        artifactId: dynamicItem.mediaAssetId!,
        decision: "approved",
        score: 90,
      },
      select: {
        artifactId: true,
        decision: true,
        identityConsistency: true,
        score: true,
        reason: true,
      },
    })).toEqual({
      artifactId: dynamicItem.mediaAssetId!,
      decision: "approved",
      identityConsistency: "unscored",
      score: 90,
      reason: dynamicReviewReason,
    });
    await expect.poll(async () => prisma.mediaAssetPlacement.findUnique({
      where: { id: dynamicStagedPlacement.id },
      select: {
        status: true,
        verificationState: true,
        verificationEvidence: true,
        version: true,
      },
    })).toEqual({
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
    await expect(prisma.adminAuditLog.findFirstOrThrow({
      where: {
        action: "creative.placement.staged",
        targetId: dynamicStagedPlacement.id,
      },
      orderBy: { createdAt: "desc" },
      select: { reason: true },
    })).resolves.toEqual({ reason: dynamicStagingReason });
    await expect(prisma.adminAuditLog.findFirstOrThrow({
      where: {
        action: "creative.placement.withdrawn",
        targetId: dynamicStagedPlacement.id,
      },
      orderBy: { createdAt: "desc" },
      select: { reason: true },
    })).resolves.toEqual({ reason: dynamicStagedWithdrawalReason });
    await expect(prisma.mainOutboxEvent.count({
      where: {
        aggregateId: dynamicCreativeRunId,
        eventType: "creative.placement.withdrawn.v2",
      },
    })).resolves.toBe(1);
    await expect(prisma.mediaAssetPlacement.count({
      where: {
        mediaAssetId: dynamicItem.mediaAssetId!,
        status: "published",
        metadata: {
          path: ["creativeRunId"],
          equals: dynamicCreativeRunId,
        },
      },
    })).resolves.toBe(0);

    await page.getByLabel("Withdrawal reason", { exact: true }).fill(dynamicApprovalWithdrawalReason);
    await page.getByRole("button", { name: "Withdraw approval" }).click();
    await expect(page.getByText(dynamicApprovalWithdrawalReason)).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw approval" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stage campaign candidate" })).toBeDisabled();
    await expect.poll(async () => prisma.contentProductionBatch.findUnique({
      where: { id: dynamicCreativeRunId },
      select: {
        lifecycleState: true,
        status: true,
        workflowStage: true,
        verificationState: true,
        version: true,
      },
    })).toEqual({
      lifecycleState: "closed",
      status: "completed",
      workflowStage: "review",
      verificationState: "pending",
      version: 5,
    });
    await expect(prisma.contentProductionItem.findUniqueOrThrow({
      where: { id: dynamicItem.id },
      select: { status: true },
    })).resolves.toEqual({ status: "rejected" });
    const dynamicDecisions = await prisma.creativeReviewDecision.findMany({
      where: { runItemId: dynamicItem.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        decision: true,
        supersedesDecisionId: true,
        reason: true,
      },
    });
    expect(dynamicDecisions).toHaveLength(2);
    expect(dynamicDecisions.at(-1)).toEqual({
      id: expect.any(String),
      decision: "rejected",
      supersedesDecisionId: dynamicApprovedDecision.id,
      reason: dynamicApprovalWithdrawalReason,
    });

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
      where: { targetId: { in: [dynamicItem.id, incidentId, caseId] } },
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
      await expect(page.locator("a.admin-skip-link")).toHaveAttribute("href", "#admin-main-content");
      await expectWcag22AA(page);
    }
    expect(failures).toEqual([]);
  });

  for (const fixture of responsiveCoreFixtures) {
    test(`completes all four authority workflows with keyboard and WCAG gates at ${fixture.viewport.width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await completeResponsiveCoreFlows(page, fixture);
    });
  }
});
