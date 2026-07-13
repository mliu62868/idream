import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnvFile } from "dotenv";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import path from "node:path";
import { mockVideoMp4Bytes } from "@idream/shared";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { localAiQueueNames } from "@/server/ai/local-pipeline";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { redeemCodeHash } from "@/server/lib/redeem-codes";
import { PrismaClient as ChatPrismaClient } from "../../../chat/generated/client/client";

loadChatEnv();
const chatPrisma = new ChatPrismaClient({
  adapter: new PrismaPg({ connectionString: chatDatabaseUrl(), max: 5 }),
});

test.beforeAll(async () => {
  await cleanupPublicE2EFixtures();
});

test.afterEach(async () => {
  await cleanupPublicE2EFixtures();
});

test.afterAll(async () => {
  await chatPrisma.$disconnect();
});

function loadChatEnv() {
  const chatEnvPath = process.cwd().endsWith(path.join("packages", "main"))
    ? path.resolve(process.cwd(), "../chat/.env")
    : path.resolve(process.cwd(), "packages/chat/.env");
  loadEnvFile({ path: chatEnvPath, override: false });
}

function chatDatabaseUrl() {
  const value = process.env.CHAT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!value) throw new Error("CHAT_DATABASE_URL or DATABASE_URL is required for chat e2e fixtures");
  return value;
}

function uniqueEmail(tag: string) {
  return `e2e-ui-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

function uniqueName(tag: string) {
  return `E2E ${tag} ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function whitePng(width: number, height: number) {
  const rows = Array.from({ length: height }, () => {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(chunk), 0);
  return Buffer.concat([length, chunk, crc]);
}

const pngCrcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = pngCrcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
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

async function seedCreatedCharacterForStatus(email: string, status: "removed" | "rejected") {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const characterId = `e2e-ui-created-appeal-${status}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const characterName = uniqueName(`Created ${status} appeal`);
  await prisma.character.create({
    data: {
      id: characterId,
      creatorId: user.id,
      name: characterName,
      age: 25,
      description: `E2E ${status} created character used to verify direct creator appeal entry.`,
      visibility: "public",
      status,
      appearance: {},
      advancedDetails: {},
    },
  });
  await prisma.characterStats.create({ data: { characterId } });
  return { characterId, characterName, userId: user.id };
}

async function seedRedeemCode(code: string, dreamcoins: number) {
  const codeHash = redeemCodeHash(code);
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

async function seedBlankProfileMedia(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const id = `e2e-ui-profile-blank-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const storageKey = `e2e/profile/${id}.png`;
  const target = resolveLocalBlobPath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, whitePng(16, 16));
  await prisma.mediaAsset.create({
    data: {
      id,
      ownerId: user.id,
      type: "image",
      url: `/user-content/${Buffer.from(id, "utf8").toString("base64url")}/content.png`,
      thumbnailUrl: null,
      storageKey,
      contentType: "image/png",
      width: 16,
      height: 16,
      prompt: "blank profile media for preview fallback regression",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { e2e: true, providerKey: storageKey, blankPreview: true },
    },
  });
  return id;
}

async function seedProfileMutedTagFixture(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const tag = await prisma.tag.upsert({
    where: { slug: "slow-burn" },
    update: { label: "Slow Burn" },
    create: {
      id: `e2e-ui-profile-tag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      slug: "slow-burn",
      label: "Slow Burn",
      category: "mood",
    },
  });
  const characterId = `e2e-ui-profile-muted-tag-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await prisma.character.create({
    data: {
      id: characterId,
      creatorId: user.id,
      name: uniqueName("profile muted tag"),
      age: 25,
      description: "seeded for Profile muted tag preferences",
      visibility: "public",
      status: "approved",
      style: "realistic",
      gender: "female",
      appearance: {},
      advancedDetails: {},
      tags: { create: { tagId: tag.id } },
      stats: {
        create: {
          chatsCount: 25,
          likesCount: 25,
          viewsCount: 25,
        },
      },
    },
  });
  return tag.slug;
}

async function seedCommunityCampaigns(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const titles = [`Community Campaign A ${suffix}`, `Community Campaign B ${suffix}`];
  for (const [index, title] of titles.entries()) {
    const mediaId = `e2e-ui-community-campaign-media-${suffix}-${index}`;
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: user.id,
        type: "image",
        url: index === 0
          ? "/images/ourdream/card-sarah-mercer.webp"
          : "/images/ourdream/promo-card-female.webp",
        thumbnailUrl: index === 0
          ? "/images/ourdream/card-sarah-mercer.webp"
          : "/images/ourdream/promo-card-female.webp",
        visibility: "unlisted",
        safetyStatus: "passed",
        metadata: { e2e: true },
      },
    });
    await prisma.mediaAssetPlacement.create({
      data: {
        id: `e2e-ui-community-campaign-placement-${suffix}-${index}`,
        mediaAssetId: mediaId,
        slot: "campaign",
        targetType: "campaign",
        targetId: `e2e-ui-community-campaign-${suffix}`,
        status: "published",
        publishedAt: new Date(Date.now() + index),
        createdById: user.id,
        metadata: {
          ctaLabel: "Open Community",
          eyebrow: "Featured",
          href: "/community",
          title,
        },
      },
    });
  }
  return { firstTitle: titles[1], secondTitle: titles[0] };
}

async function seedOwnedIdentityMedia(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const characterId = `e2e-ui-owned-gallery-character-${suffix}`;
  const mediaId = `e2e-ui-owned-gallery-media-${suffix}`;
  const storageKey = `e2e/generate/${mediaId}.png`;
  const target = resolveLocalBlobPath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/ak9zP8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await prisma.character.create({
    data: {
      id: characterId,
      creatorId: user.id,
      name: `E2E Owned Gallery ${suffix}`,
      age: 25,
      description: "Owned character used to verify Gallery identity actions.",
      visibility: "private",
      status: "approved",
      appearance: {},
      advancedDetails: {},
    },
  });
  await prisma.characterStats.create({ data: { characterId } });
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      ownerId: user.id,
      characterId,
      type: "image",
      url: `/user-content/${Buffer.from(mediaId, "utf8").toString("base64url")}/content.png`,
      thumbnailUrl: null,
      storageKey,
      contentType: "image/png",
      width: 1,
      height: 1,
      prompt: "owned character media for Gallery identity action regression",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { e2e: true, providerKey: storageKey },
    },
  });
  return { characterId, mediaId };
}

async function seedBlankGalleryMedia(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const mediaId = `e2e-ui-blank-gallery-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const storageKey = `e2e/generate/${mediaId}.png`;
  const target = resolveLocalBlobPath(storageKey);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, whitePng(16, 16));
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      ownerId: user.id,
      type: "image",
      url: `/user-content/${Buffer.from(mediaId, "utf8").toString("base64url")}/content.png`,
      thumbnailUrl: null,
      storageKey,
      contentType: "image/png",
      width: 16,
      height: 16,
      prompt: "blank gallery media for preview fallback regression",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { e2e: true, providerKey: storageKey, blankPreview: true },
    },
  });
  return mediaId;
}

async function ensureGenerationPreset(
  id: string,
  type: "background" | "pose" | "outfit" | "mode",
  label: string,
  controls: Record<string, string>,
  scope: "built_in" | "community" = "built_in",
) {
  await prisma.generationPreset.upsert({
    where: { id },
    update: {
      scope,
      type,
      label,
      controls,
      visibility: "public",
      status: "active",
    },
    create: {
      id,
      scope,
      type,
      label,
      controls,
      visibility: "public",
      status: "active",
    },
  });
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

async function seedCompletedChatImageAttachment(input: {
  email: string;
  sessionId: string;
  messageId: string;
  characterId: string;
  fixture?: "valid" | "blank";
}) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: input.email },
    select: { id: true },
  });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mediaId = `e2e-ui-chat-image-media-${suffix}`;
  const attachmentId = `e2e-ui-chat-image-attachment-${suffix}`;
  const generationJobId = `e2e-ui-chat-image-job-${suffix}`;
  const fixture = input.fixture ?? "valid";
  const storageKey = fixture === "blank" ? `e2e/chat/${mediaId}.png` : null;
  if (storageKey) {
    const target = resolveLocalBlobPath(storageKey);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, whitePng(16, 16));
  }
  const mediaUrl =
    fixture === "blank"
      ? `/user-content/${Buffer.from(mediaId, "utf8").toString("base64url")}/content.png`
      : "/images/ourdream/card-sarah-mercer.webp";
  await prisma.generationJob.create({
    data: {
      id: generationJobId,
      userId: user.id,
      characterId: input.characterId,
      mode: "image",
      controls: {},
      presetIds: [],
      outputCount: 1,
      status: "completed",
      sourceType: "chat_image",
      sourceId: attachmentId,
    },
  });
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      ownerId: user.id,
      sourceJobId: generationJobId,
      characterId: input.characterId,
      type: "image",
      url: mediaUrl,
      thumbnailUrl: fixture === "blank" ? null : mediaUrl,
      storageKey,
      contentType: fixture === "blank" ? "image/png" : "image/webp",
      width: fixture === "blank" ? 16 : 512,
      height: fixture === "blank" ? 16 : 640,
      prompt: fixture === "blank" ? "E2E blank completed chat image" : "E2E completed chat image",
      visibility: "private",
      safetyStatus: "passed",
      metadata: { e2e: true, fixture: `completed-chat-image-${fixture}` },
    },
  });
  await chatPrisma.messageAttachment.create({
    data: {
      id: attachmentId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      kind: "generated_image",
      status: "completed",
      mediaAssetId: mediaId,
      costDreamcoins: 5,
      promptHint:
        fixture === "blank"
          ? "E2E blank in-character image from this chat moment"
          : "E2E completed in-character image from this chat moment",
      width: fixture === "blank" ? 16 : 512,
      height: fixture === "blank" ? 16 : 640,
      metadata: { e2e: true, fixture: `completed-chat-image-${fixture}` },
    },
  });
  return { attachmentId, mediaId };
}

async function grantVoicePlayback(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  await prisma.entitlement.upsert({
    where: { userId_key: { userId: user.id, key: "voice_enabled" } },
    update: { value: true, source: "subscription" },
    create: { userId: user.id, key: "voice_enabled", value: true, source: "subscription" },
  });
  await prisma.entitlement.upsert({
    where: { userId_key: { userId: user.id, key: "voice_minutes" } },
    update: { value: 30, source: "subscription" },
    create: { userId: user.id, key: "voice_minutes", value: 30, source: "subscription" },
  });
  return user.id;
}

async function seedCompletedVoiceChat(email: string, characterId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const sessionId = `e2e-ui-voice-session-${suffix}`;
  const userMessageId = `e2e-ui-voice-user-${suffix}`;
  const assistantMessageId = `e2e-ui-voice-assistant-${suffix}`;
  const assistantText =
    "Here is a calm voice playback fixture for the browser. It should become playable and stay tied to this assistant turn.";
  const now = new Date();
  await chatPrisma.chatSession.create({
    data: {
      id: sessionId,
      userId: user.id,
      characterId,
      title: "Voice playback fixture",
      status: "active",
      lastMessageAt: now,
    },
  });
  await chatPrisma.message.createMany({
    data: [
      {
        id: userMessageId,
        sessionId,
        role: "user",
        content: "Read this reply aloud.",
        status: "completed",
        safetyStatus: "passed",
        createdAt: new Date(now.getTime() - 1_000),
      },
      {
        id: assistantMessageId,
        sessionId,
        role: "assistant",
        content: assistantText,
        model: "e2e-fixture",
        status: "completed",
        safetyStatus: "passed",
        createdAt: now,
      },
    ],
  });
  return { assistantMessageId, assistantText, sessionId };
}

async function seedChatDailyQuotaAtLimit(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
  await chatPrisma.chatUsage.upsert({
    where: { userId_periodStart: { userId: user.id, periodStart } },
    update: { messagesUsed: 30, periodEnd },
    create: {
      id: `e2e-ui-chat-quota-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      userId: user.id,
      messagesUsed: 30,
      periodStart,
      periodEnd,
    },
  });
  return user.id;
}

async function clearDreamcoins(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  await prisma.dreamcoinLedger.deleteMany({ where: { userId: user.id } });
  return user.id;
}

async function seedGenerationRecoveryJobs(email: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const failedJobId = `e2e-ui-generate-failed-${suffix}`;
  const blockedJobId = `e2e-ui-generate-blocked-${suffix}`;
  await prisma.generationJob.createMany({
    data: [
      {
        id: failedJobId,
        userId: user.id,
        mode: "image",
        outputCount: 1,
        status: "failed",
        costDreamcoins: 5,
        controls: {},
        presetIds: [],
        errorCode: "provider_timeout",
        createdAt: new Date(Date.now() - 2_000),
      },
      {
        id: blockedJobId,
        userId: user.id,
        mode: "image",
        outputCount: 1,
        status: "blocked",
        costDreamcoins: 5,
        controls: {},
        presetIds: [],
        errorCode: "request_blocked",
        createdAt: new Date(Date.now() - 1_000),
      },
    ],
  });
  return { blockedJobId, failedJobId };
}

function chatFsRoot() {
  const chatPackageDir = process.cwd().endsWith(path.join("packages", "main"))
    ? path.resolve(process.cwd(), "../chat")
    : path.resolve(process.cwd(), "packages/chat");
  const configuredRoot = process.env.CHAT_FS_ROOT;
  if (configuredRoot) {
    return path.isAbsolute(configuredRoot)
      ? configuredRoot
      : path.resolve(chatPackageDir, configuredRoot);
  }
  return path.resolve(chatPackageDir, "data/chat");
}

