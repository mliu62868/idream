import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mockVideoMp4Bytes } from "@idream/shared";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";

test.beforeAll(async () => {
  await cleanupPublicE2EFixtures();
});

test.afterEach(async () => {
  await cleanupPublicE2EFixtures();
});

function uniqueEmail(tag: string) {
  return `e2e-ui-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

function uniqueName(tag: string) {
  return `E2E ${tag} ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
}

function internalToken() {
  return process.env.INTERNAL_TOKEN ?? "development-internal-token";
}

async function startSignedInAdultSession(page: Page, tag: string) {
  const email = uniqueEmail(tag);
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const signup = await page.request.post("/api/v1/auth/signup", {
    data: {
      email,
      password: "password123",
      name: `E2E ${tag}`,
    },
  });
  expect(signup.ok(), await signup.text()).toBeTruthy();
  return { email };
}

async function seedLegacyPlaceholderMedia(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const id = `e2e-ui-legacy-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await prisma.mediaAsset.create({
    data: {
      id,
      ownerId: user.id,
      type: "image",
      url: "/images/ourdream/card-sarah-mercer.webp",
      thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
      prompt: "legacy generated media without stored output",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { e2e: true, legacyPlaceholder: true },
    },
  });
  return id;
}

function redeemCodeHash(code: string) {
  let hash = 5381;
  for (const char of code) hash = (hash * 33) ^ char.charCodeAt(0);
  return `redeem_${Math.abs(hash)}`;
}

async function seedRedeemCode(code: string, dreamcoins: number) {
  const codeHash = redeemCodeHash(code.toUpperCase());
  await prisma.redeemCode.upsert({
    where: { codeHash },
    update: { reward: { dreamcoins }, status: "active" },
    create: {
      id: code,
      codeHash,
      reward: { dreamcoins },
      status: "active",
    },
  });
}

async function seedDownloadableMedia(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const id = `e2e-ui-profile-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const storageKey = `e2e/profile/${id}.png`;
  const target = resolveLocalBlobPath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ak9zP8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await prisma.mediaAsset.create({
    data: {
      id,
      ownerId: user.id,
      type: "image",
      url: `/user-content/${Buffer.from(id, "utf8").toString("base64url")}/content.png`,
      thumbnailUrl: null,
      storageKey,
      contentType: "image/png",
      width: 1,
      height: 1,
      prompt: "profile downloadable media",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { e2e: true, providerKey: storageKey },
    },
  });
  return id;
}

