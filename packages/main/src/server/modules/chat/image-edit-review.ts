import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { confirmedImageEditSchema, CONFIRMED_IMAGE_EDIT_VERSION, imageEditOperationSchema, type ConfirmedImageEdit } from "@idream/shared/chat/image-action";
import type { ChatImageRequestedPayload } from "@/server/ai/schemas";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { getAuthCtx, requireAgeGate, requireAgeVerified, requireUser } from "@/server/lib/auth";
import { ok } from "@/server/lib/http";
import { canonicalJsonHash } from "@/server/modules/admin-v2/shared/idempotency";
import { lockCharacterGenerationAuthority, lockMediaAssetAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { assertGenerationSourceImageAuthority, wakeQueuedGenerationDispatch } from "@/server/modules/ourdream/generation-job-authority";
import { assertOriginalImageGeometry, prepareGenerationJobForUser } from "@/server/modules/ourdream/generation-job-create";
import { generationQuoteAuthoritySchema, quoteAuthorityFor, quoteGeneration } from "@/server/modules/ourdream/generation-quote";
import { freezeGenerationSource, GENERATION_SOURCE_CHUNK_BYTES, type FrozenGenerationSource, withGenerationSnapshotSlot } from "@/server/modules/ourdream/generation-source-snapshot";
import { chatImageGenerationRequest } from "@/server/modules/ourdream/service";
import { attachmentAttempt, lockChatScope, type LockedChatScope } from "./turn-scope";
import { transitionToolEffectAttachment } from "./tool-effect-attachment";
import { isReadableChatMedia, readableOwnedChatMediaWhere } from "./chat-media-history";

export const CHAT_EDIT_MASK_MAX_BYTES = 512 * 1024;
export const CHAT_EDIT_MAX_PIXELS = 4_194_304;
const SOURCE_UNAVAILABLE = "The original image is no longer available for editing.";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const editDraftSchema = z.object({
  version: z.literal(1), fingerprint: digest, userContentDigest: digest,
  sourceMediaAssetId: z.string().min(1), sourceSnapshotId: z.string().min(1),
  sourceSha256: digest, originalSha256: digest, sizeBytes: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  subject: z.enum(["companion", "scene"]), target: z.string().min(1), selection: z.enum(["one", "all"]),
  createdAt: z.iso.datetime(),
}).strict();
type EditDraft = z.infer<typeof editDraftSchema>;
const editDraftIdentitySchema = z.object({ attempt: z.number().int().positive(), draftFingerprint: digest }).strict();
export const confirmChatImageEditSchema = editDraftIdentitySchema.extend({
  sourceSha256: digest,
  maskPngBase64: z.string().min(1).max(699_052), maskSha256: digest,
  operation: imageEditOperationSchema, quoteAuthority: generationQuoteAuthoritySchema,
}).strict();
type Confirmation = z.infer<typeof confirmChatImageEditSchema>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function sha256(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function hasPngAnimation(bytes: Uint8Array): boolean {
  const png = Buffer.from(bytes);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) return true;
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL") return true;
    if (type === "IEND") return length !== 0 || offset + 12 !== png.length;
    offset += 12 + length;
  }
  return true;
}

