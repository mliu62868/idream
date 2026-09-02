import { createHash } from "node:crypto";
import { CHAT_PIN_LIMIT, chatContextDirectiveSchema, chatContextDirectivesSchema } from "@idream/shared/contracts";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

const versionSchema = z.object({ version: z.number().int().positive() }).strict();
const updateSchema = versionSchema.extend({ content: z.string() }).strict();

async function ownedContext(db: Prisma.TransactionClient, userId: string, sessionId: string, requireActive = false) {
  const session = await db.recentChat.findFirst({
    where: { sessionId, userId, user: { status: "active", deletedAt: null }, character: { deletedAt: null } },
    select: { characterId: true, status: true },
  });
  if (!session) throw Errors.notFound("Chat session not found");
  // Clear archives old sessions under the same user lock. A delayed write must
  // not repopulate cleared pins or change settings through that old session.
  if (requireActive && session.status !== "active") {
    throw Errors.gone("This chat is archived. Open a current conversation to change saved context");
  }
  return { userId, characterId: session.characterId };
}

function directiveDto(item: { id: string; kind: string; content: string; version: number }) {
  return chatContextDirectiveSchema.parse({ id: item.id, kind: item.kind, content: item.content, version: item.version });
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw Errors.badRequest("Invalid chat context settings", { issues: parsed.error.issues });
  return parsed.data;
}

export async function listChatContextDirectives(userId: string, sessionId: string) {
  const scope = await ownedContext(prisma, userId, sessionId);
  const items = await prisma.chatContextDirective.findMany({
    where: { ...scope, status: "active" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { items: chatContextDirectivesSchema.parse(items.map(directiveDto)) };
}

export async function createChatContextDirective(userId: string, sessionId: string, body: unknown, idempotencyKey: string | null) {
  if (!idempotencyKey?.trim() || idempotencyKey.length > 160) throw Errors.badRequest("Idempotency-Key is required (at most 160 characters)");
  const content = parseInput(z.object({ kind: z.enum(["pinned_memory", "custom_instruction"]), content: z.string() }).strict(), body);
  const id = `chatctx_${createHash("sha256").update(JSON.stringify([userId, sessionId, idempotencyKey])).digest("hex")}`;
  const next = parseInput(chatContextDirectiveSchema, { ...content, id, version: 1 });
  return prisma.$transaction(async (tx) => {
    // Same lock as Turn acceptance and clear-memory: limits and the chosen snapshot are atomic.
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const scope = await ownedContext(tx, userId, sessionId, true);
    const prior = await tx.chatContextDirective.findUnique({ where: { id } });
    if (prior) {
      if (prior.userId !== scope.userId || prior.characterId !== scope.characterId || prior.status !== "active" || prior.version !== 1 || prior.kind !== next.kind || prior.content !== next.content) {
        throw Errors.conflict("This context request was already used; reload your settings");
      }
      return { item: directiveDto(prior) };
    }
    const count = await tx.chatContextDirective.count({ where: { ...scope, kind: next.kind, status: "active" } });
    if (count >= (next.kind === "pinned_memory" ? CHAT_PIN_LIMIT : 1)) {
      throw Errors.conflict(next.kind === "pinned_memory" ? `You can pin up to ${CHAT_PIN_LIMIT} memories` : "Edit the existing custom instructions instead");
    }
    const saved = await tx.chatContextDirective.create({ data: { ...next, ...scope } });
    return { item: directiveDto(saved) };
  });
}

export async function updateChatContextDirective(userId: string, sessionId: string, id: string, body: unknown) {
  const input = parseInput(updateSchema, body);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const scope = await ownedContext(tx, userId, sessionId, true);
    const prior = await tx.chatContextDirective.findFirst({ where: { id, ...scope, status: "active" } });
    if (!prior) throw Errors.notFound("Chat context setting not found");
    const next = parseInput(chatContextDirectiveSchema, { id, kind: prior.kind, content: input.content, version: prior.version });
    if (prior.version !== input.version) {
      if (prior.version === input.version + 1 && prior.content === next.content) return { item: directiveDto(prior) };
      throw Errors.conflict("This setting changed elsewhere. Reload before saving");
    }
    const saved = await tx.chatContextDirective.update({ where: { id }, data: { content: next.content, version: { increment: 1 } } });
    return { item: directiveDto(saved) };
  });
}

export async function deleteChatContextDirective(userId: string, sessionId: string, id: string, body: unknown) {
  const input = parseInput(versionSchema, body);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`;
    const scope = await ownedContext(tx, userId, sessionId, true);
    const prior = await tx.chatContextDirective.findFirst({ where: { id, ...scope } });
    if (!prior) throw Errors.notFound("Chat context setting not found");
    if (prior.status === "archived" && prior.version === input.version + 1) return { ok: true };
    if (prior.status !== "active" || prior.version !== input.version) throw Errors.conflict("This setting changed elsewhere. Reload before removing it");
    // Unpinning removes future explicit context; it does not rewrite conversations or igrep's learned history.
    await tx.chatContextDirective.update({ where: { id }, data: { status: "archived", content: "", version: { increment: 1 } } });
    return { ok: true };
  });
}