async function seedDownloadableVideoMedia(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const id = `e2e-ui-profile-video-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const storageKey = `e2e/profile/${id}.mp4`;
  const target = resolveLocalBlobPath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, mockVideoMp4Bytes());
  await prisma.mediaAsset.create({
    data: {
      id,
      ownerId: user.id,
      type: "video",
      url: `/user-content/${Buffer.from(id, "utf8").toString("base64url")}/content.mp4`,
      thumbnailUrl: null,
      storageKey,
      contentType: "video/mp4",
      prompt: "profile downloadable video media",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { e2e: true, providerKey: storageKey },
    },
  });
  return id;
}

async function cleanupPublicE2EFixtures() {
  const fixtureCharacters = await prisma.character.findMany({
    where: {
      visibility: "public",
      status: "approved",
      OR: [
        { id: { startsWith: "e2e-ui-" } },
        { name: { startsWith: "E2E " } },
        { name: { startsWith: "Dreamer " } },
        { description: { contains: "seeded for Explore UI filtering" } },
        { description: { contains: "used to verify community dreamer profile reporting" } },
        { creator: { is: { email: { endsWith: "@test.local" } } } },
      ],
    },
    select: {
      id: true,
      creatorId: true,
    },
  });
  if (fixtureCharacters.length === 0) return;

  const now = new Date();
  const characterIds = fixtureCharacters.map((character) => character.id);
  const creatorIds = fixtureCharacters
    .map((character) => character.creatorId)
    .filter((creatorId): creatorId is string => Boolean(creatorId));

  await prisma.contentReport.deleteMany({
    where: {
      OR: [
        { targetId: { in: characterIds } },
        ...(creatorIds.length > 0
          ? [{ targetType: "user_profile", targetId: { in: creatorIds } }]
          : []),
      ],
    },
  });
  await prisma.character.updateMany({
    where: { id: { in: characterIds } },
    data: {
      visibility: "private",
      status: "removed",
      deletedAt: now,
    },
  });

  if (creatorIds.length === 0) return;
  await prisma.user.updateMany({
    where: {
      id: { in: creatorIds },
      email: { endsWith: "@test.local" },
    },
    data: {
      status: "deleted",
      deletedAt: now,
    },
  });
}

async function enableVideoGenerationForUser(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const previousFlag = await prisma.featureFlag.findUnique({
    where: { key: "video_gen" },
    select: { enabled: true, rolloutPercent: true },
  });
  await prisma.entitlement.upsert({
    where: { userId_key: { userId: user.id, key: "video_generation" } },
    update: { value: true, source: "e2e" },
    create: { userId: user.id, key: "video_generation", value: true, source: "e2e" },
  });
  await prisma.featureFlag.update({
    where: { key: "video_gen" },
    data: { enabled: true, rolloutPercent: 100 },
  });
  return previousFlag;
}

async function restoreVideoGenerationFlag(previousFlag: {
  enabled: boolean;
  rolloutPercent: number;
} | null) {
  if (!previousFlag) {
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: false, rolloutPercent: 0 },
    });
    return;
  }
  await prisma.featureFlag.update({
    where: { key: "video_gen" },
    data: previousFlag,
  });
}

async function seedCommunityDreamer() {
  const id = `e2e-ui-dreamer-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const characterId = `${id}-character`;
  const [topScore] = await prisma.$queryRaw<Array<{ score: bigint | number | null }>>`
    SELECT COALESCE(MAX(COALESCE(cs."likesCount", 0) + COALESCE(cs."chatsCount", 0)), 0)::bigint AS score
    FROM "character_stats" cs
  `;
  const score =
    Number(topScore?.score ?? 0) +
    1_000_000 +
    Math.floor(Math.random() * 1_000_000);
  const displayName = `Dreamer ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  await prisma.user.create({
    data: {
      id,
      email: `${id}@test.local`,
      emailVerified: true,
      displayName,
    },
  });
  await prisma.character.create({
    data: {
      id: characterId,
      creatorId: id,
      name: `${displayName} Companion`,
      age: 24,
      description: "A public character used to verify community dreamer profile reporting.",
      visibility: "public",
      status: "approved",
      appearance: {},
      advancedDetails: {},
    },
  });
  await prisma.characterStats.create({
    data: {
      characterId,
      likesCount: score,
      chatsCount: score,
      viewsCount: score,
    },
  });
  return { id, displayName };
}

async function seedExploreCharacters(token: string) {
  const creatorId = `e2e-ui-explore-creator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await prisma.user.create({
    data: {
      id: creatorId,
      email: `${creatorId}@test.local`,
      emailVerified: true,
      displayName: "Explore Creator",
    },
  });
  const romantic = await prisma.tag.upsert({
    where: { slug: "romantic" },
    update: { label: "Romantic", category: "mood" },
    create: { id: `e2e-ui-romantic-${Date.now()}`, slug: "romantic", label: "Romantic", category: "mood" },
  });
  const specs = [
    { suffix: "alpha", name: `${token} Alpha`, chats: 300, gender: "female", createdAt: "2026-01-01T00:00:00Z" },
    { suffix: "beta", name: `${token} Beta`, chats: 200, gender: "female", createdAt: "2026-03-01T00:00:00Z" },
    { suffix: "gamma", name: `${token} Gamma`, chats: 100, gender: "female", createdAt: "2026-06-01T00:00:00Z" },
    { suffix: "delta", name: `${token} Delta`, chats: 400, gender: "male", createdAt: "2026-05-01T00:00:00Z" },
  ];
  const ids: Record<string, string> = {};
  for (const spec of specs) {
    const id = `e2e-ui-explore-${spec.suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    ids[spec.suffix] = id;
    await prisma.character.create({
      data: {
        id,
        creatorId,
        name: spec.name,
        age: 24,
        description: `${spec.name} seeded for Explore UI filtering.`,
        visibility: "public",
        status: "approved",
        style: "realistic",
        gender: spec.gender,
        appearance: {},
        advancedDetails: {},
        createdAt: new Date(spec.createdAt),
        tags: { create: { tagId: romantic.id } },
        stats: {
          create: {
            likesCount: spec.chats,
            chatsCount: spec.chats,
            viewsCount: spec.chats,
          },
        },
      },
    });
  }
  return ids as { alpha: string; beta: string; gamma: string; delta: string };
}

async function expectContentReport(targetType: string, targetId: string) {
  await expect
    .poll(
      async () => {
        const report = await prisma.contentReport.findFirst({
          where: { targetType, targetId },
          select: { id: true },
        });
        return Boolean(report);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function latestGenerationJob(ctx: APIRequestContext, mode: "image" | "video") {
  const response = await ctx.get("/api/v1/generation/jobs", {
    params: { mode, limit: 1 },
  });
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as {
    data?: { items?: Array<{ id: string; status: string }> };
  };
  const job = payload.data?.items?.[0];
  expect(job?.id).toBeTruthy();
  return job as { id: string; status: string };
}

async function latestImageJob(ctx: APIRequestContext) {
  return latestGenerationJob(ctx, "image");
}

async function generationJobStatus(ctx: APIRequestContext, jobId: string) {
  const jobResponse = await ctx.get(`/api/v1/generation/jobs/${jobId}`);
  expect(jobResponse.ok()).toBeTruthy();
  const payload = (await jobResponse.json()) as {
    data?: { job?: { status: string; errorCode?: string | null } };
  };
  return payload.data?.job;
}

async function expectGeneratedAssetServed(
  ctx: APIRequestContext,
  jobId: string,
  mediaType: "image" | "video" = "image",
) {
  const jobResponse = await ctx.get(`/api/v1/generation/jobs/${jobId}`);
  expect(jobResponse.ok()).toBeTruthy();
  const payload = (await jobResponse.json()) as {
    data?: {
      assets?: Array<{
        id: string;
        url: string;
        contentType?: string | null;
      }>;
    };
  };
  const asset = payload.data?.assets?.[0];
  if (!asset) throw new Error(`Generation job ${jobId} did not return an asset`);
  expect(asset.id).toBeTruthy();
  expect(asset.url).toMatch(/^\/user-content\//);

  const mediaResponse = await ctx.get(asset.url);
  expect(mediaResponse.ok(), `${asset.url} returned ${mediaResponse.status()}`).toBeTruthy();
  expect(mediaResponse.headers()["content-type"]).toContain(`${mediaType}/`);
  const bytes = await mediaResponse.body();
  expect(bytes.length).toBeGreaterThan(0);
  if (mediaType === "video") {
    expectMp4Bytes(bytes, asset.url);
    return;
  }

  const header = bytes.subarray(0, 12).toString("hex");
  const looksLikeImage =
    header.startsWith("89504e47") ||
    header.startsWith("ffd8ff") ||
    header.startsWith("47494638") ||
    header.startsWith("52494646");
  expect(looksLikeImage, `${asset.url} did not return decodable image bytes`).toBeTruthy();
}

function expectMp4Bytes(bytes: Buffer, url: string) {
  const header = bytes.subarray(4, 12).toString("ascii");
  expect(header, `${url} did not return an MP4 ftyp box`).toBe("ftypisom");
}

async function drainWorker(ctx: APIRequestContext, jobId: string) {
  let lastStatus = "unknown";
  const workerBatches: unknown[] = [];
  const deadline = Date.now() + 90_000;
  for (let attempt = 0; Date.now() < deadline; attempt += 1) {
    const current = await generationJobStatus(ctx, jobId);
    lastStatus = current?.status ?? "missing";
    if (lastStatus === "completed") return;
    if (["failed", "blocked", "refunded"].includes(lastStatus)) {
      throw new Error(`Generation reached ${lastStatus}: ${current?.errorCode ?? "no error code"}`);
    }

    const worker = await ctx.post("/api/internal/worker", {
      headers: { authorization: `Bearer ${internalToken()}` },
      timeout: 90_000,
    });
    expect(worker.ok()).toBeTruthy();
    workerBatches.push((await worker.json()) as unknown);

    const job = await generationJobStatus(ctx, jobId);
    lastStatus = job?.status ?? "missing";
    if (lastStatus === "completed") return;
    if (["failed", "blocked", "refunded"].includes(lastStatus)) {
      throw new Error(`Generation reached ${lastStatus}: ${job?.errorCode ?? "no error code"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    `Generation did not complete after worker drain; last status ${lastStatus}; worker batches ${JSON.stringify(workerBatches)}`,
  );
}

async function expectAssistantReplyVisible(page: Page) {
  const assistantMessages = page.getByTestId("chat-message-assistant");
  await expect(assistantMessages).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(async () => (await assistantMessages.textContent())?.trim().length ?? 0, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
}

test("explore UI syncs filters to URL and paginates results", async ({ page }) => {
  await startSignedInAdultSession(page, "explore");
  const token = `E2E Explore ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  const ids = await seedExploreCharacters(token);

  await page.goto(`/?q=${encodeURIComponent(token)}&limit=2`);
  const alpha = page.locator(`a[href="/characters/${ids.alpha}"]`);
  const beta = page.locator(`a[href="/characters/${ids.beta}"]`);
  const gamma = page.locator(`a[href="/characters/${ids.gamma}"]`);
  const delta = page.locator(`a[href="/characters/${ids.delta}"]`);

  await expect(alpha).toBeVisible({ timeout: 10_000 });
  await expect(beta).toBeVisible({ timeout: 10_000 });
  await expect(gamma).toHaveCount(0);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(gamma).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Sort characters" }).click();
  await expect(page).toHaveURL(/sort=newest/);
  await expect(gamma).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Gender filter" }).click();
  await expect(page).toHaveURL(/gender=male/);
  await expect(delta).toBeVisible({ timeout: 10_000 });
  await expect(gamma).toHaveCount(0);

  await page.getByRole("button", { name: "Romantic" }).click();
  await expect(page).toHaveURL(/tags=romantic/);
  await expect(delta).toBeVisible({ timeout: 10_000 });

  await page.setViewportSize({ width: 390, height: 812 });
  await expect(page.getByRole("textbox", { name: "Search characters" })).toBeVisible();
  await expect(page.getByRole("navigation").filter({ hasText: "Explore" })).toBeVisible();
});

test("create UI submits a character and shows it in My AI created tab", async ({ page }) => {
  await startSignedInAdultSession(page, "create");
  const characterName = uniqueName("Create");

  await page.goto("/create");
  await page.getByLabel("Name").fill(characterName);
  await page.getByLabel("Advanced Details").fill(
    "A complete E2E-created companion used to verify the creator and My AI loop.",
  );
  await page.getByRole("button", { name: "Generate character" }).click();

  await expect(page.getByText(`Saved ${characterName} to My AI.`)).toBeVisible({
    timeout: 20_000,
  });
  await page.locator("form").getByRole("link", { name: "My AI" }).click();
  await expect(page).toHaveURL(/\/custom/);

  await page.getByRole("button", { name: "created" }).click();
  await expect(
    page.locator('a[href^="/characters/"]').filter({ hasText: characterName }),
  ).toBeVisible({ timeout: 10_000 });
});

test("chat UI starts from character detail, sends a message, and persists history", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "chat-ui");
  const message = `hello from chat ui ${Date.now()}`;

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);

  await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toBeVisible({
    timeout: 10_000,
  });
  const reportedMessage = page.getByTestId("chat-message-user").filter({ hasText: message });
  const reportedMessageId = await reportedMessage.getAttribute("data-message-id");
  expect(reportedMessageId).toBeTruthy();
  await reportedMessage.getByRole("button", { name: "Report message" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expectContentReport("chat_message", reportedMessageId ?? "");
  await expectAssistantReplyVisible(page);

  await page.reload();
  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toBeVisible({
    timeout: 10_000,
  });
  await expectAssistantReplyVisible(page);
});

// P1-A management controls (plan §10.3): regenerate, delete message, no-memory
// toggle, and the session list drawer — all over the real chat service.
test("chat UI exposes regenerate, delete, memory toggle, and the session list", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "chat-manage");
  const message = `manage me ${Date.now()}`;

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);

  await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toBeVisible({
    timeout: 10_000,
  });
  await expectAssistantReplyVisible(page);

  // Regenerate: the single assistant bubble refreshes its content (no extra bubble).
  await page.getByTestId("chat-message-assistant").getByTestId("chat-regenerate").click();
  await expectAssistantReplyVisible(page);

  // No-memory toggle flips the header copy to the incognito explanation.
  await page.getByTestId("memory-toggle").click();
  await expect(page.getByText(/No-memory/)).toBeVisible({ timeout: 10_000 });

  // Session list drawer lists at least this conversation.
  await page.getByTestId("session-list-open").click();
  await expect(page.getByTestId("session-list-item").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Close your chats" }).click();

  // Delete the user message; it is gone after a reload (authority-layer delete).
  await page
    .getByTestId("chat-message-user")
    .filter({ hasText: message })
    .getByTestId("chat-delete-message")
    .click();
  await page.reload();
  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toHaveCount(0, {
    timeout: 10_000,
  });
});

test("generator UI explains config load failures instead of showing a fake zero balance", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "generate-config-error");
  await page.route("**/api/v1/generation/config", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { message: "Age verification required" },
      }),
    }),
  );

  await page.goto("/generate");

  await expect(page.getByText("Loading...", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Age verification required")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("0 coins", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
});

test("generator UI queues an image job and surfaces completed media in the gallery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { email } = await startSignedInAdultSession(page, "generate");
  const legacyMediaId = await seedLegacyPlaceholderMedia(email);

  await page.goto("/generate");
  const generate = page.getByRole("button", { name: "Generate" });
  await expect(generate).toBeEnabled({ timeout: 15_000 });
  await generate.click();

  await expect(page.getByText("Generation queued.")).toBeVisible({ timeout: 10_000 });
  const job = await latestImageJob(page.request);
  await drainWorker(page.request, job.id);

  await expect(page.getByText("Generation complete.")).toBeVisible({ timeout: 10_000 });
  await expectGeneratedAssetServed(page.request, job.id);
  await page.getByRole("button", { name: "Images" }).click();
  await expect(page.getByText("No images yet.")).toBeHidden({ timeout: 10_000 });
  await expect(
    page.locator(`[data-media-id="${legacyMediaId}"]`).getByTestId("gallery-media-unavailable"),
  ).toBeVisible();
  await expect(page.getByTestId("gallery-media-unavailable")).toHaveCount(1);
  await expect(page.getByTestId("gallery-media-image")).toHaveCount(1);
  await expect(page.getByTestId("gallery-media-image")).toHaveAttribute("src", /\/user-content\//);
  await expect(
    page.locator('[data-testid="gallery-media-image"][src*="card-sarah-mercer"]'),
  ).toHaveCount(0);

  const generatedCard = page
    .locator('[data-testid="gallery-media-card"]')
    .filter({ has: page.getByTestId("gallery-media-image") });
  await expect(generatedCard).toHaveCount(1);
  const generatedMediaId = await generatedCard.getAttribute("data-media-id");
  expect(generatedMediaId).toBeTruthy();
  await generatedCard.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expectContentReport("media", generatedMediaId ?? "");
});

test("generator UI queues a video job and surfaces completed video in the gallery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { email } = await startSignedInAdultSession(page, "generate-video");
  const previousFlag = await enableVideoGenerationForUser(email);

  try {
    await page.goto("/generate");
    await page.getByRole("button", { name: "Video Beta" }).click();
    const generate = page.getByRole("button", { name: "Generate" });
    await expect(generate).toBeEnabled({ timeout: 15_000 });
    await generate.click();

    await expect(page.getByText("Generation queued.")).toBeVisible({ timeout: 10_000 });
    const job = await latestGenerationJob(page.request, "video");
    await drainWorker(page.request, job.id);

    await expect(page.getByText("Generation complete.")).toBeVisible({ timeout: 10_000 });
    await expectGeneratedAssetServed(page.request, job.id, "video");
    await page.getByRole("button", { name: "Videos" }).click();
    await expect(page.getByTestId("gallery-media-video")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("gallery-media-video")).toBeVisible();
    await expect(page.getByTestId("gallery-media-video").locator("source")).toHaveAttribute(
      "src",
      /\/user-content\/.+\.mp4$/,
    );
  } finally {
    await restoreVideoGenerationFlag(previousFlag);
  }
});

test("upgrade UI activates Premium, grants dreamcoins, and unlocks prompt controls", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "upgrade");

  await page.goto("/upgrade");
  const premiumMonthly = page.locator("article").filter({ hasText: "Premium monthly" });
  await expect(premiumMonthly).toBeVisible({ timeout: 10_000 });
  await premiumMonthly.getByRole("button", { name: "Upgrade" }).click();
  await expect(
    page.getByText("Premium activated and dreamcoins granted."),
  ).toBeVisible({ timeout: 10_000 });

  await page.goto("/profile");
  await expect(page.getByText("Premium monthly")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/1,?750 dreamcoins/)).toBeVisible({ timeout: 10_000 });

  await page.goto("/generate");
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toBeEnabled({ timeout: 10_000 });
  await prompt.fill("premium e2e prompt control");
  await expect(page.getByRole("textbox", { name: "Negative Prompt" })).toBeEnabled();
});

test("community UI lists dreamers and reports user profiles", async ({ page }) => {
  await startSignedInAdultSession(page, "community-report");
  const dreamer = await seedCommunityDreamer();

  await page.goto("/community");
  const dreamerCard = page.getByTestId("community-dreamer-card").filter({ hasText: dreamer.displayName });
  await expect(dreamerCard).toBeVisible({ timeout: 10_000 });
  await dreamerCard.getByRole("button", { name: `Report user profile ${dreamer.displayName}` }).click();
  await expect(page.getByText("Profile report submitted.")).toBeVisible({ timeout: 10_000 });
  await expectContentReport("user_profile", dreamer.id);
});

test("profile UI handles redeem, referral, and language actions", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "profile");
  const code = `PROFILE${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  await seedRedeemCode(code, 300);
  const mediaId = await seedDownloadableMedia(email);
  const videoMediaId = await seedDownloadableVideoMedia(email);
  const nextName = uniqueName("profile renamed");

  await page.goto("/profile");
  await expect(page.getByText("250 dreamcoins")).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Display name").fill(nextName);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile updated.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(nextName)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("checkbox", { name: "Product updates" }).uncheck();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences updated.")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Redeem code" }).click();
  await expect(page.getByText("Enter a code.")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("textbox", { name: "Redeem code input" }).fill(code);
  await page.getByRole("button", { name: "Redeem code" }).click();
  await expect(page.getByText("Code redeemed.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("550 dreamcoins")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Referral invite ready.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/ref=DREAM-/)).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Language selector").selectOption("de");
  await page.getByRole("button", { name: "Update language" }).click();
  await expect(page.getByText("Language updated.")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Billing Portal" }).click();
  await expect(page).toHaveURL(/\/profile\?user=.*#billing$/);

  await page.goto("/profile");
  await page.getByRole("button", { name: "media", exact: true }).click();
  const mediaCard = page.locator(`[data-media-id="${mediaId}"]`);
  await expect(mediaCard).toBeVisible({ timeout: 10_000 });
  const videoCard = page.locator(`[data-media-id="${videoMediaId}"]`);
  await expect(videoCard.getByTestId("profile-media-video")).toBeVisible({ timeout: 10_000 });

  await mediaCard.getByRole("button", { name: "Report media" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expectContentReport("media", mediaId);

  await mediaCard.getByRole("button", { name: "Download media" }).click();
  await expect(page.getByText("Download started.")).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/profile$/);

  await mediaCard.getByRole("button", { name: "Delete media" }).click();
  await expect(mediaCard).toHaveCount(0, { timeout: 10_000 });
});

test("profile account management signs out sessions and deletes the account", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "profile-signout");
  await page.goto("/profile");
  await page.getByRole("button", { name: "Sign out all sessions" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await startSignedInAdultSession(page, "profile-delete");
  await page.goto("/profile");
  const deleteButton = page.getByRole("button", { name: "Delete", exact: true });
  await expect(deleteButton).toBeDisabled();
  await page.getByLabel("Delete confirmation").fill("NOPE");
  await expect(deleteButton).toBeDisabled();
  await page.getByLabel("Delete confirmation").fill("DELETE");
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(page).toHaveURL(/\/login$/);
});
