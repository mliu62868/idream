import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { buildContext } from "../src/context.js";
import { createChatPrisma } from "../src/db.js";
import { consumeInbound } from "../src/inbox.js";
import {
  attachmentReleaseIdForRetry,
  createSession,
  sendMessage,
} from "../src/service.js";
import { acceptAgeGate } from "./fixtures.js";

const prisma = createChatPrisma();
const superPool = new Pool({ connectionString: process.env.CHAT_TEST_SUPER_URL });

const CHARACTER_ID = "release-pin-character";
const USERS = [
  "release-pin-old",
  "release-pin-new",
  "release-pin-legacy",
  "release-pin-migrate",
  "release-pin-entry",
];

async function seedRelease(input: {
  releaseId: string;
  contentVersionId: string;
  version: number;
  systemPrompt: string;
  status?: string;
}) {
  await superPool.query(
    `INSERT INTO public.character_content_versions
      (id, "characterId", version, "contentHash", "personaSnapshot", "openingSnapshot", "appearanceSnapshot", "sourceType", "createdAt")
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, '{}'::jsonb, 'test', now())`,
    [
      input.contentVersionId,
      CHARACTER_ID,
      input.version,
      `hash-${input.version}`,
      JSON.stringify({
        name: `Pinned ${input.version}`,
        age: 24,
        description: `Persona ${input.version}`,
        systemPrompt: input.systemPrompt,
      }),
      JSON.stringify({ firstMessage: `Opening ${input.version}` }),
    ],
  );
  await superPool.query(
    `INSERT INTO public.character_releases
      (id, "projectId", "revisionId", "characterContentVersionId", "generationProvenance", "releasePlacementManifest", "snapshotHash", status, version, "createdAt", "updatedAt")
     VALUES ($1, 'release-pin-project', $2, $3, '{}'::jsonb, '{}'::jsonb, $4, $5, $6, now(), now())`,
    [input.releaseId, `revision-${input.version}`, input.contentVersionId, `snapshot-${input.version}`, input.status ?? "published", input.version],
  );
}

async function serve(releaseId: string) {
  await superPool.query(
    `UPDATE public.character_serving
       SET "currentReleaseId" = $1, state = 'live', version = version + 1, "updatedAt" = now()
     WHERE "characterId" = $2`,
    [releaseId, CHARACTER_ID],
  );
}

beforeAll(async () => {
  for (const userId of USERS) {
    await superPool.query(
      `INSERT INTO public.users (id, email, status, "createdAt", "updatedAt")
       VALUES ($1, $2, 'active', now(), now())`,
      [userId, `${userId}@example.test`],
    );
  }
  await acceptAgeGate(superPool, USERS);
  await superPool.query(
    `INSERT INTO public.characters
      (id, name, age, description, visibility, status, source, style, gender, appearance, "advancedDetails", "createdAt", "updatedAt")
     VALUES ($1, 'Current mutable name', 24, 'Current mutable description', 'public', 'approved', 'official', 'realistic', 'female', '{}'::jsonb, '{}'::jsonb, now(), now())`,
    [CHARACTER_ID],
  );
  await superPool.query(
    `INSERT INTO public.character_projects
      (id, "characterId", phase, audience, "successCriteria", version, "createdAt", "updatedAt")
     VALUES ('release-pin-project', $1, 'live_management', '{}'::jsonb, '[]'::jsonb, 1, now(), now())`,
    [CHARACTER_ID],
  );
  await seedRelease({
    releaseId: "release-pin-v1",
    contentVersionId: "content-pin-v1",
    version: 1,
    systemPrompt: "Immutable persona version one",
  });
  await superPool.query(
    `INSERT INTO public.character_serving
      (id, "characterId", "currentReleaseId", state, version, "createdAt", "updatedAt")
     VALUES ('serving-release-pin', $1, 'release-pin-v1', 'live', 1, now(), now())`,
    [CHARACTER_ID],
  );
});

afterAll(async () => {
  await prisma.$disconnect();
  await superPool.end();
});