async function seedChatCompanionFiles(email: string, characterId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  const root = chatFsRoot();
  const dir = path.join(root, "mem", user.id, characterId);
  const memoryId = `mem_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const initialMemory = "User likes rainy bookstores.";
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "memory.md"),
    `- [preference] ${initialMemory} <!-- src:e2e-message mid:${memoryId} conf:0.9 -->\n`,
  );
  await writeFile(
    path.join(dir, "relationship.md"),
    [
      "---",
      "stage: close",
      "warmth: 12",
      "familiarity: 11",
      "turns: 8",
      "version: 1",
      "---",
      "",
      "## Summary",
      "They have built a warm, familiar rapport.",
      "",
    ].join("\n"),
  );
  return { initialMemory };
}

async function cleanupPublicE2EFixtures() {
  const fixtureCharacters = await prisma.character.findMany({
    where: {
      OR: [
        { id: { startsWith: "e2e-ui-" } },
        { name: { startsWith: "E2E " } },
        { name: { startsWith: "Dreamer " } },
        { description: { contains: "seeded for Explore UI filtering" } },
        { description: { contains: "used to verify community dreamer profile reporting" } },
        { creator: { is: { email: { startsWith: "e2e-ui-" } } } },
      ],
    },
    select: {
      id: true,
      creatorId: true,
    },
  });

  const now = new Date();
  const characterIds = fixtureCharacters.map((character) => character.id);
  const e2eUsers = await prisma.user.findMany({
    where: { email: { startsWith: "e2e-ui-" } },
    select: { id: true },
  });
  await cleanupChatDatabaseFixtures(e2eUsers.map((user) => user.id));
  const creatorIds = [
    ...new Set([
      ...fixtureCharacters
        .map((character) => character.creatorId)
        .filter((creatorId): creatorId is string => Boolean(creatorId)),
      ...e2eUsers.map((user) => user.id),
    ]),
  ];
  const generationJobs =
    creatorIds.length > 0
      ? await prisma.generationJob.findMany({
          where: { userId: { in: creatorIds } },
          select: { id: true },
        })
      : [];
  const mediaAssets =
    creatorIds.length > 0
      ? await prisma.mediaAsset.findMany({
          where: { ownerId: { in: creatorIds } },
          select: { id: true },
        })
      : [];
  const mediaCollections =
    creatorIds.length > 0
      ? await prisma.mediaCollection.findMany({
          where: { ownerId: { in: creatorIds } },
          select: { id: true },
        })
      : [];
  const generationJobIds = generationJobs.map((job) => job.id);
  const mediaAssetIds = mediaAssets.map((asset) => asset.id);
  const mediaCollectionIds = mediaCollections.map((collection) => collection.id);

  if (characterIds.length > 0) {
    await prisma.characterSubmission.deleteMany({
      where: { characterId: { in: characterIds } },
    });
  }

  await Promise.all(
    generationJobIds.flatMap((jobId) => [
      jobQueue.removeByDedupePrefix(`generation:${jobId}`, [...localAiQueueNames]),
      jobQueue.removeByDedupePrefix(`generation-finalize:${jobId}:`, [...localAiQueueNames]),
    ]),
  );

  const contentReportTargets = [
    ...(characterIds.length > 0 ? [{ targetId: { in: characterIds } }] : []),
    ...(mediaAssetIds.length > 0 ? [{ targetId: { in: mediaAssetIds } }] : []),
    ...(mediaCollectionIds.length > 0
      ? [{ targetId: { in: mediaCollectionIds } }, { targetId: { in: mediaCollectionIds.map((id) => `collection:${id}`) } }]
      : []),
    ...(creatorIds.length > 0
      ? [{ targetType: "user_profile", targetId: { in: creatorIds } }]
      : []),
  ];
  if (contentReportTargets.length > 0) {
    await prisma.contentReport.deleteMany({ where: { OR: contentReportTargets } });
  }

  await Promise.all(
    e2eUsers.flatMap((user) => [
      rm(path.join(chatFsRoot(), "mem", user.id), { recursive: true, force: true }),
      rm(path.join(chatFsRoot(), "sessions", user.id), { recursive: true, force: true }),
    ]),
  );

  const moderationTargets = [
    ...(characterIds.length > 0 ? [{ targetId: { in: characterIds } }] : []),
    ...(mediaAssetIds.length > 0 ? [{ targetId: { in: mediaAssetIds } }] : []),
    ...(mediaCollectionIds.length > 0
      ? [{ targetId: { in: mediaCollectionIds } }, { targetId: { in: mediaCollectionIds.map((id) => `collection:${id}`) } }]
      : []),
    ...(generationJobIds.length > 0 ? [{ targetId: { in: generationJobIds } }] : []),
  ];
  if (moderationTargets.length > 0) {
    await prisma.moderationEvent.deleteMany({ where: { OR: moderationTargets } });
  }

  if (characterIds.length > 0) {
    await prisma.character.updateMany({
      where: { id: { in: characterIds } },
      data: {
        visibility: "private",
        status: "removed",
        deletedAt: now,
      },
    });
  }

  if (creatorIds.length === 0) return;
  await prisma.productFeedbackVote.deleteMany({
    where: { userId: { in: creatorIds } },
  });
  await prisma.productFeedbackItem.deleteMany({
    where: {
      OR: [{ createdById: { in: creatorIds } }, { title: { startsWith: "E2E " } }],
    },
  });
  await prisma.analyticsEvent.deleteMany({
    where: {
      OR: [
        { userId: { in: creatorIds } },
        { anonymousId: { startsWith: "e2e-ui-" } },
      ],
    },
  });
  await prisma.user.deleteMany({
    where: {
      id: { in: creatorIds },
      email: { startsWith: "e2e-ui-" },
    },
  });
}

async function cleanupChatDatabaseFixtures(userIds: string[]) {
  if (userIds.length === 0) return;

  const sessions = await chatPrisma.chatSession.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const sessionIds = sessions.map((session) => session.id);
  if (sessionIds.length > 0) {
    const [messages, attachments] = await Promise.all([
      chatPrisma.message.findMany({
        where: { sessionId: { in: sessionIds } },
        select: { id: true },
      }),
      chatPrisma.messageAttachment.findMany({
        where: { sessionId: { in: sessionIds } },
        select: { id: true },
      }),
    ]);
    const messageIds = messages.map((message) => message.id);
    const attachmentIds = attachments.map((attachment) => attachment.id);
    const aggregateIds = [...sessionIds, ...messageIds, ...attachmentIds, ...userIds];

    if (aggregateIds.length > 0) {
      await chatPrisma.chatOutboxEvent.deleteMany({
        where: { aggregateId: { in: aggregateIds } },
      });
    }
    if (messageIds.length > 0) {
      await Promise.all([
        chatPrisma.messageVersion.deleteMany({ where: { messageId: { in: messageIds } } }),
        chatPrisma.chatModerationEvent.deleteMany({ where: { targetId: { in: messageIds } } }),
      ]);
    }
    await chatPrisma.messageAttachment.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await chatPrisma.message.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await chatPrisma.chatSession.deleteMany({ where: { id: { in: sessionIds } } });
  }

  await chatPrisma.chatUsage.deleteMany({ where: { userId: { in: userIds } } });
}

test("help desk submits a tracked support request", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "helpdesk");

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  let failFeedbackListRequest = true;
  await page.route("**/api/v1/feedback/items", async (route) => {
    if (route.request().method() !== "GET" || !failFeedbackListRequest) {
      await route.continue();
      return;
    }
    failFeedbackListRequest = false;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { message: "forced roadmap failure" } }),
    });
  });

  await page.goto("/helpdesk");
  await expect(page.getByRole("heading", { name: /get support without losing context/i })).toBeVisible();
  const feedbackListStatus = page.getByTestId("feedback-list-status");
  await expect(feedbackListStatus).toContainText("forced roadmap failure", { timeout: 10_000 });
  await expect(feedbackListStatus).toHaveAttribute("role", "alert");
  await expect(feedbackListStatus).toHaveAttribute("aria-live", "assertive");
  await feedbackListStatus.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Saved generator recipes" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(feedbackListStatus).toHaveCount(0);

  await page.getByLabel("Category").selectOption("generation");
  await page.getByLabel("Subject").fill("Generation job stuck");
  await page
    .getByTestId("helpdesk-form")
    .getByLabel("Details", { exact: true })
    .fill("The image generation job stayed queued after I refreshed the generator.");
  await page.getByRole("button", { name: /submit request/i }).click();

  await expect(page.getByTestId("helpdesk-status")).toContainText(/SUP-/);
  await expect(page.getByTestId("helpdesk-status")).toContainText(/received/i);
  await expect(page.getByTestId("helpdesk-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("helpdesk-status")).toHaveAttribute("aria-live", "polite");

  const featureTitle = uniqueName("Feature voting");
  await expect(page.getByRole("heading", { name: /vote on what should ship next/i })).toBeVisible();
  await page.getByLabel("Feedback type").selectOption("feature");
  await page.getByLabel("Feature title").fill(featureTitle);
  await page
    .getByLabel("Feature details")
    .fill("Let beta users vote on roadmap priorities from the Help Desk.");
  await page.getByRole("button", { name: /submit idea/i }).click();
  await expect(page.getByTestId("feedback-status")).toContainText(/submitted/i);
  await expect(page.getByTestId("feedback-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("feedback-status")).toHaveAttribute("aria-live", "polite");
  const featureCard = page.getByTestId("feedback-items").locator("article").filter({
    hasText: featureTitle,
  });
  await expect(featureCard).toHaveCount(1, { timeout: 10_000 });
  await expect(featureCard.getByRole("button", { name: /Voted 1/ })).toBeVisible();

  await featureCard.getByRole("button", { name: /Voted 1/ }).click();
  await expect(page.getByTestId("feedback-status")).toContainText(/Vote removed/i);
  await expect(featureCard.getByRole("button", { name: /Vote 0/ })).toBeVisible();
  await featureCard.getByRole("button", { name: /Vote 0/ }).click();
  await expect(page.getByTestId("feedback-status")).toContainText(/Vote counted/i);
  await expect(featureCard.getByRole("button", { name: /Voted 1/ })).toBeVisible();

  const appealTarget = `appeal-target-${Date.now()}`;
  await expect(page.getByRole("heading", { name: /ask for another review/i })).toBeVisible();
  await page.getByLabel("Target type").selectOption("character");
  await page.getByLabel("Target ID or link").fill(appealTarget);
  await page.getByLabel("Decision ID").fill("decision-e2e-helpdesk");
  await page
    .getByLabel("Appeal details")
    .fill("Please review this character decision again with the attached context.");
  await page.getByRole("button", { name: /submit appeal/i }).click();
  await expect(page.getByTestId("appeal-status")).toContainText(/Appeal .* submitted/);
  await expect(page.getByTestId("appeal-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("appeal-status")).toHaveAttribute("aria-live", "polite");

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const appeal = await prisma.appeal.findFirst({
    where: { userId: user.id, targetType: "character", targetId: appealTarget },
  });
  expect(appeal).toMatchObject({
    appealText: "Please review this character decision again with the attached context.",
    originalDecisionId: "decision-e2e-helpdesk",
    status: "open",
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);
});

test("help desk signup redirect preserves anonymous support request draft", async ({ page }) => {
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/helpdesk" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("helpdesk-signup-redirect");
  const subject = uniqueName("Helpdesk support redirect");
  const description =
    "The anonymous support request should preserve details through signup before creating a tracked ticket.";

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/helpdesk");
  await expect(page.getByRole("heading", { name: /get support without losing context/i })).toBeVisible();
  const supportForm = page.getByTestId("helpdesk-form");
  const supportDetails = supportForm.locator('textarea[name="description"]');
  await supportForm.getByLabel("Category").selectOption("chat");
  await supportForm.getByLabel("Subject").fill(subject);
  await supportDetails.fill(description);
  await supportForm.getByRole("button", { name: /submit request/i }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/helpdesk");

  await page.getByLabel("Display name").fill("E2E Helpdesk Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/helpdesk");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(supportForm.getByLabel("Category")).toHaveValue("chat");
  await expect(supportForm.getByLabel("Subject")).toHaveValue(subject);
  await expect(supportDetails).toHaveValue(description);
  await expect(page.getByTestId("helpdesk-status")).toContainText(/support draft was restored/i);

  await supportForm.getByRole("button", { name: /submit request/i }).click();
  await expect(page.getByTestId("helpdesk-status")).toContainText(/SUP-/);
  await expect(page.getByTestId("helpdesk-status")).toContainText(/received/i);
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("ourdream.helpdesk.supportDraft.v1")),
    )
    .toBeNull();

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const request = await prisma.supportRequest.findFirst({
    where: { userId: user.id, subject },
  });
  expect(request).toMatchObject({
    category: "chat",
    description,
    diagnosticConsent: true,
    status: "received",
  });
  expect(pageErrors).toEqual([]);
  expect(
    consoleErrors.filter(
      (message) =>
        !message.includes("favicon") && !message.includes("status of 401 (Unauthorized)"),
    ),
  ).toEqual([]);
});

test("help desk signup redirect preserves anonymous roadmap idea draft", async ({ page }) => {
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/helpdesk" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("helpdesk-feedback-signup-redirect");
  const title = uniqueName("Helpdesk roadmap redirect");
  const description =
    "The anonymous roadmap idea should preserve details through signup before submission.";

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/helpdesk");
  await expect(page.getByRole("heading", { name: /vote on what should ship next/i })).toBeVisible();
  const feedbackForm = page.getByTestId("feedback-form");
  const feedbackDetails = feedbackForm.locator('textarea[name="feedbackDescription"]');
  await feedbackForm.getByLabel("Feedback type").selectOption("improvement");
  await feedbackForm.getByLabel("Feature title").fill(title);
  await feedbackDetails.fill(description);
  await feedbackForm.getByRole("button", { name: /submit idea/i }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/helpdesk");

  await page.getByLabel("Display name").fill("E2E Helpdesk Feedback Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/helpdesk");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(feedbackForm.getByLabel("Feedback type")).toHaveValue("improvement");
  await expect(feedbackForm.getByLabel("Feature title")).toHaveValue(title);
  await expect(feedbackDetails).toHaveValue(description);
  await expect(page.getByTestId("feedback-status")).toContainText(/roadmap draft was restored/i);

  await feedbackForm.getByRole("button", { name: /submit idea/i }).click();
  await expect(page.getByTestId("feedback-status")).toContainText(/submitted/i);
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("ourdream.helpdesk.feedbackDraft.v1")),
    )
    .toBeNull();

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const item = await prisma.productFeedbackItem.findFirst({
    where: { createdById: user.id, title },
  });
  expect(item).toMatchObject({
    category: "improvement",
    description,
    status: "under_review",
    voteCount: 1,
  });
  expect(pageErrors).toEqual([]);
  expect(
    consoleErrors.filter(
      (message) =>
        !message.includes("favicon") && !message.includes("status of 401 (Unauthorized)"),
    ),
  ).toEqual([]);
});

test("help desk signup redirect applies anonymous roadmap vote intent", async ({ page }) => {
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/helpdesk" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("helpdesk-vote-signup-redirect");
  const ownerId = `e2e-ui-feedback-owner-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const itemId = `e2e-ui-feedback-vote-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const title = uniqueName("Helpdesk vote redirect");
  const description = "Anonymous voters should return from signup with this vote applied.";

  await prisma.user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@test.local`,
      emailVerified: true,
      displayName: "E2E Feedback Owner",
    },
  });
  await prisma.productFeedbackItem.create({
    data: {
      id: itemId,
      createdById: ownerId,
      title,
      description,
      category: "feature",
      status: "under_review",
      voteCount: 0,
    },
  });

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/helpdesk");
  await expect(page.getByRole("heading", { name: /vote on what should ship next/i })).toBeVisible();
  const feedbackCard = page.getByTestId("feedback-items").locator("article").filter({ hasText: title });
  await expect(feedbackCard).toBeVisible({ timeout: 10_000 });
  await feedbackCard.getByRole("button", { name: /Vote 0/ }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/helpdesk");
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("ourdream.helpdesk.pendingFeedbackVote.v1")),
    )
    .toContain(itemId);

  await page.getByLabel("Display name").fill("E2E Helpdesk Vote Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/helpdesk");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByTestId("feedback-status")).toContainText(/Vote counted/i, {
    timeout: 10_000,
  });
  const votedCard = page.getByTestId("feedback-items").locator("article").filter({ hasText: title });
  await expect(votedCard.getByRole("button", { name: /Voted 1/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("ourdream.helpdesk.pendingFeedbackVote.v1")),
    )
    .toBeNull();

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  await expect
    .poll(() =>
      prisma.productFeedbackVote.findUnique({
        where: { userId_itemId: { userId: user.id, itemId } },
      }),
    )
    .not.toBeNull();
  expect(pageErrors).toEqual([]);
  expect(
    consoleErrors.filter(
      (message) =>
        !message.includes("favicon") && !message.includes("status of 401 (Unauthorized)"),
    ),
  ).toEqual([]);
});