/** Freeze the frame users will paint on. This creates no Job, dispatch or debit. */
export async function createChatImageEditDraft(payload: ChatImageRequestedPayload, attempt: number) {
  const scope = payload.controls.editScope;
  const sourceMediaAssetId = payload.controls.sourceImageAssetId;
  if (scope?.mode !== "local" || !sourceMediaAssetId || !payload.exchangeId) throw Errors.badRequest("A local edit requires its original delivered image and Turn.");
  return prisma.$transaction(async tx => {
    const locked = await lockChatScope(tx, { userId: payload.userId, at: { attachment: payload.attachmentId }, expect: {
      attempt, assistantStatus: ["pending", "generating"], attachmentAttemptMatchesTurn: true,
    } });
    const attachment = locked.attachment;
    if (!attachment || !locked.turn || locked.turn.id !== payload.exchangeId || locked.session.sessionId !== payload.sessionId) throw Errors.conflict("The image edit changed before its source could be frozen.");
    if (attachment.status === "awaiting_confirmation") return attachment;
    if (attachment.status !== "requesting" || attachment.generationJobId) throw Errors.conflict("This image action was already accepted.");
    await lockMediaAssetAuthority(tx, sourceMediaAssetId);
    const source = await withGenerationSnapshotSlot(async () => {
      const verified = await assertGenerationSourceImageAuthority(tx, { sourceImageAssetId: sourceMediaAssetId, userId: payload.userId, characterId: payload.characterId, verifyImagePixels: true });
      if (!verified || verified.pages !== 1 || hasPngAnimation(verified.bytes) || verified.width * verified.height > CHAT_EDIT_MAX_PIXELS) throw Errors.conflict("Choose a single-frame image of at most four megapixels for a local edit.");
      const canonical = await sharp(verified.bytes, { limitInputPixels: CHAT_EDIT_MAX_PIXELS, failOn: "warning" })
        .rotate().toColourspace("srgb").ensureAlpha().png().timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
      return { snapshot: await freezeGenerationSource(tx, { userId: payload.userId, bytes: canonical.data, contentType: "image/png" }),
        width: canonical.info.width, height: canonical.info.height, originalSha256: sha256(verified.bytes) };
    });
    const facts = {
      version: 1 as const, userContentDigest: sha256(locked.turn.userContent),
      sourceMediaAssetId, sourceSnapshotId: source.snapshot.id, sourceSha256: source.snapshot.sha256,
      originalSha256: source.originalSha256, sizeBytes: source.snapshot.sizeBytes, width: source.width, height: source.height,
      subject: payload.subject, target: scope.target, selection: scope.selection, createdAt: new Date().toISOString(),
    };
    const draft = editDraftSchema.parse({ ...facts, fingerprint: canonicalJsonHash({ ...facts, attachmentId: attachment.id, instruction: attachment.promptHint }) });
    return transitionToolEffectAttachment(tx, attachment, { to: "awaiting_confirmation", width: draft.width, height: draft.height,
      metadata: { ...record(attachment.metadata), imageSubject: payload.subject, costDreamcoins: 0, editDraft: draft },
    });
  }, { timeout: 30_000 });
}

async function readDraft(userId: string, attachmentId: string) {
  const attachment = await prisma.chatTurnAttachment.findFirst({ where: { id: attachmentId, kind: "generated_image", turn: { session: { userId, status: { not: "deleted" } } } }, include: { turn: { include: { session: true } } } });
  if (!attachment) throw Errors.notFound("Image edit not found.");
  const draft = editDraftSchema.safeParse(record(attachment.metadata).editDraft);
  if (!draft.success || record(attachment.metadata).turnActionInvalidatedByEdit === true || attachmentAttempt(attachment.metadata) !== attachment.turn.attempt || draft.data.userContentDigest !== sha256(attachment.turn.userContent)) throw Errors.conflict("This image edit changed. Open its current confirmation card.");
  if (attachment.turn.userStatus !== "sent") throw Errors.conflict("This image edit is no longer available.");
  return { attachment, draft: draft.data };
}

async function canReadDraftSource(userId: string, characterId: string, draft: EditDraft) {
  const source = await prisma.mediaAsset.findFirst({ where: { id: draft.sourceMediaAssetId, ...readableOwnedChatMediaWhere(userId, characterId), characterId: draft.subject === "scene" ? null : characterId } });
  return !!source && isReadableChatMedia(source);
}

function assertLockedDraft(scope: LockedChatScope, identity: z.infer<typeof editDraftIdentitySchema>, expected: EditDraft) {
  const attachment = scope.attachment;
  const draft = editDraftSchema.safeParse(record(attachment?.metadata).editDraft);
  if (!attachment || !scope.turn || !draft.success || scope.turn.userStatus !== "sent" || scope.turn.attempt !== identity.attempt || attachmentAttempt(attachment.metadata) !== identity.attempt || draft.data.fingerprint !== identity.draftFingerprint || draft.data.fingerprint !== expected.fingerprint || draft.data.userContentDigest !== sha256(scope.turn.userContent) || record(attachment.metadata).turnActionInvalidatedByEdit === true) {
    throw Errors.conflict("This image edit changed. Open its current confirmation card.");
  }
  return attachment;
}

