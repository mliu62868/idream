import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { getAuthCtx, requireAgeGate, requireAgeVerified, requireUser } from "@/server/lib/auth";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { generationJobSchema } from "@/server/modules/ourdream/generation-request-schema";
import { generationQuoteAuthoritySchema, quoteGeneration } from "@/server/modules/ourdream/generation-quote";
import { createGenerationJobForUser } from "@/server/modules/ourdream/generation-job-create";
import { findExistingGenerationJob, generationWriteRequestFingerprint, wakeQueuedGenerationDispatch } from "@/server/modules/ourdream/generation-job-authority";
import { generationJobInclude, type GenerationJobWithRelations } from "@/server/modules/ourdream/generation-job-read-model";
import { generationContextSource, resolveGenerationContext } from "@/server/modules/ourdream/generation-context";
import { assertChatVideoAvailable, chatVideoCapability } from "./video-availability";
import { cancelChatVideo } from "./video-cancel";

export const chatVideoRequestSchema = z.object({
  generationContextToken: z.string().min(1).max(4096),
  prompt: z.string().trim().min(1).max(900),
  model: z.string().trim().min(1).max(80).optional(),
  quoteAuthority: generationQuoteAuthoritySchema.optional(),
}).strict();

type VideoRequest = z.infer<typeof chatVideoRequestSchema>;

export function chatVideoAttachmentId(userId: string, key: string) {
  return `chatvideo_${createHash("sha256").update(JSON.stringify([userId, key])).digest("hex").slice(0, 48)}`;
}

async function resolveChatVideoRequest(userId: string, sessionId: string, request: VideoRequest, key: string) {
  const context = await resolveGenerationContext(userId, request.generationContextToken);
  if (context.source.kind !== "chat" || context.source.sessionId !== sessionId) throw Errors.conflict("The selected image belongs to a different chat. Open Animate on the original reply.");
  if (!context.sourceMedia || !context.characterId || !context.pins) throw Errors.badRequest("Choose a delivered image in this chat before requesting a video.");
  const body = generationJobSchema.parse({
    mode: "video", characterId: context.characterId,
    generationContextToken: request.generationContextToken, prompt: request.prompt,
    model: request.model, outputCount: 1, quoteAuthority: request.quoteAuthority,
  });
  const source = {
    ...generationContextSource(context, request.generationContextToken, key),
    sourceType: "chat_video", sourceId: chatVideoAttachmentId(userId, key),
  };
  return { body, source, binding: { sessionId, turnId: context.source.turnId, attempt: context.source.attempt } };
}

export async function quoteChatVideo(userId: string, sessionId: string, raw: unknown) {
  const request = chatVideoRequestSchema.parse(raw);
  await assertChatVideoAvailable(userId);
  const { body, source } = await resolveChatVideoRequest(userId, sessionId, request, "quote");
  const { quote } = await quoteGeneration({ userId, body, source, profileSelectionAuthority: "specialized" });
  return quote;
}

export async function createChatVideo(userId: string, sessionId: string, key: string, raw: unknown) {
  const request = chatVideoRequestSchema.parse(raw);
  const requestFingerprint = generationWriteRequestFingerprint("generation.create", request, `chat-video:${sessionId}`);
  // A receipt is an accepted fact even after the product gate closes or the
  // source Turn is edited. New requests still revalidate the original source.
  const existing = await findExistingGenerationJob(userId, { idempotencyKey: key, requestFingerprint });
  if (existing) {
    if (existing.sourceType !== "chat_video") throw Errors.conflict("This request key belongs to another generation action.");
    await wakeQueuedGenerationDispatch(existing);
    return existing;
  }
  await assertChatVideoAvailable(userId);
  const { body, source, binding } = await resolveChatVideoRequest(userId, sessionId, request, key);
  return createGenerationJobForUser(userId, body, {
    idempotencyKey: key, requestFingerprint, source,
    chatAttachment: binding,
    profileSelectionAuthority: "specialized", requireQuoteAuthority: true,
  });
}

export async function dispatchChatVideo(
  request: Request,
  segments: string[],
  renderJob: (job: GenerationJobWithRelations) => unknown,
): Promise<Response | null> {
  const [resource, sessionId, action, child] = segments;
  const cancellation = resource === "generation" && sessionId === "jobs" && action && child === "cancel" && segments.length === 4 && request.method === "POST";
  if (!cancellation && (resource !== "chat" || !sessionId || action !== "video" || segments.length > 4)) return null;
  if (cancellation) {
    const ctx = await getAuthCtx(request);
    const user = requireUser(ctx);
    requireAgeGate(ctx);
    requireAgeVerified(ctx);
    const expected = request.headers.get("x-idream-viewer-scope");
    if (expected !== null && expected !== `user:${user.id}`) throw Errors.conflict("Your account changed. Sign in to the original account before cancelling this request.");
    return ok(await cancelChatVideo(user.id, action));
  }
  if (!(request.method === "GET" && !child) && !(request.method === "POST" && (!child || child === "quote"))) return null;
  const ctx = await getAuthCtx(request);
  const user = requireUser(ctx);
  requireAgeGate(ctx);
  requireAgeVerified(ctx);
  const expected = request.headers.get("x-idream-viewer-scope");
  if (expected !== null && expected !== `user:${user.id}`) throw Errors.conflict("Your account changed. Sign in to the original account before checking this request.");
  if (request.method === "GET") {
    const session = await prisma.recentChat.findFirst({ where: { sessionId, userId: user.id, status: { not: "deleted" } }, select: { sessionId: true } });
    if (!session) throw Errors.notFound("Chat session not found");
    return ok({ capability: await chatVideoCapability(user.id) });
  }
  const raw: unknown = await request.json();
  if (child === "quote") return ok({ quote: await quoteChatVideo(user.id, sessionId, raw) });
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length < 8 || key.length > 160) throw Errors.badRequest("Idempotency-Key must be between 8 and 160 characters");
  const job = await createChatVideo(user.id, sessionId, key, raw);
  const stored = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id }, include: generationJobInclude() });
  return ok(renderJob(stored), { status: 202 });
}