test("help desk signup redirect preserves anonymous appeal draft", async ({ page }) => {
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/helpdesk" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("helpdesk-appeal-signup-redirect");
  const targetId = `appeal-signup-target-${Date.now()}`;
  const decisionId = `decision-signup-${Date.now()}`;
  const appealText =
    "The anonymous appeal should preserve target and context through signup before submission.";

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/helpdesk");
  await expect(page.getByRole("heading", { name: /ask for another review/i })).toBeVisible();
  const appealForm = page.getByTestId("appeal-form");
  const appealDetails = appealForm.locator('textarea[name="appealText"]');
  await appealForm.getByLabel("Target type").selectOption("media");
  await appealForm.getByLabel("Target ID or link").fill(targetId);
  await appealForm.getByLabel("Decision ID").fill(decisionId);
  await appealDetails.fill(appealText);
  await appealForm.getByRole("button", { name: /submit appeal/i }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/helpdesk");

  await page.getByLabel("Display name").fill("E2E Helpdesk Appeal Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/helpdesk");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(appealForm.getByLabel("Target type")).toHaveValue("media");
  await expect(appealForm.getByLabel("Target ID or link")).toHaveValue(targetId);
  await expect(appealForm.getByLabel("Decision ID")).toHaveValue(decisionId);
  await expect(appealDetails).toHaveValue(appealText);
  await expect(page.getByTestId("appeal-status")).toContainText(/appeal draft was restored/i);

  await appealForm.getByRole("button", { name: /submit appeal/i }).click();
  await expect(page.getByTestId("appeal-status")).toContainText(/Appeal .* submitted/);
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("ourdream.helpdesk.appealDraft.v1")),
    )
    .toBeNull();

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const appeal = await prisma.appeal.findFirst({
    where: { userId: user.id, targetType: "media", targetId },
  });
  expect(appeal).toMatchObject({
    appealText,
    originalDecisionId: decisionId,
    status: "open",
  });
  expect(pageErrors).toEqual([]);
  expect(
    consoleErrors.filter(
      (message) =>
        !message.includes("favicon") && !message.includes("status of 401 (Unauthorized)"),
    ),
  ).toEqual([]);
});

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
  // Zero out prior e2e dreamers' stats so scores never accumulate across runs. The old
  // approach (topScore + offset) grew the score ~1.5M every run and eventually overflowed
  // character_stats.likesCount (INT4). A bounded constant (real seed data tops out well
  // under 1M) keeps this freshly seeded dreamer the top-ranked one without unbounded growth.
  await prisma.characterStats.deleteMany({
    where: { character: { creatorId: { startsWith: "e2e-ui-dreamer-" } } },
  });

  const id = `e2e-ui-dreamer-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const characterId = `${id}-character`;
  const score = 1_000_000 + Math.floor(Math.random() * 1_000);
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
  return { id, displayName, characterId };
}

async function seedFeedCollection() {
  const ownerId = `e2e-ui-feed-collection-owner-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mediaId = `${ownerId}-media`;
  const collectionId = `${ownerId}-collection`;
  const name = uniqueName("Feed Collection");
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@test.local`,
      emailVerified: true,
      displayName: "Feed Collection Creator",
    },
  });
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      ownerId,
      type: "image",
      url: "/images/ourdream/card-alexa-reeves.webp",
      thumbnailUrl: "/images/ourdream/card-alexa-reeves.webp",
      prompt: "feed collection public preview",
      visibility: "public_pack",
      safetyStatus: "passed",
      metadata: { e2e: true },
    },
  });
  await prisma.mediaCollection.create({
    data: {
      id: collectionId,
      ownerId,
      name,
      visibility: "public",
      items: { create: { mediaAssetId: mediaId, sortOrder: 0 } },
    },
  });
  return { id: collectionId, itemId: `collection:${collectionId}`, name };
}

async function seedExploreCharacters(token: string) {
  const creatorId = `e2e-ui-explore-creator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const otherCreatorId = `e2e-ui-explore-other-creator-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await prisma.user.create({
    data: {
      id: creatorId,
      email: `${creatorId}@test.local`,
      emailVerified: true,
      displayName: "Explore Creator",
    },
  });
  await prisma.user.create({
    data: {
      id: otherCreatorId,
      email: `${otherCreatorId}@test.local`,
      emailVerified: true,
      displayName: "Explore Other Creator",
    },
  });
  const romantic = await prisma.tag.upsert({
    where: { slug: "romantic" },
    update: { label: "Romantic", category: "mood" },
    create: { id: `e2e-ui-romantic-${Date.now()}`, slug: "romantic", label: "Romantic", category: "mood" },
  });
  const specs = [
    {
      suffix: "alpha",
      name: `${token} Alpha`,
      age: 22,
      chats: 300,
      gender: "female",
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      suffix: "beta",
      name: `${token} Beta`,
      age: 30,
      chats: 200,
      gender: "female",
      createdAt: "2026-03-01T00:00:00Z",
    },
    {
      suffix: "gamma",
      name: `${token} Gamma`,
      age: 38,
      chats: 100,
      gender: "female",
      createdAt: "2026-06-01T00:00:00Z",
    },
    {
      suffix: "delta",
      name: `${token} Delta`,
      age: 30,
      chats: 400,
      gender: "male",
      createdAt: "2026-05-01T00:00:00Z",
    },
  ];
  const ids: Record<string, string> = {};
  for (const spec of specs) {
    const id = `e2e-ui-explore-${spec.suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    ids[spec.suffix] = id;
    await prisma.character.create({
      data: {
        id,
        creatorId: spec.suffix === "delta" ? otherCreatorId : creatorId,
        name: spec.name,
        age: spec.age,
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
  return { ...ids, creatorId, otherCreatorId } as {
    alpha: string;
    beta: string;
    gamma: string;
    delta: string;
    creatorId: string;
    otherCreatorId: string;
  };
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
    return asset;
  }

  const header = bytes.subarray(0, 12).toString("hex");
  const looksLikeImage =
    header.startsWith("89504e47") ||
    header.startsWith("ffd8ff") ||
    header.startsWith("47494638") ||
    header.startsWith("52494646");
  expect(looksLikeImage, `${asset.url} did not return decodable image bytes`).toBeTruthy();
  return asset;
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

async function generateAndConfirmCharacterIdentity(page: Page) {
  await page.getByRole("button", { name: "Generate preview candidates" }).click();
  const candidates = page.getByTestId("create-preview-candidates").locator("button");
  for (let attempt = 0; attempt < 16; attempt += 1) {
    if ((await candidates.count()) === 4) break;
    const worker = await page.request.post("/api/internal/worker", {
      headers: { authorization: `Bearer ${internalToken()}` },
      timeout: 90_000,
    });
    expect(worker.ok(), await worker.text()).toBeTruthy();
    await page.waitForTimeout(350);
  }
  await expect(candidates).toHaveCount(4, { timeout: 20_000 });
  await page.getByTestId("create-confirm-identity").click();
  await expect(page.getByText("Identity confirmed. This is how the character will look.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("create-next")).toBeEnabled();
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
  const follow = await page.request.post(`/api/v1/users/${ids.creatorId}/follow`);
  expect(follow.ok(), await follow.text()).toBeTruthy();

  await page.goto(`/?q=${encodeURIComponent(token)}&limit=2`);
  const alpha = page.locator(`a[href="/characters/${ids.alpha}"]`);
  const beta = page.locator(`a[href="/characters/${ids.beta}"]`);
  const gamma = page.locator(`a[href="/characters/${ids.gamma}"]`);
  const delta = page.locator(`a[href="/characters/${ids.delta}"]`);

  await expect(alpha).toBeVisible({ timeout: 10_000 });
  await expect(beta).toBeVisible({ timeout: 10_000 });
  await expect(alpha).toContainText("Explore Creator");
  await expect(beta).toContainText("Explore Creator");
  await expect(alpha).not.toContainText("@ourdream");
  await expect(gamma).toHaveCount(0);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(gamma).toBeVisible({ timeout: 10_000 });

  await expect(page.getByRole("button", { name: "Sort characters" })).toContainText("For You");
  await page.getByRole("button", { name: "Sort characters" }).click();
  await page.getByRole("menuitem", { name: "Newest" }).click();
  await expect(page).toHaveURL(/sort=newest/);
  await expect(gamma).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Sort characters" }).click();
  await page.getByRole("menuitem", { name: "Popular · Month" }).click();
  await expect(page).toHaveURL(/sort=popular/);
  await expect(alpha).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Sort characters" }).click();
  await page.getByRole("menuitem", { name: "Following" }).click();
  await expect(page).toHaveURL(/sort=following/);
  await expect(alpha).toBeVisible({ timeout: 10_000 });
  await expect(beta).toBeVisible({ timeout: 10_000 });
  await expect(delta).toHaveCount(0);

  await page.getByRole("button", { name: "Sort characters" }).click();
  await page.getByRole("menuitem", { name: "For You" }).click();
  await expect(page).not.toHaveURL(/sort=following/);

  await page.getByRole("combobox", { name: "Gender filter" }).selectOption("male");
  await expect(page).toHaveURL(/gender=male/);
  await expect(delta).toBeVisible({ timeout: 10_000 });
  await expect(gamma).toHaveCount(0);

  await expect(page.getByRole("button", { name: "Romantic" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Group Chats" })).toHaveCount(0);
  await page.getByRole("button", { name: "Romantic" }).click();
  await expect(page).toHaveURL(/tags=romantic/);
  await expect(delta).toBeVisible({ timeout: 10_000 });

  await page.goto(`/?q=${encodeURIComponent(token)}&gender=any&age_min=25&age_max=34&limit=4`);
  await expect(page.getByRole("combobox", { name: "Age filter" })).toHaveValue("25-34");
  await expect(beta).toBeVisible({ timeout: 10_000 });
  await expect(delta).toBeVisible({ timeout: 10_000 });
  await expect(alpha).toHaveCount(0);
  await expect(gamma).toHaveCount(0);

  await page.getByRole("combobox", { name: "Age filter" }).selectOption("35+");
  await expect(page).toHaveURL(/age_min=35/);
  await expect(gamma).toBeVisible({ timeout: 10_000 });
  await expect(beta).toHaveCount(0);
  await expect(delta).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 812 });
  await expect(page.getByRole("textbox", { name: "Search characters" })).toBeVisible();
  await expect(page.getByRole("navigation").filter({ hasText: "Explore" })).toBeVisible();
});

test("explore character grid exposes retryable load errors and empty results", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "explore-grid-status");
  const token = `E2E Empty ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  let allowCharacters = false;

  await page.route("**/api/v1/characters?**", async (route) => {
    if (!allowCharacters) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { message: "forced character grid failure" },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/?q=${encodeURIComponent(token)}&gender=any`);

  const status = page.getByTestId("character-grid-status");
  await expect(status).toContainText("Could not load characters.", { timeout: 10_000 });
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toHaveAttribute("aria-live", "assertive");

  allowCharacters = true;
  await status.getByRole("button", { name: "Retry" }).click();

  await expect(status).toContainText("No characters found", { timeout: 10_000 });
  await expect(status).toHaveAttribute("role", "status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toContainText(
    "Try another search term, clear a category, or switch the gender, style, and age filters.",
  );

  const staleToken = `E2E Stale ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  const seeded = await seedExploreCharacters(staleToken);
  await page.goto(`/?q=${encodeURIComponent(staleToken)}&gender=any&limit=2`);
  const staleCharacter = page.locator(`a[href="/characters/${seeded.alpha}"]`);
  await expect(staleCharacter).toBeVisible({ timeout: 10_000 });

  allowCharacters = false;
  await page
    .locator('input[aria-label="Search characters"][placeholder^="Try"]')
    .fill(`E2E Missing ${Date.now()} ${Math.floor(Math.random() * 1e6)}`);

  await expect(status).toContainText("Could not load characters.", { timeout: 10_000 });
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toHaveAttribute("aria-live", "assertive");
  await expect(staleCharacter).toHaveCount(0);
});

test("mobile explore keeps bottom nav fixed and cards unobscured", async ({ page }) => {
  await startSignedInAdultSession(page, "mobile-explore");
  await page.setViewportSize({ width: 390, height: 812 });
  const token = `E2E Mobile ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  const ids = await seedExploreCharacters(token);

  await page.goto(`/?q=${encodeURIComponent(token)}&gender=any&limit=4`);
  const bottomNav = page.getByRole("navigation", { name: "Primary mobile navigation" });
  await expect(bottomNav).toBeVisible({ timeout: 10_000 });
  await expect(bottomNav).toHaveCSS("position", "fixed");

  for (const [label, href] of [
    ["Explore", "/"],
    ["Chat", "/chat"],
    ["Create", "/create"],
    ["Generate", "/generate"],
  ] as const) {
    await expect(bottomNav.getByRole("link", { name: label })).toHaveAttribute("href", href);
  }
  await expect(bottomNav.getByRole("link", { name: "Explore" })).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );

  for (const name of ["Gender filter", "Style filter", "Age filter"] as const) {
    const box = await page.getByRole("combobox", { name }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }

  const cards = [ids.delta, ids.alpha, ids.beta, ids.gamma].map((id) =>
    page.locator(`a[href="/characters/${id}"]`),
  );
  for (const card of cards) await expect(card).toBeVisible({ timeout: 10_000 });

  const firstRowBoxes = await Promise.all([cards[0].boundingBox(), cards[1].boundingBox()]);
  expect(firstRowBoxes[0]).not.toBeNull();
  expect(firstRowBoxes[1]).not.toBeNull();
  expect(Math.abs(firstRowBoxes[0]!.y - firstRowBoxes[1]!.y)).toBeLessThan(8);
  expect(firstRowBoxes[1]!.x).toBeGreaterThan(firstRowBoxes[0]!.x + firstRowBoxes[0]!.width * 0.8);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await cards[3].scrollIntoViewIfNeeded();
  const [lastCardBox, navBox] = await Promise.all([cards[3].boundingBox(), bottomNav.boundingBox()]);
  expect(lastCardBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(lastCardBox!.y + lastCardBox!.height).toBeLessThanOrEqual(navBox!.y - 4);

  await bottomNav.getByRole("link", { name: "Generate" }).click();
  await expect(page).toHaveURL(/\/generate$/);
  await expect(bottomNav.getByRole("link", { name: "Generate" })).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
});

test("mobile app shell menu exposes the full product navigation", async ({ page }) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/generate" },
  });
  await page.setViewportSize({ width: 390, height: 812 });

  await page.goto("/generate");
  const menuButton = page.getByRole("button", { name: "Open navigation menu" });
  await expect(menuButton).toBeVisible({ timeout: 10_000 });
  await menuButton.click();

  const appNavigation = page.getByRole("navigation", { name: "App navigation" });
  await expect(appNavigation).toBeVisible();

  for (const [label, href] of [
    ["Feed", "/feed"],
    ["Community", "/community"],
    ["Profile", "/profile"],
    ["Upgrade", "/upgrade"],
  ] as const) {
    await expect(appNavigation.getByRole("link", { name: label })).toHaveAttribute("href", href);
  }

  await appNavigation.getByRole("link", { name: "Community" }).click();
  await expect(page).toHaveURL(/\/community$/);
});

test("mobile explore menu shares the full product navigation", async ({ page }) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/" },
  });
  await page.setViewportSize({ width: 390, height: 812 });

  await page.goto("/");
  const menuButton = page.getByRole("button", { name: "Open navigation menu" });
  await expect(menuButton).toBeVisible({ timeout: 10_000 });
  await menuButton.click();

  const appNavigation = page.getByRole("navigation", { name: "App navigation" });
  await expect(appNavigation).toBeVisible();

  for (const [label, href] of [
    ["Safety Center", "/safety/introduction"],
    ["More", "/resources-hub"],
    ["Profile", "/profile"],
    ["Upgrade", "/upgrade"],
  ] as const) {
    await expect(appNavigation.getByRole("link", { name: label })).toHaveAttribute("href", href);
  }
});

test("explore eagerly loads above-the-fold character and promo images", async ({ page }) => {
  await startSignedInAdultSession(page, "explore-lcp");
  const lcpWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Largest Contentful Paint")) {
      lcpWarnings.push(message.text());
    }
  });

  await page.goto("/");
  await expect.poll(() => page.locator('a[href^="/characters/"]').count(), {
    timeout: 10_000,
  }).toBeGreaterThanOrEqual(10);
  await expect(page.locator('img[src*="promo-card-female"]')).toBeVisible();

  const imageLoading = await page.evaluate(() => {
    const characterImages = Array.from(
      document.querySelectorAll<HTMLImageElement>('a[href^="/characters/"] img'),
    )
      .slice(0, 10)
      .map((image) => image.getAttribute("loading"));
    const promoImage = document.querySelector<HTMLImageElement>(
      'img[src*="promo-card-female"]',
    );
    return {
      characterImages,
      promoImage: promoImage?.getAttribute("loading") ?? null,
    };
  });

  expect(imageLoading.characterImages).toEqual([
    "eager",
    "eager",
    "eager",
    "eager",
    "eager",
    "eager",
    "eager",
    "eager",
    "eager",
    "eager",
  ]);
  expect(imageLoading.promoImage).toBe("eager");
  expect(lcpWarnings).toEqual([]);
});