function draftPayload(attachment: Awaited<ReturnType<typeof readDraft>>["attachment"], draft: EditDraft): ChatImageRequestedPayload {
  const turn = attachment.turn;
  const intent = record(record(attachment.metadata).effect).intent;
  return {
    version: 1, kind: "chat.image.requested", requestId: `chat-tool:${attachment.id}`, attachmentId: attachment.id,
    sessionId: turn.sessionId, exchangeId: turn.id, messageId: turn.assistantMessageId, userId: turn.session.userId,
    characterId: turn.session.characterId, subject: draft.subject,
    ...(turn.characterReleaseId ? { characterReleaseId: turn.characterReleaseId } : {}),
    ...(turn.characterVisualProfileId ? { visualProfileId: turn.characterVisualProfileId } : {}),
    ...(turn.characterVisualProfileVersion ? { visualProfileVersion: turn.characterVisualProfileVersion } : {}),
    promptHint: attachment.promptHint, conversationContext: turn.userContent,
    intent: { requestedNudity: record(intent).requestedNudity === "full" ? "full" : record(intent).requestedNudity === "none" ? "none" : "unspecified" },
    controls: { orientation: "original", outputCount: 1, sourceImageAssetId: draft.sourceMediaAssetId,
      editScope: { mode: "local", target: draft.target, selection: draft.selection } },
  };
}

function frozenSource(draft: EditDraft): FrozenGenerationSource & { width: number; height: number } {
  return { id: draft.sourceSnapshotId, sha256: draft.sourceSha256, sizeBytes: draft.sizeBytes, contentType: "image/png", width: draft.width, height: draft.height };
}

function confirmedPin(draft: EditDraft, input: Pick<Confirmation, "maskPngBase64" | "maskSha256" | "operation">, confirmationId: string): ConfirmedImageEdit {
  return confirmedImageEditSchema.parse({ version: CONFIRMED_IMAGE_EDIT_VERSION, mode: "local", target: draft.target,
    selection: draft.selection, sourceSnapshotId: draft.sourceSnapshotId, sourceSha256: draft.sourceSha256,
    width: draft.width, height: draft.height, ...input, confirmationId, confirmedAt: new Date().toISOString() });
}

export async function reviewChatImageEdit(userId: string, attachmentId: string) {
  const { attachment, draft } = await readDraft(userId, attachmentId);
  if (attachment.status !== "awaiting_confirmation") throw Errors.conflict("This image edit is no longer awaiting confirmation.");
  const unavailable: { generate?: string; recolor?: string } = {};
  const quotes: { generate: ReturnType<typeof quoteAuthorityFor>; recolor: ReturnType<typeof quoteAuthorityFor> } = { generate: null, recolor: null };
  // The owner still needs the draft identity to cancel after source access is revoked.
  const sourceAvailable = await canReadDraftSource(userId, attachment.turn.session.characterId, draft);
  for (const kind of ["generate", "recolor"] as const) {
    if (!sourceAvailable) { unavailable[kind] = SOURCE_UNAVAILABLE; continue; }
    try {
      // Quote selection uses only the operation kind. No guessed mask is
      // submitted or stored, and the color cannot affect this fixed-cost route.
      const request = await chatImageGenerationRequest(draftPayload(attachment, draft), attachment.turn.attempt, undefined, kind === "recolor" ? "recolor" : undefined);
      const { plan, quote } = await quoteGeneration({ userId, body: request.body, source: request.options.source, profileSelectionAuthority: "specialized", frozenSourceAssetId: draft.sourceMediaAssetId,
        expectedVisualProfileVersion: request.options.expectedVisualProfileVersion,
        expectedReferenceSetRevisionId: request.options.expectedReferenceSetRevisionId,
        requireCharacterVisualIdentity: request.options.requireCharacterVisualIdentity,
        fallbackToActiveOnStaleVisualProfile: request.options.fallbackToActiveOnStaleVisualProfile,
      });
      assertOriginalImageGeometry(draft, plan.profile, kind === "recolor");
      if (kind === "recolor" && (plan.profile.runner !== "local-image" || plan.profile.costMultiplier !== 0)) throw Errors.conflict("The local recoloring route is unavailable.");
      quotes[kind] = quoteAuthorityFor(quote, 1);
    } catch (error) { unavailable[kind] = error instanceof Error ? error.message : "This edit route is unavailable."; }
  }
  return { attachmentId, turnId: attachment.turnId, attempt: attachment.turn.attempt, status: "awaiting_confirmation" as const,
    draftFingerprint: draft.fingerprint, instruction: attachment.promptHint ?? "", target: draft.target,
    source: { mediaAssetId: draft.sourceMediaAssetId, snapshotId: draft.sourceSnapshotId, sha256: draft.sourceSha256,
      width: draft.width, height: draft.height, contentType: "image/png" as const, url: `/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}/edit-review/source` },
    quotes, ...(Object.keys(unavailable).length ? { unavailable } : {}), limits: { maskMaxBytes: CHAT_EDIT_MASK_MAX_BYTES, maxPixels: CHAT_EDIT_MAX_PIXELS },
  };
}

