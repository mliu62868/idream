import { chatExperiencePreferenceSchema, chatExperienceValuesSchema, type ConversationProfileSnapshot } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { CONVERSATION_PROFILE_CATALOG, DEFAULT_PROFILE_EXPERIENCE, conversationProfileSnapshot } from "./conversation-profiles";

const inputSchema = chatExperienceValuesSchema.omit({ conversationProfile: true }).extend({
  version: z.number().int().nonnegative(),
  conversationProfile: z.object({ id: z.string().min(1).max(80), version: z.number().int().nonnegative() }).strict().nullish(),
}).strict();

async function ownedSession(db: Prisma.TransactionClient, userId: string, sessionId: string) {
  const session = await db.recentChat.findFirst({
    where: { sessionId, userId, user: { status: "active", deletedAt: null }, character: { deletedAt: null } },
    select: { status: true },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  return session;
}

function dto(row: { responseLength: string; interactionIntensity: string; sceneGeneration: string; version: number; conversationProfile: Prisma.JsonValue | null }) {
  return chatExperiencePreferenceSchema.parse({ responseLength: row.responseLength, interactionIntensity: row.interactionIntensity, sceneGeneration: row.sceneGeneration, version: row.version,
    ...(row.conversationProfile ? { conversationProfile: row.conversationProfile } : {}),
  });
}

export async function getChatExperiencePreference(userId: string, sessionId: string) {
  const session = await ownedSession(prisma, userId, sessionId);
  const row = await prisma.chatExperiencePreference.findUnique({ where: { sessionId } });
  return { settings: row ? dto(row) : DEFAULT_PROFILE_EXPERIENCE, editable: session.status === "active", catalog: CONVERSATION_PROFILE_CATALOG };
}

export async function updateChatExperiencePreference(userId: string, sessionId: string, body: unknown) {
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest("Invalid conversation preferences", { issues: parsed.error.issues });
  const input = parsed.data;
  let profile: ConversationProfileSnapshot | null = null;
  if (input.conversationProfile) {
    profile = conversationProfileSnapshot(input.conversationProfile.id, input.conversationProfile.version);
    if (!profile) throw Errors.conflict("This conversation profile changed. Reload before choosing it");
    const entry = CONVERSATION_PROFILE_CATALOG.items.find(item => item.id === profile!.id)!;
    if (input.responseLength !== entry.preferences.responseLength || input.interactionIntensity !== entry.preferences.interactionIntensity || input.sceneGeneration !== entry.preferences.sceneGeneration) {
      throw Errors.badRequest("Profile preferences do not match the selected version");
    }
  }
  return prisma.$transaction(async (tx) => {
    // Serialize with Turn acceptance and Clear. A delayed old-session save may
    // never change the context of an accepted Turn or a newly created chat.
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const session = await ownedSession(tx, userId, sessionId);
    if (session.status !== "active") throw Errors.gone("This chat is archived. Open a current conversation to change its preferences");
    const prior = await tx.chatExperiencePreference.findUnique({ where: { sessionId } });
    if ((prior?.version ?? 0) !== input.version) {
      if (prior?.version === input.version + 1 && prior.responseLength === input.responseLength && prior.interactionIntensity === input.interactionIntensity && prior.sceneGeneration === input.sceneGeneration && JSON.stringify(dto(prior).conversationProfile ?? null) === JSON.stringify(profile)) {
        return { settings: dto(prior), editable: true, catalog: CONVERSATION_PROFILE_CATALOG };
      }
      throw Errors.conflict("Conversation preferences changed elsewhere. Reload before saving");
    }
    const data = { responseLength: input.responseLength, interactionIntensity: input.interactionIntensity, sceneGeneration: input.sceneGeneration, conversationProfile: profile ?? Prisma.DbNull, version: input.version + 1 };
    const saved = prior
      ? await tx.chatExperiencePreference.update({ where: { sessionId }, data })
      : await tx.chatExperiencePreference.create({ data: { ...data, sessionId } });
    return { settings: dto(saved), editable: true, catalog: CONVERSATION_PROFILE_CATALOG };
  });
}