test("global header search routes app pages into Explore results", async ({ page }) => {
  await startSignedInAdultSession(page, "global-search");
  const token = `E2E Global Search ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  const ids = await seedExploreCharacters(token);

  await page.goto("/generate?characterId=melissa-burke");
  const globalSearch = page.getByRole("searchbox", {
    name: "Search characters, guides, and generators",
  });
  await expect(globalSearch).toBeVisible();

  await globalSearch.fill(token);
  await globalSearch.press("Enter");

  await expect.poll(() => new URL(page.url()).pathname).toBe("/");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(token);
  await expect(page.locator(`a[href="/characters/${ids.alpha}"]`)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(`a[href="/characters/${ids.beta}"]`)).toBeVisible({
    timeout: 10_000,
  });
});

test("global header search suggestions open character detail", async ({ page }) => {
  await startSignedInAdultSession(page, "global-search-suggestions");
  const token = `E2E Search Suggest ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  const ids = await seedExploreCharacters(token);

  await page.goto("/generate?characterId=melissa-burke");
  const globalSearch = page.getByRole("searchbox", {
    name: "Search characters, guides, and generators",
  });
  await expect(globalSearch).toBeVisible();

  await globalSearch.fill(`${token} Alpha`);
  await expect(page.getByRole("listbox", { name: "Search suggestions" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("option", { name: `Open ${token} Alpha` })).toBeVisible();

  await globalSearch.press("ArrowDown");
  await globalSearch.press("Enter");

  await expect.poll(() => new URL(page.url()).pathname).toBe(`/characters/${ids.alpha}`);
});

test("global header search suggestions open guide routes", async ({ page }) => {
  await startSignedInAdultSession(page, "global-search-route-suggestions");

  await page.goto("/generate?characterId=melissa-burke");
  const globalSearch = page.getByRole("searchbox", {
    name: "Search characters, guides, and generators",
  });
  await expect(globalSearch).toBeVisible();

  await globalSearch.fill("character cards");
  await expect(page.getByRole("listbox", { name: "Search suggestions" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("option", { name: "Open Character Cards" })).toBeVisible();

  await globalSearch.press("ArrowDown");
  await globalSearch.press("Enter");

  await expect.poll(() => new URL(page.url()).pathname).toBe("/guides/character-cards");
  await expect(page.getByRole("heading", { name: "Character Cards", exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test("global header search suggestions expose empty status semantics", async ({ page }) => {
  await startSignedInAdultSession(page, "global-search-empty-status");

  await page.goto("/generate?characterId=melissa-burke");
  const globalSearch = page.getByRole("searchbox", {
    name: "Search characters, guides, and generators",
  });
  await expect(globalSearch).toBeVisible();

  const query = `zz no suggestions ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  await globalSearch.fill(query);
  await expect(page.getByRole("listbox", { name: "Search suggestions" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(globalSearch).toHaveAttribute("aria-describedby", "app-search-status");
  await expect(page.getByTestId("app-search-status")).toHaveText("No suggestions found");
  await expect(page.getByTestId("app-search-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("app-search-status")).toHaveAttribute("aria-live", "polite");
});

test("global header signup redirect returns anonymous generator intent", async ({
  page,
}) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/generate" },
  });
  const email = uniqueEmail("generate-signup-redirect");

  await page.goto("/generate");
  await expect(page.getByText("Balance", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  const joinFree = page.locator("header").getByRole("link", { name: "Join Free" });
  await expect(joinFree).toHaveAttribute("href", "/signup?next=%2Fgenerate");
  await joinFree.click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/generate");
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Generate Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate" })).toBeVisible({
    timeout: 10_000,
  });
});

test("global header login redirect returns existing user to generator intent", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "generate-login-redirect");
  const logout = await page.request.post("/api/v1/auth/logout");
  expect(logout.ok(), await logout.text()).toBeTruthy();

  await page.goto("/generate?characterId=melissa-burke");
  await expect(page.getByText("Balance", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue("melissa-burke", {
    timeout: 10_000,
  });

  const login = page.getByRole("link", { name: "Login" });
  await expect(login).toHaveAttribute(
    "href",
    "/login?next=%2Fgenerate%3FcharacterId%3Dmelissa-burke",
  );
  await login.click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    "/generate?characterId=melissa-burke",
  );
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Login" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  expect(new URL(page.url()).searchParams.get("characterId")).toBe("melissa-burke");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue("melissa-burke", {
    timeout: 10_000,
  });
});

test("generate preset signup redirect preserves anonymous preset draft", async ({ page }) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/generate" },
  });
  await ensureGenerationPreset("seed-preset-background-studio", "background", "Studio", {
    background: "studio",
    lighting: "cinematic",
  });
  const email = uniqueEmail("generate-preset-signup-redirect");
  const presetLabel = uniqueName("Generate preset signup redirect");

  await page.goto("/generate");
  await expect(page.getByTestId("my-presets")).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Background").selectOption("seed-preset-background-studio");
  await page.getByTestId("my-presets").getByLabel("Preset name").fill(presetLabel);
  await page.getByTestId("my-presets").getByRole("button", { name: "Save" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/generate");
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Generate Preset Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByText("Preset draft restored. Save it to add it to My Presets.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("my-presets").getByLabel("Preset name")).toHaveValue(presetLabel);
  await expect(page.getByLabel("Background")).toHaveValue("seed-preset-background-studio");
  await page.getByTestId("my-presets").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(`Saved preset "${presetLabel}".`)).toBeVisible({ timeout: 10_000 });

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const savedPreset = await prisma.generationPreset.findFirst({
    where: { ownerId: user.id, label: presetLabel },
    select: { controls: true },
  });
  expect(savedPreset?.controls).toEqual(
    expect.objectContaining({ backgroundPresetId: "seed-preset-background-studio" }),
  );
});

test("create signup redirect returns anonymous draft to the builder", async ({ page }) => {
  await page.request.post("/api/v1/age-gate/accept", { data: { sourcePath: "/create" } });
  const characterName = uniqueName("Create signup redirect");
  const email = uniqueEmail("create-signup-redirect");

  await page.goto("/create");
  await expect(page.getByTestId("create-step-identity")).toBeVisible();
  await page.getByLabel("Name").fill(characterName);
  await page.getByTestId("create-next").click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/create");
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Create Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/create");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByTestId("create-step-identity")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue(characterName);
});

test("create UI walks the multi-step builder and shows the character in My AI", async ({ page }) => {
  test.setTimeout(120_000);
  await startSignedInAdultSession(page, "create");
  const characterName = uniqueName("Create");

  await page.goto("/create");
  // Step 1 — Identity
  await expect(page.getByTestId("create-step-identity")).toBeVisible();
  await page.getByLabel("Name").fill(characterName);
  await page.getByTestId("create-next").click();
  // Step 2 — Appearance
  await expect(page.getByTestId("create-step-appearance")).toBeVisible();
  await page.getByTestId("create-next").click();
  // Step 3 — Personality
  await expect(page.getByTestId("create-step-personality")).toBeVisible();
  await page.getByLabel("Advanced Details").fill(
    "A complete E2E-created companion used to verify the creator and My AI loop.",
  );
  await page.getByTestId("create-next").click();
  // Step 4 — Preview requires an explicit identity confirmation before Publish unlocks.
  await expect(page.getByTestId("create-step-preview")).toBeVisible();
  await expect(page.getByTestId("create-next")).toBeDisabled();
  await generateAndConfirmCharacterIdentity(page);
  await page.getByTestId("create-next").click();
  // Step 5 — Publish (private => approved, saved to My AI)
  await expect(page.getByTestId("create-step-publish")).toBeVisible();
  await page.getByTestId("create-submit").click();

  await expect(page.getByText(`Saved ${characterName} to My AI.`)).toBeVisible({
    timeout: 20_000,
  });
  // Use the create-success CTA (in the wizard <section>), not the sidebar nav link of the same name.
  await page.locator("section").getByRole("link", { name: "My AI" }).click();
  await expect(page).toHaveURL(/\/custom/);

  await page.getByRole("button", { name: "created" }).click();
  const createdCard = page.locator('a[href^="/characters/"]').filter({ hasText: characterName });
  await expect(createdCard).toBeVisible({ timeout: 10_000 });
  const originalHref = await createdCard.first().getAttribute("href");
  expect(originalHref).toBeTruthy();
  const originalCard = page.locator(`a[href="${originalHref}"]`);
  const originalShell = originalCard.locator("xpath=..");
  const editedName = `${characterName} Edited`;
  const editedDescription = "Edited from My AI to verify created-character management.";

  await originalShell.getByRole("button", { name: "Edit character" }).click();
  const editForm = originalShell.getByTestId("character-edit-form");
  await expect(editForm).toBeVisible();
  await editForm.getByRole("textbox", { name: "Character name" }).fill(editedName);
  await editForm.getByRole("textbox", { name: "Character description" }).fill(editedDescription);
  await editForm.getByRole("button", { name: "Save character edit" }).click();
  await expect(page.getByText("Character updated.")).toBeVisible({ timeout: 10_000 });
  await expect(originalCard).toContainText(editedName, { timeout: 10_000 });
  await expect(originalCard).toContainText(editedDescription, { timeout: 10_000 });

  await originalShell.getByRole("button", { name: "Duplicate character" }).click();
  await expect(page.getByText("Character duplicated to your created tab.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.locator('a[href^="/characters/"]').filter({ hasText: `${editedName} Copy` }),
  ).toBeVisible({ timeout: 10_000 });

  await originalShell.getByRole("button", { name: "Publish" }).click();
  await expect(
    page.getByText("Submitted for review — public characters go live after approval."),
  ).toBeVisible({ timeout: 10_000 });
  await expect(originalShell.getByText("pending review", { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  await originalShell.getByRole("button", { name: "Delete character" }).click();
  await expect(page.getByText("Press Confirm delete to remove this character.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(originalCard).toBeVisible();

  await originalShell.getByRole("button", { name: "Confirm delete character" }).click();
  await expect(page.getByText("Character deleted.")).toBeVisible({ timeout: 10_000 });
  await expect(originalCard).toHaveCount(0, { timeout: 10_000 });
});

test("created removed character links to a prefilled Help Desk appeal", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "created-appeal");
  const { characterId, characterName, userId } = await seedCreatedCharacterForStatus(email, "removed");
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/custom");
  await page.getByRole("button", { name: "created" }).click();
  const createdCard = page.locator('a[href^="/characters/"]').filter({ hasText: characterName });
  await expect(createdCard).toBeVisible({ timeout: 10_000 });
  const characterShell = createdCard.locator("xpath=..");
  await expect(characterShell.getByText("removed", { exact: true })).toBeVisible();

  const appealLink = characterShell.getByRole("link", {
    name: `Appeal decision for ${characterName}`,
  });
  await expect(appealLink).toBeVisible();
  const href = await appealLink.getAttribute("href");
  expect(href).toContain("/helpdesk?");
  const appealUrl = new URL(href ?? "", "http://127.0.0.1");
  expect(appealUrl.searchParams.get("appealTargetId")).toBe(characterId);

  await appealLink.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/helpdesk");
  expect(new URL(page.url()).hash).toBe("#appeals");

  const appealForm = page.getByTestId("appeal-form");
  await expect(appealForm.getByLabel("Target type")).toHaveValue("character");
  await expect(appealForm.getByLabel("Target ID or link")).toHaveValue(characterId);
  await expect(appealForm.getByLabel("Appeal details")).toHaveValue(
    new RegExp(`Please review this character decision again\\. Character: ${escapeRegExp(characterName)}\\.`),
  );
  await expect(page.getByTestId("appeal-status")).toContainText(/prefilled from your selected item/i);

  await appealForm.getByRole("button", { name: /submit appeal/i }).click();
  await expect(page.getByTestId("appeal-status")).toContainText(/Appeal .* submitted/);

  const appeal = await prisma.appeal.findFirst({
    where: { userId, targetType: "character", targetId: characterId },
  });
  expect(appeal).toMatchObject({
    appealText: `Please review this character decision again. Character: ${characterName}.`,
    status: "open",
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);
});

test("create UI resumes a draft and submits public characters for review", async ({ page }) => {
  test.setTimeout(120_000);
  await startSignedInAdultSession(page, "create-review");
  const characterName = uniqueName("Create review");

  await page.goto("/create");
  await expect(page.getByTestId("create-step-identity")).toBeVisible();
  await page.getByLabel("Name").fill(characterName);
  await page.getByLabel("Age").fill("17");
  await page.getByTestId("create-next").click();
  await expect(page.getByTestId("create-status")).toHaveText("Age must be between 18 and 99.");
  await expect(page.getByTestId("create-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("create-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("create-step-identity")).toBeVisible();

  await page.getByLabel("Age").fill("24");
  await page.getByTestId("create-next").click();
  await expect(page.getByTestId("create-step-appearance")).toBeVisible({ timeout: 10_000 });

  await page.reload();
  await expect(page.getByTestId("create-step-appearance")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: characterName })).toBeVisible();

  await page.getByLabel("Appearance").fill("editorial portrait lighting with a confident smile");
  await page.getByTestId("create-next").click();
  await expect(page.getByTestId("create-step-personality")).toBeVisible({ timeout: 10_000 });
  await page.getByLabel("Advanced Details").fill(
    "A public review submission that verifies failed preview recovery and pending review UX.",
  );
  await page.getByTestId("create-next").click();
  await expect(page.getByTestId("create-step-preview")).toBeVisible({ timeout: 10_000 });

  await page.route("**/api/v1/character-drafts/**/preview", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "provider_unavailable", message: "Preview service unavailable." },
      }),
    });
  });
  await page.getByRole("button", { name: "Generate preview" }).click();
  await expect(page.getByText("Preview failed. Your draft is saved; retry before publishing.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Preview service unavailable.")).toBeVisible();
  await expect(page.getByTestId("create-next")).toBeDisabled();
  await expect(page.getByTestId("create-step-publish")).toHaveCount(0);

  await page.unroute("**/api/v1/character-drafts/**/preview");
  await generateAndConfirmCharacterIdentity(page);
  await page.getByTestId("create-next").click();
  const publishStep = page.getByTestId("create-step-publish");
  await expect(publishStep).toBeVisible({ timeout: 10_000 });
  await publishStep.getByRole("button", { name: "public" }).click();
  await page.getByTestId("create-submit").click();
  await expect(
    page.getByText(`${characterName} submitted for review. Public characters go live after approval.`),
  ).toBeVisible({ timeout: 20_000 });

  await page.getByRole("link", { name: "View in My AI" }).click();
  await expect(page).toHaveURL(/\/custom/);
  await page.getByRole("button", { name: "created" }).click();
  const createdCard = page.locator('a[href^="/characters/"]').filter({ hasText: characterName });
  await expect(createdCard).toBeVisible({ timeout: 10_000 });
  await expect(createdCard.locator("xpath=..").getByText("pending review", { exact: true })).toBeVisible();
});

test("character detail signup redirect returns anonymous chat intent to the character", async ({
  page,
}) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/characters/melissa-burke" },
  });
  const email = uniqueEmail("character-signup-redirect");

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Chat" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/characters/melissa-burke");
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Character Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
});

test("character detail like signup redirect returns anonymous intent and persists", async ({
  page,
}) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/characters/melissa-burke" },
  });
  const email = uniqueEmail("character-like-signup-redirect");

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  const detailActions = page.getByTestId("character-detail-actions");
  await detailActions.getByRole("button", { name: "Like" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/characters/melissa-burke");
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Character Like Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("character-detail-actions").getByRole("button", { name: "Like" }).click();
  await expect(
    page.getByTestId("character-detail-actions").getByRole("button", { name: "Liked" }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Character liked.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("character-detail-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("character-detail-status")).toHaveAttribute(
    "aria-live",
    "polite",
  );

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  await expect
    .poll(() =>
      prisma.characterLike.findUnique({
        where: { userId_characterId: { userId: user.id, characterId: "melissa-burke" } },
      }),
    )
    .not.toBeNull();

  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
    timeout: 10_000,
  });
  const likedProfileCard = page.locator('a[href="/characters/melissa-burke"]').filter({
    hasText: "Melissa Burke",
  });
  await expect(likedProfileCard).toHaveCount(1, { timeout: 10_000 });
  await expect(likedProfileCard.locator("img")).toHaveAttribute("loading", "eager");
});

test("character detail generate signup redirect preserves character intent", async ({
  page,
}) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/characters/melissa-burke" },
  });
  const email = uniqueEmail("character-generate-signup-redirect");

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });

  const detailActions = page.getByTestId("character-detail-actions");
  const generateLink = detailActions.getByRole("link", { name: "Generate" });
  await expect(generateLink).toHaveAttribute("href", "/generate?characterId=melissa-burke");
  await generateLink.click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  expect(new URL(page.url()).searchParams.get("characterId")).toBe("melissa-burke");
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue("melissa-burke", {
    timeout: 10_000,
  });

  const joinFree = page.locator("header").getByRole("link", { name: "Join Free" });
  await expect(joinFree).toHaveAttribute(
    "href",
    "/signup?next=%2Fgenerate%3FcharacterId%3Dmelissa-burke",
  );
  await joinFree.click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    "/generate?characterId=melissa-burke",
  );

  await page.getByLabel("Display name").fill("E2E Character Generate Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  expect(new URL(page.url()).searchParams.get("characterId")).toBe("melissa-burke");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue("melissa-burke", {
    timeout: 10_000,
  });
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

  const messageInput = page.getByRole("textbox", { name: "Message", exact: true });
  const sendButton = page.getByRole("button", { name: "Send message" });
  await expect(sendButton).toBeDisabled();
  await messageInput.fill("   ");
  await expect(sendButton).toBeDisabled();
  await messageInput.fill(message);
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toBeVisible({
    timeout: 10_000,
  });
  const reportedMessage = page.getByTestId("chat-message-user").filter({ hasText: message });
  const reportedMessageId = await reportedMessage.getAttribute("data-message-id");
  expect(reportedMessageId).toBeTruthy();
  await reportedMessage.getByRole("button", { name: "Report message" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("chat-session-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("chat-session-status")).toHaveAttribute("aria-live", "polite");
  await expectContentReport("chat_message", reportedMessageId ?? "");
  await expectAssistantReplyVisible(page);

  await page.reload();
  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toBeVisible({
    timeout: 10_000,
  });
  await expectAssistantReplyVisible(page);
});

test("chat UI opens Generate with character context and renders chat image attachments", async ({
  page,
}) => {
  const { email } = await startSignedInAdultSession(page, "chat-image-ui");
  const characterId = "melissa-burke";
  const message = `please make an image from this chat ${Date.now()}`;

  await page.goto(`/characters/${characterId}`);
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  const sessionId = new URL(page.url()).pathname.split("/").pop() ?? "";
  expect(sessionId).toBeTruthy();

  const headerGenerate = page.getByTestId("chat-generate-link");
  await expect(headerGenerate).toHaveAttribute("href", `/generate?characterId=${characterId}`);
  await headerGenerate.click();
  await expect(page).toHaveURL(new RegExp(`/generate\\?characterId=${characterId}$`), {
    timeout: 10_000,
  });
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue(characterId, {
    timeout: 10_000,
  });
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/chat/${sessionId}`);

  await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toBeVisible({
    timeout: 10_000,
  });
  await expectAssistantReplyVisible(page);
  const assistantBubble = page.getByTestId("chat-message-assistant");
  const assistantMessageId = await assistantBubble.getAttribute("data-message-id");
  expect(assistantMessageId).toBeTruthy();

  const { mediaId } = await seedCompletedChatImageAttachment({
    email,
    sessionId,
    messageId: assistantMessageId ?? "",
    characterId,
  });
  await page.reload();

  const completedImage = page.getByTestId("chat-image-attachment");
  await expect(completedImage).toBeVisible({ timeout: 10_000 });
  await expect(completedImage).toHaveAttribute("src", /card-sarah-mercer\.webp/);
  await expect(completedImage).toHaveAttribute("alt", /Generated image:/);
  await expect(assistantBubble.getByRole("button", { name: "More like this" })).toBeVisible();
  await expect(assistantBubble.getByRole("button", { name: "Looks like them" })).toBeVisible();
  await expect(assistantBubble.getByRole("button", { name: "Doesn't match" })).toBeVisible();
  await expect(assistantBubble.getByRole("button", { name: "Use for identity" })).toHaveCount(0);
  await assistantBubble.getByRole("button", { name: "Looks like them" }).click();
  await expect(page.getByText("Thanks — this image looks like the character.")).toBeVisible();
  const feedbackUser = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  await expect
    .poll(() =>
      prisma.generationFeedback.findFirst({
        where: {
          actorId: feedbackUser.id,
          mediaAssetId: mediaId,
          dimension: "identity",
          value: "match",
          active: true,
        },
      }),
    )
    .not.toBeNull();

  await seedCompletedChatImageAttachment({
    email,
    sessionId,
    messageId: assistantMessageId ?? "",
    characterId,
    fixture: "blank",
  });
  await page.reload();
  await expect(assistantBubble.getByTestId("chat-image-preview-fallback")).toContainText(
    "Preview unavailable",
    { timeout: 10_000 },
  );
  await expect(assistantBubble.getByTestId("chat-image-attachment")).toHaveCount(1);
  await expect(assistantBubble.getByRole("button", { name: "More like this" })).toHaveCount(2);

  await assistantBubble.getByRole("button", { name: "More like this" }).first().click();
  await expect(page.getByText("Variation queued. It will appear in Generate and Gallery.")).toBeVisible({
    timeout: 10_000,
  });
  const variationJob = await prisma.generationJob.findFirstOrThrow({
    where: {
      sourceMeta: { path: ["sourceMediaId"], equals: mediaId },
      sourceType: "media_variation",
    },
    orderBy: { createdAt: "desc" },
  });
  expect(variationJob.characterId).toBe(characterId);
  expect(variationJob.userId).toBe(
    (await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } })).id,
  );
  expect(variationJob.prompt).toContain("More like this image:");
  expect(variationJob.momentSpec).toBeTruthy();
  expect(variationJob.referenceSetRevisionId).toBeTruthy();
  expect(variationJob.referenceManifest).not.toBeNull();

  const attachmentGenerate = assistantBubble.getByRole("link", { name: "Open in Generate" }).first();
  await expect(attachmentGenerate).toHaveAttribute("href", `/generate?characterId=${characterId}`);
  await attachmentGenerate.click();
  await expect(page).toHaveURL(new RegExp(`/generate\\?characterId=${characterId}$`), {
    timeout: 10_000,
  });
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue(characterId, {
    timeout: 10_000,
  });
});

test("chat hub signup redirect returns anonymous user to the hub", async ({ page }) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/chat" },
  });
  const email = uniqueEmail("chat-hub-signup-redirect");

  await page.goto("/chat");
  const authPanel = page.getByTestId("chat-hub-auth-required");
  await expect(authPanel).toBeVisible({ timeout: 10_000 });
  await expect(authPanel.getByRole("heading", { name: "Sign in to see your chats" })).toBeVisible();
  await expect(authPanel.getByRole("link", { name: "Log in" })).toHaveAttribute(
    "href",
    "/login?next=%2Fchat",
  );
  await expect(authPanel.getByRole("link", { name: "Join free" })).toHaveAttribute(
    "href",
    "/signup?next=%2Fchat",
  );
  const startPanel = page.getByTestId("chat-hub-start-panel");
  await expect(startPanel).toBeVisible();
  await expect(startPanel.getByRole("link", { name: "Chat with Melissa Burke" })).toHaveAttribute(
    "href",
    "/characters/melissa-burke",
  );
  await expect(startPanel.getByRole("link", { name: "Explore characters" })).toHaveAttribute(
    "href",
    "/",
  );
  await expect(startPanel.getByRole("link", { name: "Create private character" })).toHaveAttribute(
    "href",
    "/create",
  );
  await authPanel.getByRole("link", { name: "Join free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/chat");

  await page.getByLabel("Display name").fill("E2E Chat Hub Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your chats" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("heading", { name: "No chats yet" })).toBeVisible();
  await expect(page.getByTestId("chat-hub-start-panel")).toBeVisible();
  await expect(page.getByTestId("chat-hub-character-card")).toHaveCount(3);
});

test("chat hub exposes retryable load errors as an assertive alert", async ({ page }) => {
  await startSignedInAdultSession(page, "chat-hub-load-error");
  let failSessionsRequest = true;
  await page.route("**/api/v1/chat/sessions", (route) => {
    if (!failSessionsRequest) {
      void route.continue();
      return;
    }
    failSessionsRequest = false;
    void route.fulfill({
      body: JSON.stringify({ ok: false, error: { message: "forced chat hub failure" } }),
      contentType: "application/json",
      status: 500,
    });
  });

  await page.goto("/chat");
  const status = page.getByTestId("chat-hub-status");
  await expect(status).toContainText("Couldn't load your chats", { timeout: 10_000 });
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toHaveAttribute("aria-live", "assertive");

  await status.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "No chats yet" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("chat-hub-start-panel")).toBeVisible();
});

test("chat session deep links prompt anonymous users to log back in", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "chat-session-auth-return");

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  const sessionPath = new URL(page.url()).pathname;
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: 10_000,
  });

  await page.context().clearCookies();
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: sessionPath },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  await page.goto(sessionPath);

  const authPanel = page.getByTestId("chat-session-auth-required");
  await expect(authPanel).toBeVisible({ timeout: 10_000 });
  await expect(authPanel.getByRole("heading", { name: "Log in to continue this chat" })).toBeVisible();
  await expect(authPanel.getByRole("link", { name: "Log in" })).toHaveAttribute(
    "href",
    `/login?next=${encodeURIComponent(sessionPath)}`,
  );
  await expect(authPanel.getByRole("link", { name: "Join free" })).toHaveAttribute(
    "href",
    "/signup?next=%2Fchat",
  );
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
  await expect(page.getByText("Chat unavailable")).toHaveCount(0);

  await authPanel.getByRole("link", { name: "Log in" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe(sessionPath);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Login" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe(sessionPath);
  const me = await page.request.get("/api/v1/me");
  const body = await me.json();
  expect(body.data.user?.email).toBe(email);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test("chat UI preserves input and shows upgrade path at the free daily limit", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "chat-quota");
  await seedChatDailyQuotaAtLimit(email);
  const draft = `quota draft ${Date.now()}`;

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  const sessionPath = new URL(page.url()).pathname;

  const messageInput = page.getByRole("textbox", { name: "Message", exact: true });
  await messageInput.fill(draft);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText("Daily free message limit reached.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("chat-session-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("chat-session-status")).toHaveAttribute("aria-live", "polite");
  const upgradeLink = page.getByRole("link", { name: "Upgrade for unlimited messages" });
  await expect(upgradeLink).toBeVisible();
  await expect(upgradeLink).toHaveAttribute(
    "href",
    `/upgrade?returnTo=${encodeURIComponent(sessionPath)}`,
  );
  await expect(messageInput).toHaveValue(draft);
  await expect(page.getByTestId("chat-message-user").filter({ hasText: draft })).toHaveCount(0);

  await upgradeLink.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/upgrade");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(sessionPath);
  const premiumMonthly = page.locator("article").filter({ hasText: "Premium monthly" });
  await expect(premiumMonthly).toBeVisible({ timeout: 10_000 });
  await premiumMonthly.getByRole("button", { name: "Demo upgrade" }).click();
  await expect(
    page.getByText("Premium monthly is active. 1,500 dreamcoins were added."),
  ).toBeVisible({ timeout: 10_000 });
  const continueChat = page
    .getByTestId("upgrade-checkout-result")
    .getByRole("link", { name: "Continue chat" });
  await expect(continueChat).toBeVisible();
  await expect(continueChat).toHaveAttribute("href", sessionPath);
  await continueChat.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(sessionPath);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test("chat UI plays assistant voice clips for entitled users", async ({ page }) => {
  await page.addInitScript(() => {
    const originalPause = window.HTMLMediaElement.prototype.pause;
    window.HTMLMediaElement.prototype.play = function play() {
      window.dispatchEvent(
        new CustomEvent("e2e-audio-play", { detail: { src: this.currentSrc || this.src } }),
      );
      return Promise.resolve();
    };
    window.HTMLMediaElement.prototype.pause = function pause() {
      window.dispatchEvent(
        new CustomEvent("e2e-audio-pause", { detail: { src: this.currentSrc || this.src } }),
      );
      return originalPause.call(this);
    };
  });
  const { email } = await startSignedInAdultSession(page, "chat-voice");
  const characterId = "melissa-burke";
  const userId = await grantVoicePlayback(email);
  const { assistantMessageId, assistantText, sessionId } = await seedCompletedVoiceChat(
    email,
    characterId,
  );

  await page.goto(`/chat/${sessionId}`);
  const assistantBubble = page.getByTestId("chat-message-assistant").filter({
    hasText: assistantText,
  });
  await expect(assistantBubble).toBeVisible({ timeout: 10_000 });
  await expect(assistantBubble).toHaveAttribute("data-message-id", assistantMessageId);

  const playButton = assistantBubble.getByRole("button", { name: "Play voice" });
  await expect(playButton).toBeVisible();
  await playButton.click();
  const stopButton = assistantBubble.getByRole("button", { name: "Stop voice" });
  await expect(stopButton).toBeVisible({ timeout: 30_000 });
  await expect(stopButton).toHaveAttribute("data-state", "playing");
  await expect(stopButton).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => {
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          ownerId: userId,
          type: "voice",
          deletedAt: null,
          metadata: { path: ["messageId"], equals: assistantMessageId },
        },
        select: { contentType: true, metadata: true, url: true },
      });
      return asset
        ? {
            contentType: asset.contentType,
            cost: (asset.metadata as { costDreamcoins?: number }).costDreamcoins,
            url: asset.url,
          }
        : null;
    }, { timeout: 10_000 })
    .toMatchObject({
      contentType: expect.stringMatching(/^audio\//),
      cost: 0,
      url: expect.stringContaining("/api/v1/media/"),
    });
});