/** Canonicalize browser PNG encoding only; never resize, threshold or infer pixels. */
export async function validateConfirmedEditMask(input: Pick<Confirmation, "maskPngBase64" | "maskSha256">, source: { width: number; height: number }) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.maskPngBase64)) throw Errors.badRequest("Mask must be canonical PNG base64.");
  const bytes = Buffer.from(input.maskPngBase64, "base64");
  if (!bytes.length || bytes.length > CHAT_EDIT_MASK_MAX_BYTES || bytes.toString("base64") !== input.maskPngBase64 || sha256(bytes) !== input.maskSha256) throw Errors.badRequest("Mask size or checksum is invalid.");
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes[24] !== 8 || ![0, 2, 6].includes(bytes[25]!) || hasPngAnimation(bytes)) throw Errors.badRequest("Mask must be a single-frame 8-bit PNG.");
  try {
    const image = sharp(bytes, { limitInputPixels: CHAT_EDIT_MAX_PIXELS, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.pages && metadata.pages !== 1 || metadata.width !== source.width || metadata.height !== source.height || metadata.depth !== "uchar" || (metadata.orientation ?? 1) !== 1) throw new Error("geometry");
    const { data, info } = await image.toColourspace("srgb").ensureAlpha().raw().timeout({ seconds: 10 }).toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) throw new Error("channels");
    const pixels = Buffer.alloc(source.width * source.height);
    for (let p = 0; p < pixels.length; p++) {
      const offset = p * 4; const value = data[offset]!;
      if ((value !== 0 && value !== 255) || data[offset + 1] !== value || data[offset + 2] !== value || data[offset + 3] !== 255) throw new Error("binary");
      pixels[p] = value;
    }
    if (!pixels.some(value => value === 255)) throw new Error("empty");
    const canonical = await sharp(pixels, { raw: { width: source.width, height: source.height, channels: 1 } }).toColourspace("b-w").png().toBuffer();
    if (canonical.length > CHAT_EDIT_MASK_MAX_BYTES) throw new Error("size");
    return { maskPngBase64: canonical.toString("base64"), maskSha256: sha256(canonical) };
  } catch { throw Errors.badRequest("Mask must match the source dimensions and contain only opaque black and white pixels, with a nonempty white selection."); }
}