describe("Character Release → Chat serving pin", () => {
  it("keeps an attachment retry on its original Release after the session migrates", () => {
    expect(
      attachmentReleaseIdForRetry(
        { characterReleaseId: "release-pin-v2" },
        "release-pin-v3",
      ),
    ).toBe("release-pin-v2");
    expect(attachmentReleaseIdForRetry({}, "release-pin-v3")).toBe("release-pin-v3");
  });
  it("pins complete entry attribution without treating it as release authority", async () => {
    const session = await createSession({
      userId: USERS[4],
      characterId: CHARACTER_ID,
      entryExposureId: "detail-exposure-1",
      entryJourneyId: "journey-1",
      entryPlacementId: "community.leaderboard",
    }, { prisma });
    expect(session).toMatchObject({
      entryExposureId: "detail-exposure-1",
      entryJourneyId: "journey-1",
      entryPlacementId: "community.leaderboard",
      characterReleaseId: "release-pin-v1",
    });
  });

  it("keeps an existing session on its immutable Release while new sessions use the new serving Release", async () => {
    const oldSession = await createSession({ userId: USERS[0], characterId: CHARACTER_ID }, { prisma });
    expect(oldSession.characterContentVersionId).toBe("content-pin-v1");
    expect(oldSession.characterReleaseId).toBe("release-pin-v1");

    await seedRelease({
      releaseId: "release-pin-v2",
      contentVersionId: "content-pin-v2",
      version: 2,
      systemPrompt: "Immutable persona version two",
    });
    await serve("release-pin-v2");

    const oldTurn = await sendMessage(
      { userId: USERS[0], sessionId: oldSession.id, content: "stay continuous" },
      { prisma },
    );
    const oldMessage = await prisma.message.findUniqueOrThrow({ where: { id: oldTurn.userMessageId } });
    expect(oldMessage.characterContentVersionId).toBe("content-pin-v1");
    expect(oldMessage.characterReleaseId).toBe("release-pin-v1");

    const oldContext = await buildContext({
      prisma,
      userId: USERS[0],
      characterId: CHARACTER_ID,
      sessionId: oldSession.id,
      memoryEnabled: true,
      userMessageId: oldTurn.userMessageId,
    });
    expect(oldContext.persona.systemPrompt).toBe("Immutable persona version one");
    expect(oldContext.persona.characterReleaseId).toBe("release-pin-v1");

    const newSession = await createSession({ userId: USERS[1], characterId: CHARACTER_ID }, { prisma });
    expect(newSession.characterContentVersionId).toBe("content-pin-v2");
    expect(newSession.characterReleaseId).toBe("release-pin-v2");
  });

  it("pins a legacy un-attributed session only on its first post-cutover turn", async () => {
    const session = await prisma.chatSession.create({
      data: { id: "legacy-unpinned-session", userId: USERS[2], characterId: CHARACTER_ID },
    });
    await prisma.message.create({
      data: {
        id: "legacy-unattributed-message",
        sessionId: session.id,
        role: "user",
        content: "before cutover",
        status: "sent",
      },
    });

    const turn = await sendMessage(
      { userId: USERS[2], sessionId: session.id, content: "after cutover" },
      { prisma },
    );
    const [updatedSession, historical, current] = await Promise.all([
      prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } }),
      prisma.message.findUniqueOrThrow({ where: { id: "legacy-unattributed-message" } }),
      prisma.message.findUniqueOrThrow({ where: { id: turn.userMessageId } }),
    ]);
    expect(updatedSession.characterContentVersionId).toBe("content-pin-v2");
    expect(updatedSession.characterReleaseId).toBe("release-pin-v2");
    expect(historical.characterContentVersionId).toBeNull();
    expect(current.characterContentVersionId).toBe("content-pin-v2");
  });

  it("applies an explicit compatible migration on the next turn and records old/new evidence", async () => {
    const session = await createSession({ userId: USERS[3], characterId: CHARACTER_ID }, { prisma });
    await seedRelease({
      releaseId: "release-pin-v3",
      contentVersionId: "content-pin-v3",
      version: 3,
      systemPrompt: "Compatibility fixed persona version three",
      status: "superseded",
    });

    await consumeInbound(
      {
        eventId: "migrate-session-command-1",
        eventType: MAIN_TO_CHAT_EVENTS.sessionReleaseMigrationRequested,
        payload: {
          commandId: "migrate-session-command-1",
          sessionId: session.id,
          characterId: CHARACTER_ID,
          fromCharacterContentVersionId: "content-pin-v2",
          fromCharacterReleaseId: "release-pin-v2",
          toCharacterContentVersionId: "content-pin-v3",
          toCharacterReleaseId: "release-pin-v3",
          reason: "compatibility repair",
          compatibilityQa: { status: "passed", policyVersion: "compat-v1" },
          requestedById: "admin-1",
        },
      },
      prisma,
    );

    const pending = await prisma.chatSessionReleaseMigration.findUniqueOrThrow({
      where: { commandId: "migrate-session-command-1" },
    });
    expect(pending.status).toBe("pending");

    const turn = await sendMessage(
      { userId: USERS[3], sessionId: session.id, content: "apply the repair" },
      { prisma },
    );
    const [updatedSession, applied, message] = await Promise.all([
      prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } }),
      prisma.chatSessionReleaseMigration.findUniqueOrThrow({ where: { commandId: "migrate-session-command-1" } }),
      prisma.message.findUniqueOrThrow({ where: { id: turn.userMessageId } }),
    ]);
    expect(updatedSession.characterContentVersionId).toBe("content-pin-v3");
    expect(updatedSession.characterReleaseId).toBe("release-pin-v3");
    expect(applied).toMatchObject({
      status: "applied",
      fromCharacterContentVersionId: "content-pin-v2",
      toCharacterContentVersionId: "content-pin-v3",
    });
    expect(applied.appliedAt).not.toBeNull();
    expect(message.characterContentVersionId).toBe("content-pin-v3");
  });
});