// P1-A management controls (plan §10.3): edit latest user turn, regenerate,
// delete message, no-memory toggle, and the session list drawer — all over the
// real chat service.
test("chat UI exposes edit, regenerate, delete, memory toggle, and the session list", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "chat-manage");
  const message = `manage me ${Date.now()}`;
  const editedMessage = `edited chat turn ${Date.now()}`;

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

  // Edit the latest user turn; the paired assistant bubble regenerates in place.
  const userBubble = page.getByTestId("chat-message-user").filter({ hasText: message });
  await userBubble.getByTestId("chat-edit-message").click();
  await page.getByTestId("chat-edit-input").fill(editedMessage);
  await page.getByTestId("chat-save-edit").click();
  await expect(page.getByTestId("chat-message-user").filter({ hasText: editedMessage })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("chat-message-user").filter({ hasText: message })).toHaveCount(0);
  await expectAssistantReplyVisible(page);

  // Regenerate: the single assistant bubble refreshes its content (no extra bubble).
  await page.getByTestId("chat-message-assistant").getByTestId("chat-regenerate").click();
  await expectAssistantReplyVisible(page);

  // No-memory toggle flips the header copy to the incognito explanation.
  await page.getByTestId("memory-toggle").click();
  await expect(page.getByText(/No-memory: this character won't read/)).toBeVisible({
    timeout: 10_000,
  });

  // Session list drawer lists at least this conversation.
  await page.getByTestId("session-list-open").click();
  await expect(page.getByTestId("session-list-item").first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Close your chats" }).click();

  // Delete the user message only after explicit confirmation; the first click
  // arms the row but must not remove the persisted message.
  const editedBubbleBeforeConfirm = page
    .getByTestId("chat-message-user")
    .filter({ hasText: editedMessage });
  await editedBubbleBeforeConfirm.getByTestId("chat-delete-message").click();
  await expect(page.getByText("Press Confirm delete to remove this message.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    editedBubbleBeforeConfirm.getByRole("button", { name: "Confirm delete message" }),
  ).toBeVisible();
  await page.reload();
  const editedBubbleAfterFirstClick = page
    .getByTestId("chat-message-user")
    .filter({ hasText: editedMessage });
  await expect(editedBubbleAfterFirstClick).toBeVisible({ timeout: 10_000 });
  await editedBubbleAfterFirstClick.getByTestId("chat-delete-message").click();
  await editedBubbleAfterFirstClick
    .getByRole("button", { name: "Confirm delete message" })
    .click();
  await page.reload();
  await expect(page.getByTestId("chat-message-user").filter({ hasText: editedMessage })).toHaveCount(0, {
    timeout: 10_000,
  });
});