export async function confirmChatImageEdit(userId: string, attachmentId: string, key: string, raw: unknown) {
  const input = confirmChatImageEditSchema.parse(raw);
  const { attachment, draft } = await readDraft(userId, attachmentId);
  if (input.attempt !== attachment.turn.attempt || input.draftFingerprint !== draft.fingerprint || input.sourceSha256 !== draft.sourceSha256) throw Errors.conflict("The image source or draft changed. Reopen this edit.");
  const mask = await validateConfirmedEditMask(input, draft);
  const fingerprint = canonicalJsonHash({ draftFingerprint: draft.fingerprint, sourceSha256: input.sourceSha256, maskSha256: mask.maskSha256, operation: input.operation });
  if (attachment.generationJobId) {
    // Exact receipts survive subsequent price/route changes. The original
    // draft/attempt and confirmation identity are still checked under its lock.
    const accepted = await prisma.$transaction(async tx => {
      const scope = await lockChatScope(tx, { userId, at: { attachment: attachmentId }, expect: { attempt: input.attempt, attachmentAttemptMatchesTurn: true } });
      const current = assertLockedDraft(scope, input, draft);
      if (record(record(current.metadata).editConfirmation).fingerprint !== fingerprint || !current.generationJobId) throw Errors.conflict("This edit was already confirmed with a different area or operation.");
      return tx.generationJob.findUniqueOrThrow({ where: { id: current.generationJobId } });
    });
    await wakeQueuedGenerationDispatch(accepted);
    return { attachmentId, generationJobId: accepted.id, status: accepted.status, costDreamcoins: accepted.costDreamcoins };
  }
  if (attachment.status !== "awaiting_confirmation") throw Errors.conflict("This edit is no longer awaiting confirmation.");
  if (!await canReadDraftSource(userId, attachment.turn.session.characterId, draft)) throw Errors.gone(SOURCE_UNAVAILABLE);
  const pin = confirmedPin(draft, { ...mask, operation: input.operation }, `chat-edit:${attachmentId}:${fingerprint.slice(0, 24)}`);
  const { body, options } = await chatImageGenerationRequest(draftPayload(attachment, draft), input.attempt, pin);
  body.quoteAuthority = input.quoteAuthority;
  options.requestFingerprint = fingerprint;
  options.frozenImageSource = frozenSource(draft);
  const admit = await prepareGenerationJobForUser(userId, body, options);
  const job = await prisma.$transaction(async tx => {
    const scope = await lockChatScope(tx, { userId, at: { attachment: attachmentId }, expect: { attempt: input.attempt, attachmentAttemptMatchesTurn: true } });
    const current = assertLockedDraft(scope, input, draft);
    const previous = record(record(current.metadata).editConfirmation);
    if (previous.fingerprint && previous.fingerprint !== fingerprint) throw Errors.conflict("This edit was already confirmed with a different area or operation.");
    if (current.generationJobId) {
      if (previous.fingerprint !== fingerprint) throw Errors.conflict("This edit was already accepted.");
      return tx.generationJob.findUniqueOrThrow({ where: { id: current.generationJobId } });
    }
    if (current.status !== "awaiting_confirmation") throw Errors.conflict("This edit is no longer awaiting confirmation.");
    await lockCharacterGenerationAuthority(tx, scope.session.characterId);
    await lockMediaAssetAuthority(tx, draft.sourceMediaAssetId);
    const source = await tx.mediaAsset.findFirst({ where: { id: draft.sourceMediaAssetId, ...readableOwnedChatMediaWhere(userId, scope.session.characterId), characterId: draft.subject === "scene" ? null : scope.session.characterId } });
    if (!source || !isReadableChatMedia(source)) throw Errors.gone(SOURCE_UNAVAILABLE);
    await transitionToolEffectAttachment(tx, current, { to: "awaiting_confirmation", metadata: { ...record(current.metadata), editConfirmation: { fingerprint, idempotencyKey: key, confirmationId: pin.confirmationId, confirmedAt: pin.confirmedAt } } });
    return admit(tx);
  }, { timeout: 30_000 });
  await wakeQueuedGenerationDispatch(job);
  return { attachmentId, generationJobId: job.id, status: job.status, costDreamcoins: job.costDreamcoins };
}

