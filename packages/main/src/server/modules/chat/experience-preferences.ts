import { chatExperiencePreferenceSchema, chatExperienceValuesSchema } from "@idream/shared/contracts";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

const inputSchema = chatExperienceValuesSchema.extend({ version: z.number().int().nonnegative() }).strict();
const defaults = { responseLength: "auto", interactionIntensity: "balanced", version: 0 } as const;

async function ownedSession(db: Prisma.TransactionClient, userId: string, sessionId: string) {
  const session = await db.recentChat.findFirst({
    where: { sessionId, userId, user: { status: "active", deletedAt: null }, character: { deletedAt: null } },
    select: { status: true },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  return session;
}

function dto(row: { responseLength: string; interactionIntensity: string; version: number }) {
  return chatExperiencePreferenceSchema.parse({ responseLength: row.responseLength, interactionIntensity: row.interactionIntensity, version: row.version });
}

export async function getChatExperiencePreference(userId: string, sessionId: string) {
  const session = await ownedSession(prisma, userId, sessionId);
  const row = await prisma.chatExperiencePreference.findUnique({ where: { sessionId } });
  return { settings: row ? dto(row) : defaults, editable: session.status === "active" };
}

export async function updateChatExperiencePreference(userId: string, sessionId: string, body: unknown) {
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest("Invalid conversation preferences", { issues: parsed.error.issues });
  const input = parsed.data;
  return prisma.$transaction(async (tx) => {
    // Serialize with Turn acceptance and Clear. A delayed old-session save may
    // never change the context of an accepted Turn or a newly created chat.
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const session = await ownedSession(tx, userId, sessionId);
    if (session.status !== "active") throw Errors.gone("This chat is archived. Open a current conversation to change its preferences");
    const prior = await tx.chatExperiencePreference.findUnique({ where: { sessionId } });
    if ((prior?.version ?? 0) !== input.version) {
      if (prior?.version === input.version + 1 && prior.responseLength === input.responseLength && prior.interactionIntensity === input.interactionIntensity) {
        return { settings: dto(prior), editable: true };
      }
      throw Errors.conflict("Conversation preferences changed elsewhere. Reload before saving");
    }
    const data = { responseLength: input.responseLength, interactionIntensity: input.interactionIntensity, version: input.version + 1 };
    const saved = prior
      ? await tx.chatExperiencePreference.update({ where: { sessionId }, data })
      : await tx.chatExperiencePreference.create({ data: { ...data, sessionId } });
    return { settings: dto(saved), editable: true };
  });
}
