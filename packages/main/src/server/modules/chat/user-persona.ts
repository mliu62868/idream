import { userChatPersonaResponseSchema, userChatPersonaSchema, userChatPersonaValuesSchema } from "@idream/shared/contracts";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

const versionSchema = z.object({ ownerScope: z.string().startsWith("user:").max(240), version: z.number().int().nonnegative() }).strict();
const updateSchema = userChatPersonaValuesSchema.extend(versionSchema.shape).strict()
  .refine(value => Boolean(value.name || value.description), { message: "Add a name or description, or clear your persona" });

async function requireActiveUser(db: Prisma.TransactionClient, userId: string) {
  if (!await db.user.findFirst({ where: { id: userId, status: "active", deletedAt: null }, select: { id: true } })) {
    throw Errors.notFound("Account is not active");
  }
}

async function currentSettings(db: Prisma.TransactionClient, userId: string) {
  const row = await db.userPreferences.findUnique({
    where: { userId }, select: { chatPersona: true, chatPersonaVersion: true },
  });
  const version = row?.chatPersonaVersion ?? 0;
  const persona = row?.chatPersona == null ? null : userChatPersonaSchema.parse({ ...userChatPersonaValuesSchema.parse(row.chatPersona), version });
  return userChatPersonaResponseSchema.parse({ ownerScope: `user:${userId}`, persona, version });
}

export async function getUserChatPersona(userId: string) {
  await requireActiveUser(prisma, userId);
  return currentSettings(prisma, userId);
}

/** Explicit self-description, copied once by Turn acceptance; never an igrep ingest. */
export async function userChatPersonaForTurn(tx: Prisma.TransactionClient, userId: string) {
  return (await currentSettings(tx, userId)).persona;
}

export async function updateUserChatPersona(userId: string, body: unknown) {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest("Invalid chat persona", { issues: parsed.error.issues });
  const { ownerScope, version, ...persona } = parsed.data;
  // This is an expectation from GET, never authentication. Cookies may have
  // switched accounts after the old page loaded, even at the same CAS version.
  if (ownerScope !== `user:${userId}`) throw Errors.forbidden("The signed-in account changed. Reload this page before editing your persona");
  return prisma.$transaction(async tx => {
    // Serialize with Turn acceptance. Old responses may not restore cleared settings.
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await requireActiveUser(tx, userId);
    const current = await currentSettings(tx, userId);
    if (current.version !== version) {
      if (current.version === version + 1 && current.persona?.enabled === persona.enabled && current.persona.name === persona.name && current.persona.description === persona.description) return current;
      throw Errors.conflict("Your chat persona changed elsewhere. Reload before saving");
    }
    const data = { chatPersona: persona, chatPersonaVersion: version + 1 };
    await tx.userPreferences.upsert({
      where: { userId }, update: data,
      create: { userId, mutedTags: [], safeModeFlags: {}, notificationSettings: {}, ...data },
    });
    return currentSettings(tx, userId);
  });
}

export async function clearUserChatPersona(userId: string, body: unknown) {
  const parsed = versionSchema.safeParse(body);
  if (!parsed.success) throw Errors.badRequest("Invalid chat persona version", { issues: parsed.error.issues });
  if (parsed.data.ownerScope !== `user:${userId}`) throw Errors.forbidden("The signed-in account changed. Reload this page before editing your persona");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    await requireActiveUser(tx, userId);
    const current = await currentSettings(tx, userId);
    if (current.version !== parsed.data.version) {
      if (current.version === parsed.data.version + 1 && current.persona === null) return current;
      throw Errors.conflict("Your chat persona changed elsewhere. Reload before clearing");
    }
    const data = { chatPersona: Prisma.DbNull, chatPersonaVersion: current.version + 1 };
    await tx.userPreferences.upsert({
      where: { userId }, update: data,
      create: { userId, mutedTags: [], safeModeFlags: {}, notificationSettings: {}, ...data },
    });
    return currentSettings(tx, userId);
  });
}
