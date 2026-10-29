import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { searchCharacterMediaArgsSchema, sendCharacterMediaArgsSchema, type SearchCharacterMediaResult, type SendCharacterMediaResult } from "@idream/shared/chat/media-library";
import { chatExecutionSnapshotSchema, type ChatExecutionSnapshot, type ChatToolEffect } from "@idream/shared/contracts";
import type { CharacterMediaLibraryEntry, ChatTurn, ChatTurnAttachment, Prisma, RecentChat } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { resolveMediaAssetBlobLocator, SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { lockCharacterGenerationAuthority, lockMediaAssetAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { assertLibraryEntryAvailable, searchCharacterMediaLibrary } from "@/server/modules/character-media-library/service";
import { mediaViewUrl } from "@/server/modules/ourdream/public-read-model";
import { deliveredChatMedia } from "./chat-media-history";
import { createToolEffectAttachment, transitionToolEffectAttachment } from "./tool-effect-attachment";
import { assertChatSessionServingAuthority } from "./turn-ledger";
import { attachmentAttempt, lockChatScope } from "./turn-scope";

const candidateSchema = z.object({
  entryId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/), revision: z.number().int().positive(),
  requestedNudity: z.enum(["unspecified", "none", "full"]), unseenOnly: z.boolean(),
  signature: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
}).strict();
type Candidate = z.infer<typeof candidateSchema>;
type CandidatePolicy = Pick<Candidate, "requestedNudity" | "unseenOnly">;
type Turn = ChatTurn & { session: RecentChat };

function frozen(turn: ChatTurn, session: RecentChat, effect: ChatToolEffect) {
  const parsed = chatExecutionSnapshotSchema.safeParse(turn.executionSnapshot);
  if (!parsed.success || parsed.data.turnId !== turn.id || parsed.data.attempt !== effect.attempt
    || turn.attempt !== effect.attempt || parsed.data.userContent !== turn.userContent
    || parsed.data.userId !== session.userId || parsed.data.sessionId !== session.sessionId
    || parsed.data.characterId !== session.characterId) {
    throw Errors.forbidden("Media tools require the current frozen Chat attempt");
  }
  return parsed.data;
}

export async function searchChatCharacterMedia(effect: ChatToolEffect, turn: Turn): Promise<SearchCharacterMediaResult> {
  const args = searchCharacterMediaArgsSchema.parse(effect.arguments);
  const snapshot = frozen(turn, turn.session, effect);
  if (turn.session.status !== "active" || !["pending", "generating"].includes(turn.assistantStatus)) {
    throw Errors.conflict("Media lookup does not belong to an active Chat attempt");
  }
  await assertChatSessionServingAuthority(prisma, turn.session.userId, turn.session);
  if (args.requestedNudity !== undefined && args.requestedNudity !== effect.intent.requestedNudity) {
    throw Errors.badRequest("Media lookup and wardrobe intent differ");
  }
  if (!snapshot.characterVisualProfileId || !snapshot.characterVisualProfileVersion) {
    return { accepted: true, status: "no_match", matches: [] };
  }
  const matches = await searchCharacterMediaLibrary({
    ...args, requestedNudity: effect.intent.requestedNudity,
    userId: snapshot.userId, characterId: snapshot.characterId,
    visualProfileId: snapshot.characterVisualProfileId, visualProfileVersion: snapshot.characterVisualProfileVersion,
  });
  return {
    accepted: true, status: matches.length ? "matches" : "no_match",
    matches: matches.slice(0, 10).map(({ entry, score, alreadySent }) => ({
      candidateToken: signCandidate(snapshot, entry, {
        requestedNudity: effect.intent.requestedNudity, unseenOnly: args.unseenOnly !== false,
      }),
      kind: entry.kind as "image" | "video", description: entry.description, facts: entry.facts,
      absentFacts: entry.absentFacts, durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio, score, alreadySent,
    })),
  };
}

/** A free delivery and its owned MediaAsset commit together, without a Generation Request. */
export async function deliverChatCharacterMedia(input: {
  effect: ChatToolEffect; judged: Turn; attachmentId: string; requestDigest: string;
}): Promise<SendCharacterMediaResult> {
  const { effect, judged, attachmentId, requestDigest } = input;
  const args = sendCharacterMediaArgsSchema.parse(effect.arguments);
  const candidate = "candidateToken" in args ? readCandidate(args.candidateToken) : null;
  return prisma.$transaction(async tx => {
    const scope = await lockChatScope(tx, { userId: judged.session.userId, at: { turn: effect.turnId },
      expect: { attempt: effect.attempt, assistantStatus: ["pending", "generating"] } });
    const turn = scope.turn!;
    const snapshot = frozen(turn, scope.session, effect);
    if (scope.session.status !== "active") throw Errors.gone("Chat session is archived");
    const raced = await tx.chatTurnAttachment.findUnique({ where: { id: attachmentId } });
    if (raced) {
      const receipt = record(record(raced.metadata).effect);
      if (receipt.name !== effect.name || receipt.effectScope !== "turn_action"
        || attachmentAttempt(raced.metadata) !== effect.attempt) throw Errors.conflict("This Turn already has a different media action");
      return characterMediaReceipt(raced, true);
    }
    await lockCharacterGenerationAuthority(tx, snapshot.characterId);
    await assertChatSessionServingAuthority(tx, snapshot.userId, scope.session);

    let asset: Awaited<ReturnType<typeof tx.mediaAsset.findUniqueOrThrow>>;
    let source: "library" | "previous_media";
    let description: string | null;
    if (candidate) {
      if (!snapshot.characterVisualProfileId || !snapshot.characterVisualProfileVersion) {
        throw Errors.forbidden("Prepared media requires a frozen Character visual identity");
      }
      const beforeLock = await tx.characterMediaLibraryEntry.findUnique({ where: { id: candidate.entryId } });
      if (!beforeLock) throw Errors.notFound("Prepared media is no longer available");
      assertCandidate(candidate, snapshot, beforeLock);
      if (beforeLock.sourceAssetId) await lockMediaAssetAuthority(tx, beforeLock.sourceAssetId);
      await tx.$queryRaw`SELECT id FROM "character_media_library_entries" WHERE id = ${candidate.entryId} FOR UPDATE`;
      const entry = await tx.characterMediaLibraryEntry.findUniqueOrThrow({ where: { id: candidate.entryId } });
      if (entry.sourceAssetId !== beforeLock.sourceAssetId) {
        throw Errors.conflict("Prepared media changed after the lookup; search again");
      }
      assertCandidate(candidate, snapshot, entry);
      await assertLibraryEntryAvailable(tx, entry, { characterId: snapshot.characterId,
        visualProfileId: snapshot.characterVisualProfileId, visualProfileVersion: snapshot.characterVisualProfileVersion });
      // The send tool has no wardrobe argument. Its shared effect.intent default
      // is not a new interpretation of the signed search requirement.
      if (candidate.requestedNudity !== "unspecified" && entry.nudity !== candidate.requestedNudity) {
        throw Errors.conflict("Prepared media no longer matches the original wardrobe requirement");
      }
      if (candidate.unseenOnly && await wasLibraryMediaDelivered(tx, snapshot.userId, entry)) {
        throw Errors.conflict("This prepared media has already been delivered; search for another result");
      }
      await assertBlobReadable(entry.storageKey, entry.contentHash, entry.kind);
      const sourceAssetId = entry.sourceAssetId ?? record(entry.sourceSnapshot).assetId;
      if (typeof sourceAssetId !== "string" || !sourceAssetId) throw Errors.conflict("Prepared media has no immutable source identity");
      const id = `chatmedia_${hash(attachmentId).slice(0, 40)}`;
      const url = mediaViewUrl({ id, type: entry.kind, contentType: entry.contentType, storageKey: null, url: "" });
      asset = await tx.mediaAsset.create({ data: {
        id, ownerId: snapshot.userId, characterId: snapshot.characterId, type: entry.kind,
        url, thumbnailUrl: entry.kind === "image" ? url : null, storageKey: null, contentType: entry.contentType,
        width: entry.width, height: entry.height, sourceJobId: null, prompt: null,
        visibility: "private", safetyStatus: "passed", metadata: json({
          source: "character_media_library", synthetic: false, sha256: entry.contentHash,
          blobLocator: { schemaVersion: SHARED_IMMUTABLE_BLOB_LOCATOR_SCHEMA, kind: "shared_immutable", key: entry.storageKey, sourceAssetId },
          duplicateLineage: { schemaVersion: 1, sourceAssetId, sourceCharacterId: snapshot.characterId },
          libraryDelivery: { schemaVersion: 1, entryId: entry.id, revision: entry.revision, contentHash: entry.contentHash,
            description: entry.description, facts: entry.facts, absentFacts: entry.absentFacts,
            visualProfileId: entry.visualProfileId, visualProfileVersion: entry.visualProfileVersion,
            durationSeconds: entry.durationSeconds, hasAudio: entry.hasAudio },
        }),
      } });
      source = "library";
      description = entry.description;
    } else {
      const previousMediaAssetId = "previousMediaAssetId" in args ? args.previousMediaAssetId : "";
      if (!snapshot.recentMedia?.some(item => item.mediaAssetId === previousMediaAssetId)) {
        throw Errors.forbidden("The previous media is not a delivered result in this Chat context");
      }
      await lockMediaAssetAuthority(tx, previousMediaAssetId);
      const previous = (await deliveredChatMedia(tx, { userId: snapshot.userId, characterId: snapshot.characterId,
        sessionId: snapshot.sessionId, before: turn.createdAt, mediaAssetId: previousMediaAssetId }))[0];
      if (!previous) throw Errors.notFound("The previous media is no longer available in this Chat");
      const locator = resolveMediaAssetBlobLocator(previous.asset);
      if (!locator) throw Errors.notFound("The previous media has no readable immutable bytes");
      const digest = record(previous.asset.metadata).sha256;
      await assertBlobReadable(locator.key, typeof digest === "string" ? digest : undefined, previous.asset.type);
      asset = previous.asset;
      source = "previous_media";
      description = previous.description;
    }
    const created = await createToolEffectAttachment(tx, { id: attachmentId, turn, attempt: effect.attempt,
      kind: asset.type === "image" ? "generated_image" : "generated_video", promptHint: null,
      metadata: { source, description, costDreamcoins: 0,
        effect: { turnId: effect.turnId, attempt: effect.attempt, callId: effect.callId, name: effect.name,
          effectScope: effect.effectScope, intent: effect.intent, requestDigest },
        request: { name: effect.name, subject: "companion",
          ...(candidate ? { requestedNudity: candidate.requestedNudity } : {}) },
      },
    });
    const completed = await transitionToolEffectAttachment(tx, created, { to: "completed", generationJobId: null,
      mediaAssetId: asset.id, width: asset.width, height: asset.height });
    return characterMediaReceipt(completed, false);
  }, { timeout: 20_000 });
}

export function characterMediaReceipt(attachment: Pick<ChatTurnAttachment, "id" | "status" | "mediaAssetId" | "generationJobId" | "metadata">, duplicate: boolean): SendCharacterMediaResult {
  const metadata = record(attachment.metadata);
  if (attachment.status !== "completed" || !attachment.mediaAssetId || attachment.generationJobId !== null
    || metadata.costDreamcoins !== 0 || !["library", "previous_media"].includes(String(metadata.source))) {
    throw Errors.conflict("The existing media action has no completed delivery receipt");
  }
  return { accepted: true, duplicate, status: "completed", attachmentId: attachment.id,
    mediaAssetId: attachment.mediaAssetId, generationJobId: null, costDreamcoins: 0,
    source: metadata.source as "library" | "previous_media",
    description: typeof metadata.description === "string" ? metadata.description : null };
}

async function wasLibraryMediaDelivered(tx: Prisma.TransactionClient, userId: string, entry: CharacterMediaLibraryEntry) {
  const assets = await tx.mediaAsset.findMany({ where: { ownerId: userId, OR: [
    { metadata: { path: ["libraryDelivery", "entryId"], equals: entry.id } },
    { metadata: { path: ["libraryDelivery", "contentHash"], equals: entry.contentHash } },
  ] }, select: { id: true } });
  if (!assets.length) return false;
  const attachments = await tx.chatTurnAttachment.findMany({ where: { mediaAssetId: { in: assets.map(asset => asset.id) },
    status: "completed", turn: { session: { userId } } }, select: { metadata: true, turn: { select: { attempt: true } } } });
  return attachments.some(item => attachmentAttempt(item.metadata) === item.turn.attempt);
}

async function assertBlobReadable(key: string, digest: string | undefined, kind: string) {
  if (!providers.blob.getPrivate) throw Errors.unavailable("Prepared media storage cannot verify delivery");
  const result = await providers.blob.getPrivate({ key, signal: AbortSignal.timeout(10_000),
    maxBytes: (kind === "video" ? 256 : 64) * 1024 * 1024 });
  if (!result.ok || result.data.body.byteLength === 0 || (digest && hash(result.data.body) !== digest)) {
    throw Errors.gone("The media bytes are no longer available or have changed");
  }
}

function signCandidate(snapshot: ChatExecutionSnapshot, entry: CharacterMediaLibraryEntry, policy: CandidatePolicy) {
  const nudity = policy.requestedNudity === "none" ? "n" : policy.requestedNudity === "full" ? "f" : "u";
  // The model copies only the locator and MAC. Scope and immutable content stay
  // signed, reconstructed from Main's frozen Turn and locked library row.
  return ["2", entry.id, entry.revision, policy.unseenOnly ? "1" : "0", nudity,
    candidateSignature(snapshot, entry, policy).toString("base64url")].join(".");
}

function readCandidate(token: string): Candidate {
  const invalid = () => Errors.badRequest("Media candidate is invalid; search again");
  if (token.length > 256) throw invalid();
  const parts = token.split(".");
  const [version, entryId, revision, unseen, nudity, signature] = parts;
  if (parts.length !== 6 || version !== "2" || !["0", "1"].includes(unseen ?? "")) throw invalid();
  const parsed = candidateSchema.safeParse({ entryId, revision: Number(revision), unseenOnly: unseen === "1", signature,
    requestedNudity: nudity === "n" ? "none" : nudity === "f" ? "full" : nudity === "u" ? "unspecified" : undefined });
  if (!parsed.success || String(parsed.data.revision) !== revision) throw invalid();
  return parsed.data;
}

function candidateSignature(snapshot: ChatExecutionSnapshot, entry: CharacterMediaLibraryEntry, policy: CandidatePolicy) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(JSON.stringify({
    domain: "chat-media-candidate-v2",
    userId: snapshot.userId, sessionId: snapshot.sessionId, turnId: snapshot.turnId, attempt: snapshot.attempt,
    userContentHash: hash(snapshot.userContent), characterId: snapshot.characterId,
    contentVersionId: snapshot.characterContentVersionId, releaseId: snapshot.characterReleaseId,
    visualProfileId: snapshot.characterVisualProfileId, visualProfileVersion: snapshot.characterVisualProfileVersion,
    entryId: entry.id, revision: entry.revision, contentHash: entry.contentHash,
    entryCharacterId: entry.characterId, entryVisualProfileId: entry.visualProfileId,
    entryVisualProfileVersion: entry.visualProfileVersion,
    unseenOnly: policy.unseenOnly, requestedNudity: policy.requestedNudity,
  })).digest();
}

function assertCandidate(candidate: Candidate, snapshot: ChatExecutionSnapshot, entry: CharacterMediaLibraryEntry) {
  if (entry.id !== candidate.entryId || entry.revision !== candidate.revision) {
    throw Errors.conflict("Prepared media changed after the lookup; search again");
  }
  const expected = candidateSignature(snapshot, entry, candidate);
  const supplied = Buffer.from(candidate.signature, "base64url");
  if (supplied.toString("base64url") !== candidate.signature || expected.length !== supplied.length
    || !timingSafeEqual(expected, supplied)) {
    throw Errors.forbidden("This media candidate does not belong to the current Chat attempt or content");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