test("chat session drawer renames, archives, and redirects after deleting the current chat", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "chat-session-drawer");
  const renamedTitle = `Renamed chat ${Date.now()}`;

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);

  let failDrawerRequest = true;
  await page.route("**/api/v1/chat/sessions", async (route) => {
    if (!failDrawerRequest) {
      await route.continue();
      return;
    }
    failDrawerRequest = false;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { message: "forced drawer failure" } }),
    });
  });

  await page.getByTestId("session-list-open").click();
  const drawerStatus = page.getByTestId("chat-drawer-status");
  await expect(drawerStatus).toContainText("Couldn't load your chats.", { timeout: 10_000 });
  await expect(drawerStatus).toHaveAttribute("role", "alert");
  await expect(drawerStatus).toHaveAttribute("aria-live", "assertive");
  await drawerStatus.getByRole("button", { name: "Retry" }).click();

  const sessionRow = page.getByTestId("session-list-item").first();
  await expect(sessionRow).toBeVisible({ timeout: 10_000 });

  await sessionRow.getByTestId("session-rename").click();
  await sessionRow.getByRole("textbox", { name: "Rename chat" }).fill(renamedTitle);
  await sessionRow.getByRole("textbox", { name: "Rename chat" }).press("Enter");
  await expect(sessionRow.getByText(renamedTitle)).toBeVisible({ timeout: 10_000 });

  await sessionRow.getByTestId("session-archive").click();
  await expect(sessionRow.getByText("Archived")).toBeVisible({ timeout: 10_000 });

  await sessionRow.getByTestId("session-delete").click();
  await expect(sessionRow.getByRole("button", { name: "Confirm delete chat" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(sessionRow).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  await sessionRow.getByRole("button", { name: "Confirm delete chat" }).click();
  await expect(page).toHaveURL(/\/chat$/, { timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Your chats" })).toBeVisible({
    timeout: 10_000,
  });
});

test("chat memory panel edits memories, deletes memories, and resets relationship state", async ({
  page,
}) => {
  const { email } = await startSignedInAdultSession(page, "chat-memory-panel");
  const { initialMemory } = await seedChatCompanionFiles(email, "melissa-burke");
  const editedMemory = "User likes late-night jazz.";

  await page.goto("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  await expect(page.getByTestId("relationship-badge")).toContainText("Close", {
    timeout: 10_000,
  });

  let failMemoryRequest = true;
  await page.route("**/api/v1/chat/memories?**", async (route) => {
    if (!failMemoryRequest) {
      await route.continue();
      return;
    }
    failMemoryRequest = false;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { message: "forced memory failure" } }),
    });
  });

  await page.getByTestId("memory-panel-open").click();
  const memoryStatus = page.getByTestId("memory-panel-status");
  await expect(memoryStatus).toContainText("Couldn't load memories.", { timeout: 10_000 });
  await expect(memoryStatus).toHaveAttribute("role", "alert");
  await expect(memoryStatus).toHaveAttribute("aria-live", "assertive");
  await memoryStatus.getByRole("button", { name: "Retry" }).click();

  const memoryItem = page.getByTestId("memory-item").filter({ hasText: initialMemory });
  await expect(memoryItem).toBeVisible({ timeout: 10_000 });

  await memoryItem.getByTestId("memory-edit").click();
  await page.getByRole("textbox", { name: "Edit memory" }).fill(editedMemory);
  await page.getByTestId("memory-save").click();
  const editedItem = page.getByTestId("memory-item").filter({ hasText: editedMemory });
  await expect(editedItem).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(initialMemory)).toHaveCount(0);

  await editedItem.getByTestId("memory-delete").click();
  await expect(editedItem.getByRole("button", { name: "Confirm delete memory" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(editedItem).toBeVisible();
  await editedItem.getByRole("button", { name: "Confirm delete memory" }).click();
  await expect(editedItem).toHaveCount(0, { timeout: 10_000 });
  await expect(memoryStatus).toContainText(
    "No memories yet. As you chat, important details will show up here.",
  );
  await expect(memoryStatus).toHaveAttribute("role", "status");
  await expect(memoryStatus).toHaveAttribute("aria-live", "polite");

  await page.getByTestId("relationship-reset").click();
  await expect(page.getByRole("button", { name: "Confirm reset relationship" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("relationship-badge")).toContainText("Close");
  await page.getByRole("button", { name: "Confirm reset relationship" }).click();
  await page.getByRole("button", { name: "Close memory settings" }).click();
  await expect(page.getByTestId("relationship-badge")).toContainText("Getting to know each other", {
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

  // On config-load failure the balance area shows a clear retry affordance (not a
  // permanent "Loading..." and not a fake "0 coins"), plus the underlying error message.
  await expect(page.getByText("Couldn't load generator. Retry.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Age verification required")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
  await expect(page.getByText("0 coins", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
});

test("generator UI blocks insufficient-balance requests with an upgrade path", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "generate-low-balance");
  await clearDreamcoins(email);
  const returnTarget = "/generate?characterId=lola-moonstruck";

  await page.goto(returnTarget);

  const insufficientBalance = page.getByTestId("generator-insufficient-balance");
  await expect(insufficientBalance).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue("lola-moonstruck");
  await expect(insufficientBalance).toContainText("Need 5 coins");
  await expect(insufficientBalance).toContainText("you have 0");
  await expect(insufficientBalance).toHaveAttribute(
    "href",
    `/upgrade?returnTo=${encodeURIComponent(returnTarget)}`,
  );
  await expect(insufficientBalance.getByText("Get coins")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
});

test("mobile generator keeps queued job feedback in view after submit", async ({ page }) => {
  await startSignedInAdultSession(page, "mobile-generate-scroll");
  await page.setViewportSize({ width: 390, height: 812 });

  await page.goto("/generate?characterId=melissa-burke");
  const generate = page.getByRole("button", { name: "Generate" });
  await expect(generate).toBeEnabled({ timeout: 45_000 });
  await generate.scrollIntoViewIfNeeded();
  await generate.click();

  const jobCard = page.getByTestId("generator-job-card").first();
  await expect(jobCard).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      async () => {
        const [box, viewport] = await Promise.all([
          jobCard.boundingBox(),
          page.evaluate(() => ({ height: window.innerHeight })),
        ]);
        return Boolean(box && box.y >= 0 && box.y < viewport.height);
      },
      { timeout: 5_000 },
    )
    .toBe(true);
});

test("generator UI explains failed and blocked job recovery states", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "generate-recovery-states");
  const { blockedJobId, failedJobId } = await seedGenerationRecoveryJobs(email);

  await page.goto("/generate");

  const failedCard = page.locator(`[data-generation-job-id="${failedJobId}"]`);
  await expect(failedCard).toBeVisible({ timeout: 45_000 });
  await expect(failedCard).toContainText("Failed: provider_timeout");
  await expect(failedCard.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(failedCard).toContainText(
    "Provider hiccup — your coins were refunded. Retry will reserve the normal cost again.",
  );

  const blockedCard = page.locator(`[data-generation-job-id="${blockedJobId}"]`);
  await expect(blockedCard).toBeVisible({ timeout: 10_000 });
  await expect(blockedCard).toContainText("Blocked: request_blocked");
  await expect(blockedCard.getByRole("button", { name: "Retry" })).toHaveCount(0);
  const helpLink = blockedCard.getByRole("link", { name: "Get help" });
  await expect(helpLink).toBeVisible();
  await expect(helpLink).toHaveAttribute("href", "/helpdesk");
});

test("generator Image Edit queues a variation from a gallery source", async ({ page }) => {
  test.setTimeout(120_000);
  const { email } = await startSignedInAdultSession(page, "generate-image-edit");
  const sourceMediaId = await seedDownloadableMedia(email);

  await page.goto("/generate");
  const imageEdit = page.getByRole("button", { name: "Image Edit" });
  await expect(imageEdit).toBeVisible({ timeout: 45_000 });
  await imageEdit.click();

  const panel = page.getByTestId("image-edit-panel");
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const createEdit = page.getByRole("button", { name: "Create edit" });
  await expect(createEdit).toBeDisabled();

  const sourceCard = panel.locator(`[data-media-id="${sourceMediaId}"]`);
  await expect(sourceCard).toBeVisible({ timeout: 10_000 });
  await sourceCard.click();
  await expect(sourceCard).toHaveAttribute("aria-pressed", "true");
  await expect(createEdit).toBeEnabled({ timeout: 10_000 });

  await createEdit.click();
  await expect(page.getByText("Image edit queued.")).toBeVisible({ timeout: 10_000 });
  const job = await latestImageJob(page.request);
  const stored = await prisma.generationJob.findUniqueOrThrow({
    where: { id: job.id },
    select: {
      outputCount: true,
      sourceId: true,
      sourceMeta: true,
      sourceType: true,
    },
  });
  expect(stored.outputCount).toBe(1);
  expect(stored.sourceType).toBe("media_variation");
  expect(stored.sourceId).toContain(`media:${sourceMediaId}:variation:`);
  expect(stored.sourceMeta).toMatchObject({ sourceMediaId });

  await drainWorker(page.request, job.id);
  await expect(page.getByText("Generation complete.")).toBeVisible({ timeout: 10_000 });
});

test("generator Gallery replaces tiny completed media with a preview fallback", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "generate-tiny-media");
  const { mediaId: tinyMediaId } = await seedOwnedIdentityMedia(email);
  const blankMediaId = await seedBlankGalleryMedia(email);

  await page.goto("/generate");
  for (const mediaId of [tinyMediaId, blankMediaId]) {
    const mediaCard = page.locator(`[data-media-id="${mediaId}"]`);
    await expect(mediaCard).toBeVisible({ timeout: 10_000 });
    await expect(mediaCard.getByTestId("gallery-media-preview-fallback")).toContainText(
      "Preview unavailable",
    );
    await expect(mediaCard.getByTestId("gallery-media-image")).toHaveCount(0);
    await expect(mediaCard.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(mediaCard.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
    await expect(mediaCard.getByRole("button", { name: "Report" })).toBeVisible();
  }
});

test("generator UI queues an image job and surfaces completed media in the gallery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { email } = await startSignedInAdultSession(page, "generate");
  const publicCharacter = await seedCommunityDreamer();
  const legacyMediaId = await seedLegacyPlaceholderMedia(email);
  await page.addInitScript(() => {
    window.open = function () {
      return {
        opener: null,
        location: { href: "" },
        close: () => undefined,
      } as Window;
    };
  });

  await page.goto(`/generate?characterId=${publicCharacter.characterId}`);
  const generate = page.getByRole("button", { name: "Generate" });
  // Generate enables once generator config (balance/models) loads. The standalone server
  // can be slow to serve the first /generate after a heavy suite run on a shared machine
  // (the page loads in ~3s in isolation); allow generous slack so this isn't flaky.
  await expect(generate).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Video", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Videos", exact: true })).toHaveCount(0);
  await generate.click();

  await expect(page.getByText("Generation queued.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("generator-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("generator-status")).toHaveAttribute("aria-live", "polite");
  const job = await latestImageJob(page.request);
  await drainWorker(page.request, job.id);

  await expect(page.getByText("Generation complete.")).toBeVisible({ timeout: 10_000 });
  const completedAsset = await expectGeneratedAssetServed(page.request, job.id);
  const latestResults = page.getByTestId("generator-latest-results");
  await expect(latestResults).toBeVisible({ timeout: 10_000 });
  await expect(latestResults.getByRole("button", { name: "Looks like them" })).toBeVisible();
  await expect(latestResults.getByRole("button", { name: "Doesn't look like them" })).toBeVisible();
  await expect(latestResults.getByRole("button", { name: "More like this" })).toBeVisible();
  await expect(latestResults.getByRole("button", { name: "Create a new moment" })).toBeVisible();
  await latestResults.getByRole("button", { name: "Looks like them" }).click();
  await expect(page.getByText("Recorded: looks like the character.")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Images" }).click();
  await expect(page.getByText("No images yet.")).toBeHidden({ timeout: 10_000 });
  await expect(
    page.locator(`[data-media-id="${legacyMediaId}"]`).getByTestId("gallery-media-unavailable"),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="gallery-media-image"][src*="card-sarah-mercer"]'),
  ).toHaveCount(0);
  const legacyMediaCard = page.locator(`[data-media-id="${legacyMediaId}"]`);
  await legacyMediaCard.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Press Confirm delete to remove this media.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(legacyMediaCard).toBeVisible();
  await legacyMediaCard.getByRole("button", { name: "Confirm delete media" }).click();
  await expect(page.getByText("Media deleted.")).toBeVisible({ timeout: 10_000 });
  await expect(legacyMediaCard).toHaveCount(0, { timeout: 10_000 });

  const generatedCard = page.locator(`[data-media-id="${completedAsset.id}"]`);
  await expect(generatedCard).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      async () =>
        (await generatedCard.getByTestId("gallery-media-image").count()) +
        (await generatedCard.getByTestId("gallery-media-preview-fallback").count()),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  const generatedMediaId = completedAsset.id;
  const generatedMediaCard = page.locator(`[data-media-id="${generatedMediaId}"]`);
  await expect(generatedMediaCard.getByRole("button", { name: "Use as character image" })).toHaveCount(0);
  await expect(generatedMediaCard.getByRole("button", { name: "Add to identity" })).toHaveCount(0);
  await expect(generatedMediaCard.getByRole("button", { name: "Looks like character" })).toBeVisible();
  await expect(generatedMediaCard.getByRole("button", { name: "Doesn't match character" })).toBeVisible();
  await expect(generatedMediaCard.getByRole("button", { name: "Create variation" })).toBeVisible();
  await generatedMediaCard.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expectContentReport("media", generatedMediaId ?? "");

  await generatedMediaCard.getByRole("button", { name: "Download" }).click();
  await expect(page.getByText("Download started.")).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(new RegExp(`/generate\\?characterId=${publicCharacter.characterId}$`));

  const ownedIdentityMedia = await seedOwnedIdentityMedia(email);
  await page.getByRole("button", { name: "Liked" }).click();
  await page.getByRole("button", { name: "Images" }).click();
  const ownedMediaCard = page.locator(`[data-media-id="${ownedIdentityMedia.mediaId}"]`);
  await expect(ownedMediaCard).toBeVisible({ timeout: 10_000 });
  await expect(ownedMediaCard.getByTestId("gallery-media-preview-fallback")).toContainText(
    "Preview unavailable",
  );
  await expect(ownedMediaCard.getByTestId("gallery-media-image")).toHaveCount(0);
  await expect(ownedMediaCard.getByRole("button", { name: "Use as character image" })).toBeVisible();
  await expect(ownedMediaCard.getByRole("button", { name: "Add to identity" })).toBeVisible();
  await expect(ownedMediaCard.getByRole("button", { name: "Save as Look" })).toBeVisible();
  await expect(ownedMediaCard.getByRole("button", { name: "Create variation" })).toBeVisible();
  await ownedMediaCard.getByRole("button", { name: "Save as Look" }).click();
  await page.getByRole("textbox", { name: "Look name" }).fill("E2E Rainy Day");
  await page
    .getByRole("textbox", { name: "Look styling description" })
    .fill("Cream trench coat, loosely pinned curls, amber umbrella");
  await page.getByRole("button", { name: "Save Look" }).click();
  await expect(page.getByText("Look saved. You can reuse it for this character.")).toBeVisible();
  await expect
    .poll(() =>
      prisma.characterLook.findFirst({
        where: {
          characterId: ownedIdentityMedia.characterId,
          label: "E2E Rainy Day",
          status: "active",
        },
      }),
    )
    .not.toBeNull();

  await generatedMediaCard.getByRole("button", { name: "Like", exact: true }).click();
  await page.getByRole("button", { name: "Liked" }).click();
  const likedCard = page.locator(`[data-media-id="${generatedMediaId}"]`);
  await expect(likedCard).toBeVisible({ timeout: 10_000 });
  await expect(likedCard.getByRole("button", { name: "Unlike" })).toBeVisible();

  await page.getByTestId("gallery-manage-toggle").click();
  await likedCard.getByRole("button", { name: "Select media" }).click();
  await expect(page.getByTestId("gallery-bulk-toolbar").getByText("1 selected")).toBeVisible();
  await page.getByRole("button", { name: "Make private" }).click();
  await expect(page.getByText("Updated 1 item.")).toBeVisible({ timeout: 10_000 });

  await likedCard.getByRole("button", { name: "Select media" }).click();
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByText("Press Confirm delete selected to delete 1 item.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(likedCard).toBeVisible();
  await page.getByRole("button", { name: "Confirm delete selected" }).click();
  await expect(page.getByText("Deleted 1 item.")).toBeVisible({ timeout: 10_000 });
  await expect(likedCard).toHaveCount(0, { timeout: 10_000 });
});

test("generator UI queues a video job and surfaces completed video in the gallery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { email } = await startSignedInAdultSession(page, "generate-video");
  const previousFlag = await enableVideoGenerationForUser(email);

  try {
    await page.goto("/generate");
    await page.getByRole("button", { name: "Video", exact: true }).click();
    const generate = page.getByRole("button", { name: "Generate" });
    // Generous slack: generator config can be slow to serve under full-suite load (see image test).
    await expect(generate).toBeEnabled({ timeout: 45_000 });
    await generate.click();

    await expect(page.getByText("Generation queued.")).toBeVisible({ timeout: 30_000 });
    const job = await latestGenerationJob(page.request, "video");
    await drainWorker(page.request, job.id);

    await expect(page.getByText("Generation complete.")).toBeVisible({ timeout: 30_000 });
    await expectGeneratedAssetServed(page.request, job.id, "video");
    await page.getByRole("button", { name: "Videos" }).click();
    await expect(page.getByTestId("gallery-media-video")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("gallery-media-video")).toBeVisible();
    await expect(page.getByTestId("gallery-media-video").locator("source")).toHaveAttribute(
      "src",
      /\/user-content\/.+\.mp4$/,
    );
  } finally {
    await restoreVideoGenerationFlag(previousFlag);
  }
});

test("generator user-preset round-trip and bulk media route are wired", async ({ page }) => {
  await startSignedInAdultSession(page, "presets");
  const ctx = page.request;
  const presetLabel = `E2E Studio Look ${Date.now()}`;
  await ensureGenerationPreset("seed-preset-mode-realistic", "mode", "Realistic", {
    style: "realistic",
  });
  await ensureGenerationPreset("seed-preset-background-studio", "background", "Studio", {
    background: "studio",
    lighting: "cinematic",
  });
  const communityBackgroundId = `e2e-community-background-${Date.now()}`;
  await ensureGenerationPreset(
    communityBackgroundId,
    "background",
    "Community Neon Rooftop",
    {
      background: "neon rooftop",
      lighting: "pink skyline",
    },
    "community",
  );

  try {
    await page.goto("/generate");
    await expect(page.getByTestId("my-presets")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("Mode preset")).toBeVisible();
    const backgroundSelect = page.getByTestId("preset-select-background");
    await expect(backgroundSelect.locator(`option[value="${communityBackgroundId}"]`)).toHaveText(
      "Community · Community Neon Rooftop",
    );
    await backgroundSelect.selectOption(communityBackgroundId);
    await expect(backgroundSelect).toHaveValue(communityBackgroundId);
    await page.getByLabel("Mode preset").selectOption("seed-preset-mode-realistic");
    await backgroundSelect.selectOption("seed-preset-background-studio");
    await page.getByTestId("my-presets").getByLabel("Preset name").fill(presetLabel);
    await page.getByTestId("my-presets").getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(`Saved preset "${presetLabel}".`)).toBeVisible({ timeout: 10_000 });

    const presetItem = page.getByTestId("my-preset-item").filter({ hasText: presetLabel });
    await expect(presetItem).toBeVisible({ timeout: 10_000 });
    await presetItem.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText(`Applied preset "${presetLabel}".`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByLabel("Mode preset")).toHaveValue("seed-preset-mode-realistic");
    await expect(page.getByLabel("Background")).toHaveValue("seed-preset-background-studio");

    const list = await ctx.get("/api/v1/generation/presets?scope=user");
    expect(list.ok()).toBeTruthy();
    const items = (await list.json()).data.items as Array<{
      id: string;
      label: string;
      controls: unknown;
    }>;
    const found = items.find((p) => p.label === presetLabel);
    expect(found).toBeTruthy();
    const presetId = found?.id ?? "";
    expect(presetId).not.toBe("");

    await presetItem.getByRole("button", { name: `Delete preset ${presetLabel}` }).click();
    await expect(page.getByText("Press Confirm delete preset to delete this preset.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(presetItem).toBeVisible();
    const afterFirstClick = await ctx.get("/api/v1/generation/presets?scope=user");
    expect(afterFirstClick.ok()).toBeTruthy();
    const stillListed = (await afterFirstClick.json()).data.items as Array<{ id: string; label: string }>;
    expect(stillListed.some((p) => p.id === presetId && p.label === presetLabel)).toBe(true);
    await expect(
      prisma.generationPreset.findUniqueOrThrow({
        where: { id: presetId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "active" });

    await presetItem.getByRole("button", { name: `Confirm delete preset ${presetLabel}` }).click();
    await expect(page.getByText("Preset deleted.")).toBeVisible({ timeout: 10_000 });
    await expect(presetItem).toHaveCount(0, { timeout: 10_000 });
    const after = await ctx.get("/api/v1/generation/presets?scope=user");
    const remaining = (await after.json()).data.items as Array<{ label: string }>;
    expect(remaining.some((p) => p.label === presetLabel)).toBe(false);
    await expect(
      prisma.generationPreset.findUniqueOrThrow({
        where: { id: presetId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "archived" });

    // Bulk media route is reachable + schema-valid (no-op on a non-owned id).
    const bulk = await ctx.post("/api/v1/media/bulk", {
      data: { ids: ["does-not-exist"], action: "delete" },
    });
    expect(bulk.ok(), await bulk.text()).toBeTruthy();
  } finally {
    await prisma.generationPreset.deleteMany({ where: { id: communityBackgroundId } });
  }
});

test("upgrade signup redirect returns anonymous checkout intent to plans", async ({ page }) => {
  await page.request.post("/api/v1/age-gate/accept", { data: { sourcePath: "/upgrade" } });
  const email = uniqueEmail("upgrade-signup-redirect");
  const returnTarget = "/generate?characterId=lola-moonstruck";

  await page.goto(`/upgrade?returnTo=${encodeURIComponent(returnTarget)}`);
  await expect(page.getByTestId("upgrade-demo-checkout-notice")).toContainText(
    "No real payment is collected",
    { timeout: 10_000 },
  );
  const premiumMonthly = page.locator("article").filter({ hasText: "Premium monthly" });
  await expect(premiumMonthly).toBeVisible({ timeout: 10_000 });
  await premiumMonthly.getByRole("button", { name: "Demo upgrade" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    `/upgrade?plan=premium&billing=monthly&returnTo=${encodeURIComponent(returnTarget)}`,
  );
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Upgrade Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/upgrade");
  expect(new URL(page.url()).searchParams.get("plan")).toBe("premium");
  expect(new URL(page.url()).searchParams.get("billing")).toBe("monthly");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(returnTarget);
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByTestId("upgrade-demo-checkout-notice")).toContainText(
    "No real payment is collected",
    { timeout: 10_000 },
  );
  const returnedExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(returnedExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");
  await expect(premiumMonthly.getByRole("button", { name: "Demo upgrade" })).toBeVisible();
});

test("upgrade exposes retryable plan load errors as assertive alerts", async ({ page }) => {
  await startSignedInAdultSession(page, "upgrade-plans-load-error");
  let failPlansRequest = true;
  await page.route("**/api/v1/plans", (route) => {
    if (!failPlansRequest) {
      void route.continue();
      return;
    }
    failPlansRequest = false;
    void route.fulfill({
      body: JSON.stringify({ ok: false, error: { message: "forced plans failure" } }),
      contentType: "application/json",
      status: 500,
    });
  });

  await page.goto("/upgrade");
  const status = page.getByTestId("upgrade-plans-status");
  await expect(status).toContainText("Could not load plans.", { timeout: 10_000 });
  await expect(status).toHaveAttribute("role", "alert");
  await expect(status).toHaveAttribute("aria-live", "assertive");

  await status.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("upgrade-demo-checkout-notice")).toContainText(
    "No real payment is collected",
    { timeout: 10_000 },
  );
  await expect(page.locator("article").filter({ hasText: "Premium monthly" })).toBeVisible();
});

test("upgrade checkout failures are announced as assertive alerts", async ({ page }) => {
  await startSignedInAdultSession(page, "upgrade-checkout-failure");
  await page.route("**/api/v1/billing/checkout", (route) =>
    route.fulfill({
      body: JSON.stringify({ ok: false, error: { message: "forced checkout failure" } }),
      contentType: "application/json",
      status: 500,
    }),
  );

  await page.goto("/upgrade");
  await expect(page.getByTestId("upgrade-demo-checkout-notice")).toContainText(
    "No real payment is collected",
    { timeout: 10_000 },
  );
  const premiumMonthly = page.locator("article").filter({ hasText: "Premium monthly" });
  await premiumMonthly.getByRole("button", { name: "Demo upgrade" }).click();

  const checkoutResult = page.getByTestId("upgrade-checkout-result");
  await expect(checkoutResult).toContainText("forced checkout failure", { timeout: 10_000 });
  await expect(checkoutResult).toHaveAttribute("role", "alert");
  await expect(checkoutResult).toHaveAttribute("aria-live", "assertive");
});

test("character generator keeps identity controls behind Advanced settings", async ({ page }) => {
  await startSignedInAdultSession(page, "generate-character-first");
  await page.goto("/generate?characterId=melissa-burke");

  await expect(page.getByText("Character identity", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Describe the moment", { exact: true })).toBeVisible();
  await expect(page.getByText("Presets", { exact: true })).toHaveCount(0);
  await expect(page.getByText("My Presets", { exact: true })).toHaveCount(0);
  await expect(page.locator("#generator-model")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Negative Prompt" })).toHaveCount(0);

  await page.getByTestId("generator-advanced-toggle").click();

  await expect(page.getByText("Presets", { exact: true })).toBeVisible();
  await expect(page.getByText("My Presets", { exact: true })).toBeVisible();
  await expect(page.locator("#generator-model")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Negative Prompt" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Closest match" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Natural" })).toBeVisible();
  await expect(page.getByRole("button", { name: "More expressive" })).toBeVisible();
});

test("upgrade UI activates Premium, grants dreamcoins, and unlocks prompt controls", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await startSignedInAdultSession(page, "upgrade");
  const returnTarget = "/generate?characterId=lola-moonstruck";

  await page.goto(`/upgrade?returnTo=${encodeURIComponent(returnTarget)}`);
  await expect(page.getByTestId("upgrade-demo-checkout-notice")).toContainText(
    "No real payment is collected",
    { timeout: 10_000 },
  );
  const premiumMonthly = page.locator("article").filter({ hasText: "Premium monthly" });
  await expect(premiumMonthly).toBeVisible({ timeout: 10_000 });
  await premiumMonthly.getByRole("button", { name: "Demo upgrade" }).click();
  await expect(
    page.getByText("Premium monthly is active. 1,500 dreamcoins were added."),
  ).toBeVisible({ timeout: 10_000 });
  await expect(premiumMonthly.getByRole("button", { name: "Current plan" })).toBeDisabled();
  await expect(page.getByTestId("upgrade-checkout-result")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("upgrade-checkout-result")).toHaveAttribute("aria-live", "polite");
  await expect(
    page.getByTestId("upgrade-checkout-result").getByRole("link", { name: "View billing" }),
  ).toBeVisible();
  const startGenerating = page
    .getByTestId("upgrade-checkout-result")
    .getByRole("link", { name: "Start generating" });
  await expect(startGenerating).toBeVisible();
  await expect(startGenerating).toHaveAttribute("href", returnTarget);
  await startGenerating.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  expect(new URL(page.url()).searchParams.get("characterId")).toBe("lola-moonstruck");
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue("lola-moonstruck");

  await page.goto("/profile");
  await expect(page.getByText(/1,?750 dreamcoins · Premium monthly/)).toBeVisible({
    timeout: 10_000,
  });
  const billingCard = page.getByTestId("profile-billing-card");
  await expect(billingCard.getByText("Premium monthly")).toBeVisible({ timeout: 10_000 });
  await expect(billingCard.getByText(/Renews/)).toBeVisible({ timeout: 10_000 });
  await billingCard.getByRole("button", { name: "Cancel renewal" }).click();
  await expect(page.getByText(/Renewal canceled. Benefits stay active/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(billingCard.getByText(/Renewal canceled/)).toBeVisible({ timeout: 10_000 });
  await billingCard.getByRole("button", { name: "Resume renewal" }).click();
  await expect(page.getByText("Renewal resumed.")).toBeVisible({ timeout: 10_000 });
  await expect(billingCard.getByText(/Renews/)).toBeVisible({ timeout: 10_000 });

  await page.goto(returnTarget);
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await expect(prompt).toBeEnabled({ timeout: 10_000 });
  await prompt.fill("premium e2e prompt control");
  await expect(page.getByRole("textbox", { name: "Negative Prompt" })).toHaveCount(0);
  await expect(page.locator("#generator-model")).toHaveCount(0);
  await page.getByTestId("generator-advanced-toggle").click();
  await expect(page.getByRole("textbox", { name: "Negative Prompt" })).toBeEnabled();
  await expect(page.locator("#generator-model")).toBeVisible();
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByText("Generation queued.")).toBeVisible({ timeout: 10_000 });
  const job = await latestImageJob(page.request);
  await drainWorker(page.request, job.id);
  await expect(page.getByText("Generation complete.")).toBeVisible({ timeout: 10_000 });
  const asset = await expectGeneratedAssetServed(page.request, job.id);
  await page.getByRole("button", { name: "Images" }).click();
  const generatedCard = page.locator(`[data-media-id="${asset.id}"]`);
  await expect(generatedCard).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(
      async () =>
        (await generatedCard.getByTestId("gallery-media-image").count()) +
        (await generatedCard.getByTestId("gallery-media-preview-fallback").count()),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  await expect(generatedCard.getByRole("button", { name: "Create variation" })).toBeVisible();
});

test("creator profile signup redirect returns anonymous follow intent to creator", async ({
  page,
}) => {
  const dreamer = await seedCommunityDreamer();
  const creatorPath = `/creators/${dreamer.id}`;
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: creatorPath },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("creator-follow-signup-redirect");

  await page.goto(creatorPath);
  await expect(page.getByRole("heading", { name: dreamer.displayName, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("creator-follow")).toHaveText(/Follow/);
  await expect(page.getByTestId("creator-follow")).toHaveAttribute("aria-pressed", "false");

  await page.getByTestId("creator-follow").click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe(creatorPath);
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Creator Follow Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe(creatorPath);
  const me = await page.request.get("/api/v1/me");
  expect(me.ok(), await me.text()).toBeTruthy();
  expect((await me.json()).data.user?.email).toBe(email);
  await expect(page.getByRole("heading", { name: dreamer.displayName, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("creator-follow").click();
  await expect(page.getByTestId("creator-follow")).toHaveText(/Following/, { timeout: 10_000 });
  await expect(page.getByTestId("creator-follow")).toHaveAttribute("aria-pressed", "true");
});

test("community signup redirect returns anonymous follow intent to creator", async ({
  page,
}) => {
  const dreamer = await seedCommunityDreamer();
  const creatorPath = `/creators/${dreamer.id}`;
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/community" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("community-follow-signup-redirect");

  await page.goto("/community");
  const dreamerCard = page
    .getByTestId("community-dreamer-card")
    .filter({ hasText: dreamer.displayName });
  await expect(dreamerCard).toBeVisible({ timeout: 10_000 });

  await dreamerCard.getByRole("button", { name: "Follow" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe(creatorPath);
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Community Follow Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe(creatorPath);
  const me = await page.request.get("/api/v1/me");
  expect(me.ok(), await me.text()).toBeTruthy();
  expect((await me.json()).data.user?.email).toBe(email);
  await expect(page.getByRole("heading", { name: dreamer.displayName, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId("creator-follow").click();
  await expect(page.getByTestId("creator-follow")).toHaveText(/Following/, { timeout: 10_000 });
});

test("community UI lists dreamers and reports user profiles", async ({ page }) => {
  await startSignedInAdultSession(page, "community-report");
  const dreamer = await seedCommunityDreamer();

  await page.goto("/community");
  const dreamerCard = page.getByTestId("community-dreamer-card").filter({ hasText: dreamer.displayName });
  await expect(dreamerCard).toBeVisible({ timeout: 10_000 });
  await dreamerCard.getByRole("button", { name: `Report user profile ${dreamer.displayName}` }).click();
  await expect(page.getByText("Profile report submitted.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("community-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("community-status")).toHaveAttribute("aria-live", "polite");
  await expectContentReport("user_profile", dreamer.id);

  // Creator public profile (§G): name links to /creators/:id, follow toggles to Following.
  await dreamerCard.getByRole("link", { name: dreamer.displayName }).click();
  await expect(page).toHaveURL(new RegExp(`/creators/${dreamer.id}$`));
  // The profile title is the h1; character cards can repeat the name as an h2 link, so pin level 1.
  await expect(page.getByRole("heading", { name: dreamer.displayName, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator("aside").getByRole("link", { name: "Community" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("aside").getByRole("link", { name: "Explore" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  const creatorCharacterCard = page.locator(`a[href="/characters/${dreamer.characterId}"]`);
  await expect(creatorCharacterCard).toBeVisible({ timeout: 10_000 });
  const creatorCharacterImage = creatorCharacterCard.locator("img").first();
  await expect(creatorCharacterImage).toHaveAttribute("loading", "eager");
  await expect(creatorCharacterImage).toHaveAttribute(
    "src",
    /^\/images\/ourdream\/card-[a-z-]+\.webp$/,
  );
  await expect.poll(() =>
    creatorCharacterImage.evaluate((element) => {
      const image = element as HTMLImageElement;
      return image.complete && image.naturalWidth > 0;
    }),
  ).toBe(true);
  await page.getByTestId("creator-follow").click();
  await expect(page.getByTestId("creator-follow")).toHaveText(/Following/, { timeout: 10_000 });
  await page.reload();
  await expect(page.getByTestId("creator-follow")).toHaveText(/Following/, { timeout: 10_000 });
  await expect(creatorCharacterImage).toHaveAttribute("loading", "eager");
  await expect(creatorCharacterImage).toHaveAttribute(
    "src",
    /^\/images\/ourdream\/card-[a-z-]+\.webp$/,
  );
});

test("community UI filters characters and shows collections", async ({ page }) => {
  const { email } = await startSignedInAdultSession(page, "community-filters");
  const token = `E2E Community ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  await seedExploreCharacters(token);
  const campaign = await seedCommunityCampaigns(email);
  const lcpWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Largest Contentful Paint")) {
      lcpWarnings.push(message.text());
    }
  });

  await page.goto("/community");
  await expect(page.getByRole("heading", { name: campaign.firstTitle })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("link", { name: "Open Community" })).toHaveAttribute(
    "href",
    "/community",
  );
  const campaignHero = page.getByTestId("community-campaign-hero");
  await expect(campaignHero.locator('img[src*="promo-card-female"]')).toHaveAttribute(
    "loading",
    "eager",
  );
  await expect(page.getByLabel("Campaign 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Next campaign" }).click();
  await expect(page.getByRole("heading", { name: campaign.secondTitle })).toBeVisible({
    timeout: 10_000,
  });
  await expect(campaignHero.locator('img[src*="card-sarah-mercer"]')).toBeVisible();
  await expect(page.getByRole("heading", { exact: true, name: "Characters" })).toBeVisible({
    timeout: 10_000,
  });

  const alphaCard = page
    .getByTestId("community-character-card")
    .filter({ hasText: `${token} Alpha` });
  const deltaCard = page
    .getByTestId("community-character-card")
    .filter({ hasText: `${token} Delta` });
  await expect(alphaCard).toBeVisible({ timeout: 10_000 });

  const releaseFilter = page.getByLabel("Release", { exact: true });
  const genderFilter = page.getByLabel("Gender", { exact: true });
  const styleFilter = page.getByLabel("Style", { exact: true });
  await expect(releaseFilter).toHaveValue("all");
  await expect(genderFilter).toHaveValue("any");
  await expect(styleFilter).toHaveValue("any");

  await releaseFilter.selectOption("30d");
  await expect(releaseFilter).toHaveValue("30d");
  await releaseFilter.selectOption("all");
  await expect(releaseFilter).toHaveValue("all");

  await styleFilter.selectOption("realistic");
  await expect(styleFilter).toHaveValue("realistic");

  await genderFilter.selectOption("female");
  await expect(genderFilter).toHaveValue("female");
  await expect(alphaCard).toBeVisible({ timeout: 10_000 });
  await expect(deltaCard).toHaveCount(0);

  await genderFilter.selectOption("male");
  await expect(genderFilter).toHaveValue("male");
  await expect(deltaCard).toBeVisible({ timeout: 10_000 });
  await expect(alphaCard).toHaveCount(0);

  await expect(page.getByRole("heading", { exact: true, name: "Collections" })).toBeVisible();
  await expect.poll(() =>
    page.getByTestId("community-collection-card").count(),
  ).toBeGreaterThan(0);
  expect(lcpWarnings).toEqual([]);
});

test("community shows explicit empty states when public data is unavailable", async ({
  page,
}) => {
  await startSignedInAdultSession(page, "community-empty");
  await page.route("**/api/v1/community/leaderboards**", (route) =>
    route.fulfill({
      body: JSON.stringify({
        ok: true,
        data: { leaderboards: { characters: [], dreamers: [], collections: [] } },
      }),
      contentType: "application/json",
      status: 200,
    }),
  );
  await page.route("**/api/v1/community/collections", (route) =>
    route.fulfill({
      body: JSON.stringify({ ok: true, data: { collections: [] } }),
      contentType: "application/json",
      status: 200,
    }),
  );

  await page.goto("/community");

  await expect(page.getByText("Dreamers with public characters appear here.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId("community-characters-empty")).toHaveText(
    "No characters match these filters.",
  );
  await expect(page.getByText("Public collections appear here.")).toBeVisible();
});

test("feed chat signup redirect returns anonymous intent to character detail", async ({
  page,
}) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/feed" },
  });
  const email = uniqueEmail("feed-chat-signup-redirect");

  await page.goto("/feed");
  await expect(page.getByRole("heading", { name: "Recommended Dreams" })).toBeVisible({
    timeout: 10_000,
  });
  const melissaFeedCard = page
    .getByTestId("feed-character-card")
    .filter({ has: page.locator('a[href="/characters/melissa-burke"]') });
  await expect(melissaFeedCard).toHaveCount(1, { timeout: 10_000 });
  await melissaFeedCard.getByRole("button", { name: "Chat" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/characters/melissa-burke");
  const authExploreClass = await page
    .locator("aside")
    .getByRole("link", { name: "Explore" })
    .getAttribute("class");
  expect(authExploreClass?.split(/\s+/)).not.toContain("bg-[rgb(46,46,46)]");

  await page.getByLabel("Display name").fill("E2E Feed Chat Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/characters/melissa-burke");
  await expect(page.getByRole("heading", { name: "Melissa Burke" })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
});

test("feed like signup redirect returns anonymous intent to focused feed item", async ({
  page,
}) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/feed" },
  });
  const email = uniqueEmail("feed-like-signup-redirect");

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto("/feed");
  await expect(page.getByRole("heading", { name: "Recommended Dreams" })).toBeVisible({
    timeout: 10_000,
  });
  const melissaFeedCard = page
    .getByTestId("feed-character-card")
    .filter({ has: page.locator('a[href="/characters/melissa-burke"]') });
  await expect(melissaFeedCard).toHaveCount(1, { timeout: 10_000 });
  await melissaFeedCard.getByRole("button", { name: "Like" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    "/feed?item=character%3Amelissa-burke",
  );

  await page.getByLabel("Display name").fill("E2E Feed Like Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/feed");
  expect(new URL(page.url()).searchParams.get("item")).toBe("character:melissa-burke");
  const focusedMelissaCard = page
    .locator('[data-testid="feed-character-card"][data-focused="true"]')
    .filter({ has: page.locator('a[href="/characters/melissa-burke"]') });
  await expect(focusedMelissaCard).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByText("Showing shared dream.")).toBeVisible({ timeout: 10_000 });
  await focusedMelissaCard.getByRole("button", { name: "Like" }).click();
  await expect(focusedMelissaCard.getByRole("button", { name: "Liked" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  await expect
    .poll(() =>
      prisma.characterLike.findUnique({
        where: { userId_characterId: { userId: user.id, characterId: "melissa-burke" } },
      }),
    )
    .not.toBeNull();
  expect(pageErrors).toEqual([]);
  expect(
    consoleErrors.filter(
      (message) =>
        !message.includes("favicon") && !message.includes("status of 401 (Unauthorized)"),
    ),
  ).toEqual([]);
});

test("feed remix signup redirect preserves anonymous generator intent", async ({ page }) => {
  await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/feed" },
  });
  const email = uniqueEmail("feed-remix-signup-redirect");

  await page.goto("/feed");
  await expect(page.getByRole("heading", { name: "Recommended Dreams" })).toBeVisible({
    timeout: 10_000,
  });
  const melissaFeedCard = page
    .getByTestId("feed-character-card")
    .filter({ has: page.locator('a[href="/characters/melissa-burke"]') });
  await expect(melissaFeedCard).toHaveCount(1, { timeout: 10_000 });
  await melissaFeedCard.getByRole("button", { name: "Remix" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  expect(new URL(page.url()).searchParams.get("characterId")).toBe("melissa-burke");
  expect(new URL(page.url()).searchParams.get("remixFeedItemId")).toBe("character:melissa-burke");
  const insufficientBalance = page.getByTestId("generator-insufficient-balance");
  await expect(insufficientBalance).toContainText("Join free to get starter coins for this remix.");
  await expect(insufficientBalance).toHaveAttribute(
    "href",
    "/signup?next=%2Fgenerate%3FcharacterId%3Dmelissa-burke%26remixFeedItemId%3Dcharacter%253Amelissa-burke",
  );
  await insufficientBalance.click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe(
    "/generate?characterId=melissa-burke&remixFeedItemId=character%3Amelissa-burke",
  );
  await page.getByLabel("Display name").fill("E2E Feed Remix Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  expect(new URL(page.url()).searchParams.get("characterId")).toBe("melissa-burke");
  expect(new URL(page.url()).searchParams.get("remixFeedItemId")).toBe("character:melissa-burke");
  await expect(page.getByText("Remix ready from Feed. Adjust details and generate.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Generate" })).toBeEnabled({ timeout: 10_000 });
});

test("feed UI supports share, report, and remix actions", async ({ page }) => {
  test.setTimeout(120_000);
  await startSignedInAdultSession(page, "feed-actions");
  const token = `E2E Feed ${Date.now()} ${Math.floor(Math.random() * 1e6)}`;
  const ids = await seedExploreCharacters(token);
  const collection = await seedFeedCollection();
  const characterId = ids.delta;

  await page.goto("/feed");
  await expect(page.locator('aside nav a[href="/feed"]')).toHaveClass(/bg-\[rgb\(46,46,46\)\]/);
  await expect(page.locator("article").first().locator("img").first()).toHaveAttribute("loading", "eager", {
    timeout: 10_000,
  });
  await expect
    .poll(() =>
      page.locator("article").evaluateAll((articles) =>
        articles.slice(0, 10).map((article) => article.querySelector("img")?.getAttribute("loading")),
      ),
    )
    .toEqual([
      "eager",
      "eager",
      "eager",
      "eager",
      "eager",
      "eager",
      "eager",
      "eager",
      "eager",
      "eager",
    ]);
  const collectionCard = page.getByTestId("feed-collection-card").filter({ hasText: collection.name });
  await expect(collectionCard).toBeVisible({ timeout: 10_000 });
  await expect(collectionCard.getByText("Creator collection")).toBeVisible();
  await expect(collectionCard.getByText("1 item")).toBeVisible();
  await expect(collectionCard.locator("img").first()).toHaveAttribute("loading", "eager");
  const collectionCommunityHref = `/community?collection=${encodeURIComponent(collection.id)}`;
  await expect(collectionCard.getByRole("link", { name: "View" })).toHaveAttribute(
    "href",
    collectionCommunityHref,
  );
  await collectionCard.getByRole("link", { name: "View" }).click();
  await expect.poll(() => {
    const current = new URL(page.url());
    return `${current.pathname}${current.search}`;
  }).toBe(collectionCommunityHref);
  await expect(page.getByText(`Showing collection: ${collection.name}.`)).toBeVisible({
    timeout: 10_000,
  });
  const focusedCommunityCollection = page
    .getByTestId("community-collection-card")
    .filter({ hasText: collection.name });
  await expect(focusedCommunityCollection).toHaveAttribute("data-focused", "true", {
    timeout: 10_000,
  });

  await page.goto("/feed");
  await expect(collectionCard).toBeVisible({ timeout: 10_000 });
  await collectionCard.getByRole("button", { name: "Share" }).click();
  await expect(page.getByText(/Share link copied\.|Share link:/)).toBeVisible({ timeout: 10_000 });
  await page.goto(`/feed?item=${encodeURIComponent(collection.itemId)}`);
  await expect(page.getByText("Showing shared dream.")).toBeVisible({ timeout: 10_000 });
  const focusedCollectionCard = page.getByTestId("feed-collection-card").filter({ hasText: collection.name });
  await expect(focusedCollectionCard).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
  await focusedCollectionCard.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("feed-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("feed-status")).toHaveAttribute("aria-live", "polite");
  await expectContentReport("feed_item", collection.itemId);

  await page.goto("/feed");
  const feedCard = page.locator("article").filter({
    has: page.locator(`a[href="/characters/${characterId}"]`),
  });
  await expect(feedCard).toHaveCount(1, { timeout: 10_000 });
  await expect(feedCard).toBeVisible();
  for (const actionName of ["Chat", "Remix", "Share", "Report"]) {
    await expect(feedCard.getByRole("button", { name: actionName })).not.toHaveAttribute(
      "aria-pressed",
      /.+/,
    );
  }
  await expect(feedCard.getByRole("button", { name: "Like" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  await feedCard.getByRole("button", { name: "Like" }).click();
  await expect(feedCard.getByRole("button", { name: "Liked" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.reload();
  const reloadedFeedCard = page.locator("article").filter({
    has: page.locator(`a[href="/characters/${characterId}"]`),
  });
  await expect(page.locator("article").first().locator("img").first()).toHaveAttribute("loading", "eager", {
    timeout: 10_000,
  });
  await expect(reloadedFeedCard).toHaveCount(1, { timeout: 10_000 });
  await expect(reloadedFeedCard.getByRole("button", { name: "Liked" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await reloadedFeedCard.getByRole("button", { name: "Share" }).click();
  await expect(page.getByText(/Share link copied\.|Share link:/)).toBeVisible({ timeout: 10_000 });
  await page.goto(`/feed?item=${encodeURIComponent(`character:${characterId}`)}`);
  await expect(page.getByText("Showing shared dream.")).toBeVisible({ timeout: 10_000 });
  const sharedFeedCard = page.locator("article").first();
  await expect(sharedFeedCard.locator("img").first()).toHaveAttribute("loading", "eager");
  await expect(sharedFeedCard.getByText("Shared dream")).toBeVisible();
  await expect(sharedFeedCard.locator(`a[href="/characters/${characterId}"]`)).toBeVisible();

  await sharedFeedCard.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("feed-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("feed-status")).toHaveAttribute("aria-live", "polite");
  await expectContentReport("feed_item", `character:${characterId}`);

  await sharedFeedCard.getByRole("button", { name: "Remix" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/generate");
  await expect.poll(() => new URL(page.url()).searchParams.get("characterId")).toBe(characterId);
  await expect.poll(() => new URL(page.url()).searchParams.get("remixFeedItemId")).toBe(`character:${characterId}`);
  await expect(page.locator('select[aria-label="Character"]')).toHaveValue(characterId, {
    timeout: 10_000,
  });
  await expect(page.getByText("Remix ready from Feed. Adjust details and generate.")).toBeVisible({
    timeout: 10_000,
  });
  const generate = page.getByRole("button", { name: "Generate" });
  await expect(generate).toBeEnabled({ timeout: 45_000 });
  await generate.click();
  await expect(page.getByText("Generation queued.")).toBeVisible({ timeout: 10_000 });
  const job = await latestImageJob(page.request);
  await drainWorker(page.request, job.id);
  await expect(page.getByText("Generation complete.")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Images" }).click();
  const galleryImage = page.getByTestId("gallery-media-image").first();
  await expect(galleryImage).toHaveAttribute("loading", "eager", { timeout: 10_000 });
  const provenance = page.getByTestId("gallery-provenance-link").first();
  await expect(provenance).toBeVisible({ timeout: 10_000 });
  await expect(provenance).toContainText("Remixed from Feed");
  await expect(provenance).toHaveAttribute(
    "href",
    `/feed?item=${encodeURIComponent(`character:${characterId}`)}`,
  );
  await provenance.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/feed");
  await expect(page.getByText("Showing shared dream.")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("article").first().locator(`a[href="/characters/${characterId}"]`)).toBeVisible();
});

test("profile UI handles redeem, referral, billing, and media actions", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const { email } = await startSignedInAdultSession(page, "profile");
  const code = `PROFILE${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  await seedRedeemCode(code, 300);
  const mutedTagSlug = await seedProfileMutedTagFixture(email);
  const mediaId = await seedDownloadableMedia(email);
  const blankMediaId = await seedBlankProfileMedia(email);
  const videoMediaId = await seedDownloadableVideoMedia(email);
  const nextName = uniqueName("profile renamed");
  const collectionName = uniqueName("profile collection");

  await page.goto("/profile");
  await expect(page.getByText("250 dreamcoins")).toBeVisible({ timeout: 10_000 });

  await page.getByLabel("Display name").fill(nextName);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile updated.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(nextName)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("checkbox", { name: "Product updates" }).uncheck();
  await page.getByRole("checkbox", { name: "Mute Slow Burn" }).check({ timeout: 10_000 });
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences updated.")).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      const preferences = await prisma.userPreferences.findUnique({
        where: { userId: user.id },
        select: { notificationSettings: true },
      });
      const notificationSettings = preferences?.notificationSettings as
        | { productUpdates?: unknown }
        | null
        | undefined;
      return notificationSettings?.productUpdates;
    })
    .toBe(false);
  await expect
    .poll(async () => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true },
      });
      const preferences = await prisma.userPreferences.findUnique({
        where: { userId: user.id },
        select: { mutedTags: true },
      });
      return Array.isArray(preferences?.mutedTags) ? preferences.mutedTags : [];
    })
    .toContain(mutedTagSlug);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Product updates" })).not.toBeChecked({
    timeout: 10_000,
  });
  await expect(page.getByRole("checkbox", { name: "Mute Slow Burn" })).toBeChecked({
    timeout: 10_000,
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Slow Burn" })).toHaveCount(0);
  await page.goto("/profile");

  await page.getByRole("button", { name: "Redeem code" }).click();
  await expect(page.getByText("Enter a code.")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("textbox", { name: "Redeem code input" }).fill(code);
  await page.getByRole("button", { name: "Redeem code" }).click();
  await expect(page.getByText("Code redeemed.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("550 dreamcoins")).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Referral invite ready.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("profile-status")).toHaveAttribute("role", "status");
  await expect(page.getByTestId("profile-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByLabel("Referral link")).toHaveValue(/ref=DREAM-/, { timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Copy invite link" })).toBeVisible({
    timeout: 10_000,
  });

  const billingCard = page.getByTestId("profile-billing-card");
  await expect(billingCard.getByText("No active subscription")).toBeVisible({ timeout: 10_000 });
  await expect(billingCard.getByRole("link", { name: "Compare plans" })).toHaveAttribute(
    "href",
    "/upgrade",
  );
  await billingCard.getByRole("link", { name: "Compare plans" }).click();
  await expect(page).toHaveURL(/\/upgrade$/);

  await page.goto("/profile");
  await page.getByRole("button", { name: "media", exact: true }).click();
  const mediaCard = page.locator(`[data-media-id="${mediaId}"]`);
  await expect(mediaCard).toBeVisible({ timeout: 10_000 });
  const blankMediaCard = page.locator(`[data-media-id="${blankMediaId}"]`);
  await expect(blankMediaCard).toBeVisible({ timeout: 10_000 });
  await expect(blankMediaCard.getByTestId("profile-media-preview-fallback")).toContainText(
    "Preview unavailable",
  );
  await expect(blankMediaCard.getByTestId("profile-media-image")).toHaveCount(0);
  const videoCard = page.locator(`[data-media-id="${videoMediaId}"]`);
  await expect(videoCard.getByTestId("profile-media-video")).toBeVisible({ timeout: 10_000 });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);

  await page.getByRole("textbox", { name: "Search your library" }).fill("profile downloadable media");
  await expect(mediaCard).toBeVisible({ timeout: 10_000 });
  await expect(videoCard).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search your library" }).fill("no library match");
  await expect(page.getByRole("heading", { name: "No matches" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(mediaCard).toBeVisible({ timeout: 10_000 });
  await expect(blankMediaCard.getByTestId("profile-media-preview-fallback")).toContainText(
    "Preview unavailable",
  );
  await expect(videoCard.getByTestId("profile-media-video")).toBeVisible({ timeout: 10_000 });

  await mediaCard.getByLabel("Collection name").fill(collectionName);
  await mediaCard.getByRole("checkbox", { name: "Publish collection to Community" }).check();
  await mediaCard.getByRole("button", { name: "Create collection from media" }).click();
  await expect(page.getByText("Collection published to Community.")).toBeVisible({
    timeout: 10_000,
  });
  const viewCommunityLink = page.getByRole("link", { name: "View in Community" });
  await expect(viewCommunityLink).toHaveAttribute("href", /\/community\?collection=/, {
    timeout: 10_000,
  });

  await viewCommunityLink.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/community");
  const collectionCard = page
    .getByTestId("community-collection-card")
    .filter({ hasText: collectionName });
  await expect(collectionCard).toBeVisible({ timeout: 10_000 });
  await expect(collectionCard).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
  await expect(collectionCard.getByText("1 item")).toBeVisible();

  await page.goto("/profile");
  await page.getByRole("button", { name: "media", exact: true }).click();
  await expect(mediaCard).toBeVisible({ timeout: 10_000 });

  await mediaCard.getByRole("button", { name: "Report media" }).click();
  await expect(page.getByText("Report submitted.")).toBeVisible({ timeout: 10_000 });
  await expectContentReport("media", mediaId);

  await mediaCard.getByRole("button", { name: "Download media" }).click();
  await expect(page.getByText("Download started.")).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/profile$/);

  await mediaCard.getByRole("button", { name: "Delete media" }).click();
  await expect(page.getByText("Press Confirm delete to remove this media.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(mediaCard).toBeVisible();
  await mediaCard.getByRole("button", { name: "Confirm delete media" }).click();
  await expect(page.getByText("Media deleted.")).toBeVisible({ timeout: 10_000 });
  await expect(mediaCard).toHaveCount(0, { timeout: 10_000 });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);
});

test("mobile profile media publish links directly to the focused Community collection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { email } = await startSignedInAdultSession(page, "profile-collection-mobile");
  const mediaId = await seedDownloadableMedia(email);
  const collectionName = uniqueName("mobile profile collection");

  await page.goto("/profile");
  await page.getByRole("button", { name: "media", exact: true }).click();
  const mediaCard = page.locator(`[data-media-id="${mediaId}"]`);
  await expect(mediaCard).toBeVisible({ timeout: 10_000 });

  await mediaCard.getByLabel("Collection name").fill(collectionName);
  await mediaCard.getByRole("button", { name: "Create collection from media" }).click();
  await expect(page.getByText("Collection published to Community.")).toBeVisible({
    timeout: 10_000,
  });
  const viewCommunityLink = page.getByRole("link", { name: "View in Community" });
  await expect(viewCommunityLink).toBeVisible({ timeout: 10_000 });
  await expect(viewCommunityLink).toHaveAttribute("href", /\/community\?collection=/);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    )
    .toBe(true);

  await viewCommunityLink.click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/community");
  await expect(page.getByText(`Showing collection: ${collectionName}.`)).toBeVisible({
    timeout: 10_000,
  });
  const collectionCard = page
    .getByTestId("community-collection-card")
    .filter({ hasText: collectionName });
  await expect(collectionCard).toHaveAttribute("data-focused", "true", { timeout: 10_000 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
    )
    .toBe(true);
});

test("profile prompts anonymous visitors to sign in before showing private controls", async ({
  page,
}) => {
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/profile" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("profile-signup-redirect");

  await page.goto("/profile#billing");

  const authPanel = page.getByTestId("profile-auth-required");
  await expect(authPanel).toBeVisible({ timeout: 10_000 });
  await expect(authPanel.getByRole("heading", { name: "Sign in to open Profile" })).toBeVisible();
  await expect(authPanel.getByRole("link", { name: "Log in" })).toHaveAttribute(
    "href",
    "/login?next=%2Fprofile%23billing",
  );
  await expect(authPanel.getByRole("link", { name: "Join Free" })).toHaveAttribute(
    "href",
    "/signup?next=%2Fprofile%23billing",
  );
  await expect(page.getByText("Couldn't load your balance and plan.")).toHaveCount(0);
  await expect(page.getByText("Couldn't load this tab")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out all sessions" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Delete confirmation" })).toHaveCount(0);

  await authPanel.getByRole("link", { name: "Join Free" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/profile#billing");

  await page.getByLabel("Display name").fill("E2E Profile Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/profile");
  expect(new URL(page.url()).hash).toBe("#billing");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByTestId("profile-billing-card")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
    timeout: 10_000,
  });
});

test("profile subroutes preserve anonymous auth return targets", async ({ page }) => {
  const ageGate = await page.request.post("/api/v1/age-gate/accept", {
    data: { sourcePath: "/profile/redeem-code" },
  });
  expect(ageGate.ok(), await ageGate.text()).toBeTruthy();
  const email = uniqueEmail("profile-subroute-signup-redirect");
  const cases = [
    "/profile/redeem-code",
    "/profile/notifications",
    "/profile/account-management",
  ] as const;

  for (const path of cases) {
    await page.goto(path);
    const authPanel = page.getByTestId("profile-auth-required");
    await expect(authPanel).toBeVisible({ timeout: 10_000 });
    await expect(authPanel.getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      `/login?next=${encodeURIComponent(path)}`,
    );
    await expect(authPanel.getByRole("link", { name: "Join Free" })).toHaveAttribute(
      "href",
      `/signup?next=${encodeURIComponent(path)}`,
    );
  }

  await page.goto("/profile/redeem-code");
  await page.getByTestId("profile-auth-required").getByRole("link", { name: "Join Free" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/signup");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/profile/redeem-code");

  await page.getByLabel("Display name").fill("E2E Profile Subroute Signup Redirect");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Join Free" }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/profile/redeem-code");
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByTestId("profile-redeem-panel")).toBeVisible();
  await expect.poll(() =>
    page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""),
  ).toBe("Redeem code input");
});

test("my ai shows deferred group chat and pack tabs as explicit empty states", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await startSignedInAdultSession(page, "my-ai-tabs");
  await page.goto("/custom");

  await expect(page.getByRole("heading", { name: "My AI" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "recent" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "group chats" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("button", { name: "packs" })).toBeVisible();

  await page.getByRole("button", { name: "group chats" }).click();
  await expect(page.getByRole("button", { name: "group chats" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByRole("heading", { name: "Group chats are not in this beta" }),
  ).toBeVisible();
  await expect(page.getByTestId("library-empty-state").getByRole("link")).toHaveCount(0);

  await page.getByRole("button", { name: "packs" }).click();
  await expect(page.getByRole("heading", { name: "Packs are not in this beta" })).toBeVisible();
  await expect(page.getByTestId("library-empty-state").getByRole("link")).toHaveCount(0);
  expect(consoleErrors.filter((message) => !message.includes("favicon"))).toEqual([]);
});

test("profile subroutes deep-link to the matching account panels", async ({ page }) => {
  await startSignedInAdultSession(page, "profile-subroutes");
  const cases = [
    {
      path: "/profile/redeem-code",
      testId: "profile-redeem-panel",
      activeLabel: "Redeem code input",
    },
    {
      path: "/profile/notifications",
      testId: "profile-notifications-panel",
      activeLabel: "Product updates",
    },
    {
      path: "/profile/account-management",
      testId: "profile-account-management-panel",
      activeLabel: "Delete confirmation",
    },
  ] as const;

  for (const profileRoute of cases) {
    await page.goto(profileRoute.path);
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId(profileRoute.testId)).toBeVisible();
    await expect.poll(() =>
      page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""),
    ).toBe(profileRoute.activeLabel);
  }
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