export async function cancelChatImageEdit(userId: string, attachmentId: string, raw: unknown) {
  const identity = editDraftIdentitySchema.parse(raw);
  const { draft } = await readDraft(userId, attachmentId);
  await prisma.$transaction(async tx => {
    const scope = await lockChatScope(tx, { userId, at: { attachment: attachmentId }, expect: { attempt: identity.attempt, attachmentAttemptMatchesTurn: true } });
    const current = assertLockedDraft(scope, identity, draft);
    if (current.status === "cancelled" && !current.generationJobId) return;
    if (current.status !== "awaiting_confirmation" || current.generationJobId) throw Errors.conflict("This edit was already confirmed and cannot be discarded.");
    await transitionToolEffectAttachment(tx, current, { to: "cancelled", errorCode: "edit_discarded" });
  });
  return { attachmentId, status: "cancelled" as const };
}

export async function readChatImageEditSource(userId: string, attachmentId: string) {
  const { attachment, draft } = await readDraft(userId, attachmentId);
  if (attachment.status !== "awaiting_confirmation") throw Errors.conflict("This image edit is no longer awaiting confirmation.");
  if (!await canReadDraftSource(userId, attachment.turn.session.characterId, draft)) throw Errors.gone(SOURCE_UNAVAILABLE);
  const snapshot = await prisma.generationSourceSnapshot.findFirst({ where: { id: draft.sourceSnapshotId, userId, sha256: draft.sourceSha256, contentType: "image/png", sizeBytes: draft.sizeBytes } });
  if (!snapshot) throw Errors.gone("The edit source is unavailable.");
  const chunks = await prisma.generationSourceSnapshotChunk.findMany({ where: { snapshotId: snapshot.id }, orderBy: { ordinal: "asc" }, select: { ordinal: true, bytes: true } });
  if (chunks.some((chunk, ordinal) => chunk.ordinal !== ordinal || !chunk.bytes.length || chunk.bytes.length > GENERATION_SOURCE_CHUNK_BYTES)) throw new Error("Invalid edit source chunks");
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.bytes)));
  if (bytes.length !== snapshot.sizeBytes || sha256(bytes) !== snapshot.sha256) throw new Error("Invalid edit source snapshot");
  return bytes;
}

async function boundedBody(request: Request) {
  const max = 710_000;
  if (Number(request.headers.get("content-length") ?? 0) > max) throw Errors.badRequest("Image edit confirmation is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw Errors.badRequest("Image edit body is required.");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length;
      if (length > max) { await reader.cancel(); throw Errors.badRequest("Image edit confirmation is too large."); }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) { if (error instanceof SyntaxError) throw Errors.badRequest("Invalid image edit JSON."); throw error; }
}

export async function dispatchChatImageEditReview(request: Request, segments: string[]): Promise<Response | null> {
  const [resource, collection, attachmentId, route, action] = segments;
  if (resource !== "chat" || collection !== "attachments" || !attachmentId || route !== "edit-review" || segments.length > 5) return null;
  if (!(request.method === "GET" && (!action || action === "source")) && !(request.method === "POST" && (action === "confirm" || action === "cancel"))) return null;
  const ctx = await getAuthCtx(request); const user = requireUser(ctx); requireAgeGate(ctx); requireAgeVerified(ctx);
  const viewer = request.headers.get("x-idream-viewer-scope");
  if ((request.method === "POST" || viewer !== null) && viewer !== `user:${user.id}`) throw Errors.conflict("Your account changed. Reopen this edit in the original account.");
  if (request.method === "GET") {
    if (action === "source") return new Response(await readChatImageEditSource(user.id, attachmentId), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "Vary": "Cookie, x-idream-viewer-scope" } });
    return ok({ review: await reviewChatImageEdit(user.id, attachmentId) });
  }
  const raw = await boundedBody(request);
  if (action === "cancel") return ok(await cancelChatImageEdit(user.id, attachmentId, raw));
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length < 8 || key.length > 160) throw Errors.badRequest("Idempotency-Key must be between 8 and 160 characters");
  return ok(await confirmChatImageEdit(user.id, attachmentId, key, raw), { status: 202 });
}
