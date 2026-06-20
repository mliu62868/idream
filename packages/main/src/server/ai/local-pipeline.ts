import type { Prisma } from "@prisma/client";
import { jobQueue } from "@/server/jobs/queue";
import type { QueueJob } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { generateChatCompletion } from "./chat-runtime";
import {
  aiFinalizePayloadSchema,
  chatGeneratePayloadSchema,
  imageGeneratePayloadSchema,
  memoryForgetPayloadSchema,
  memoryRebuildPayloadSchema,
  memorySyncPayloadSchema,
  type AiFinalizePayload,
  type ImageGeneratePayload,
  type MemoryRebuildPayload,
  type MemorySyncPayload,
  type VideoGeneratePayload,
  videoGeneratePayloadSchema,
} from "./schemas";
import { appendChatStreamEvent } from "./stream-store";

export const localAiQueueNames = [
  "ai.chat.generate",
  "ai.memory.sync",
  "ai.memory.forget",
  "ai.memory.rebuild",
  "ai.image.generate",
  "ai.video.generate",
  "app.ai.finalize",
] as const;

export interface LocalAiDrainResult {
  workerId: string;
  claimed: Array<{
    id: string;
    queue: string;
    status: string;
  }>;
  processed: number;
}

type ChatCompletedPayload = Extract<AiFinalizePayload, { kind: "chat.completed" }>;
type SyncedMemory = Extract<MemorySyncPayload["changes"][number], { operation: "upsert" }>["memory"];
type MemoryCandidate = NonNullable<ChatCompletedPayload["memoryPatch"]>["candidates"][number];

export async function drainLocalAiPipeline(input: {
  limit?: number;
  workerId?: string;
  queues?: string[];
} = {}): Promise<LocalAiDrainResult> {
  const workerId = input.workerId ?? `local-ai-${cryptoRandomId()}`;
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const queues = input.queues ?? [...localAiQueueNames];
  const claimedSummary: LocalAiDrainResult["claimed"] = [];
  let processed = 0;

  for (let index = 0; index < limit; index += 1) {
    let claimed = false;

    for (const queue of queues) {
      const result = await jobQueue.processNext({
        queue,
        workerId,
        processor: processLocalAiJob,
      });
      if (!result.job) continue;

      claimed = true;
      claimedSummary.push({ id: result.job.id, queue: result.job.queue, status: result.status });
      if (result.status === "completed") processed += 1;
      break;
    }

    if (!claimed) break;
  }

  return { workerId, claimed: claimedSummary, processed };
}

async function processLocalAiJob(job: QueueJob) {
  if (job.queue === "ai.chat.generate") {
    return processChatGenerate(job.payload, job.attemptsMade + 1, job.maxAttempts);
  }
  if (job.queue === "ai.memory.sync") {
    return processMemorySync(job.payload);
  }
  if (job.queue === "ai.memory.forget") {
    return processMemoryForget(job.payload);
  }
  if (job.queue === "ai.memory.rebuild") {
    return processMemoryRebuild(job.payload);
  }
  if (job.queue === "ai.image.generate") {
    return processImageGenerate(job.payload);
  }
  if (job.queue === "ai.video.generate") {
    return processVideoGenerate(job.payload);
  }
  if (job.queue === "app.ai.finalize") {
    return processFinalize(job.payload);
  }

  throw new Error(`Unsupported local AI queue: ${job.queue}`);
}

async function processChatGenerate(
  payloadValue: Prisma.JsonValue,
  attempt: number,
  maxAttempts: number,
) {
  const payload = chatGeneratePayloadSchema.parse(payloadValue);
  const assistant = await prisma.message.findUnique({
    where: { id: payload.assistantMessageId },
  });

  if (!assistant || assistant.status === "sent" || assistant.status === "deleted") return;

  await prisma.message.updateMany({
    where: { id: payload.assistantMessageId, status: { in: ["pending", "generating"] } },
    data: { status: "generating" },
  });

  await appendChatStreamEvent(payload.streamKey, { type: "start", attempt });

  let wroteDelta = false;
  let result: Awaited<ReturnType<typeof generateChatCompletion>>;
  try {
    result = await generateChatCompletion(payload, attempt, {
      onDelta: async (event) => {
        wroteDelta = true;
        await appendChatStreamEvent(payload.streamKey, event);
      },
    });
  } catch (error) {
    if (!wroteDelta && attempt < maxAttempts) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await appendChatStreamEvent(payload.streamKey, {
      type: "error",
      attempt,
      code: wroteDelta ? "provider_interrupted" : "provider_failed",
      retryable: !wroteDelta,
    });
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: toInputJson({
        version: 1,
        kind: "chat.failed",
        requestId: payload.requestId,
        sessionId: payload.sessionId,
        userMessageId: payload.userMessageId,
        assistantMessageId: payload.assistantMessageId,
        error: {
          code: wroteDelta ? "provider_interrupted" : "provider_failed",
          message,
          retryable: !wroteDelta,
          partialOutput: wroteDelta,
        },
      } satisfies AiFinalizePayload),
      dedupeKey: `chat-finalize:${payload.assistantMessageId}:failed`,
    });
    return;
  }

  await appendChatStreamEvent(payload.streamKey, { type: "done", attempt, usage: result.usage });

  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "chat.completed",
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      userMessageId: payload.userMessageId,
      assistantMessageId: payload.assistantMessageId,
      content: result.content,
      model: result.model,
      usage: result.usage,
      memoryPatch: result.memoryPatch,
      relationshipPatch: result.relationshipPatch,
      trace: result.trace,
    } satisfies AiFinalizePayload),
    dedupeKey: `chat-finalize:${payload.assistantMessageId}`,
  });
}

async function processMemoryForget(payloadValue: Prisma.JsonValue) {
  const payload = memoryForgetPayloadSchema.parse(payloadValue);
  const ids = new Set([
    ...payload.memoryIds,
    ...(payload.scope === "memory" ? payload.targetIds : []),
  ]);
  const messageIds = new Set(payload.scope === "message" ? payload.targetIds : []);
  if (payload.sourceMessageId) messageIds.add(payload.sourceMessageId);

  if (payload.sessionId) {
    const sessionMemories = await prisma.companionMemory.findMany({
      where: {
        userId: payload.userId,
        sessionId: payload.sessionId,
        status: "active",
        deletedAt: null,
      },
      select: { id: true },
    });
    for (const memory of sessionMemories) ids.add(memory.id);
  }

  if (messageIds.size > 0) {
    const memories = await prisma.companionMemory.findMany({
      where: { userId: payload.userId, status: "active", deletedAt: null },
      select: { id: true, sourceMessageIds: true },
    });
    for (const memory of memories) {
      if (jsonStringArray(memory.sourceMessageIds).some((id) => messageIds.has(id))) {
        ids.add(memory.id);
      }
    }
  }

  if (payload.scope === "character") {
    await prisma.companionMemory.findMany({
      where: {
        userId: payload.userId,
        characterId: { in: payload.targetIds },
        status: "active",
        deletedAt: null,
      },
      select: { id: true },
    }).then((memories) => memories.forEach((memory) => ids.add(memory.id)));
  }

  if (payload.scope === "account") {
    await prisma.companionMemory.findMany({
      where: { userId: payload.userId, status: "active", deletedAt: null },
      select: { id: true },
    }).then((memories) => memories.forEach((memory) => ids.add(memory.id)));
  }

  if (ids.size > 0) {
    await prisma.companionMemory.updateMany({
      where: { id: { in: [...ids] }, userId: payload.userId },
      data: {
        status: "deleted",
        deletedAt: new Date(),
      },
    });
  }

  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "memory.forgotten",
      requestId: payload.requestId,
      userId: payload.userId,
      scope: payload.scope,
      targetIds: payload.targetIds,
      deletedMemoryIds: [...ids],
      reason: payload.reason,
    } satisfies AiFinalizePayload),
    dedupeKey: `memory-forgotten:${payload.requestId}`,
  });
}

async function processMemorySync(payloadValue: Prisma.JsonValue) {
  const payload = memorySyncPayloadSchema.parse(payloadValue);
  await prisma.$transaction(async (tx) => {
    for (const change of payload.changes) {
      if (change.operation === "delete") {
        await tx.companionMemory.updateMany({
          where: { id: change.memoryId, userId: payload.userId },
          data: { status: "deleted", deletedAt: new Date() },
        });
        continue;
      }

      await upsertSyncedMemory(tx, payload, change.memory);
    }
  });
}

async function processMemoryRebuild(payloadValue: Prisma.JsonValue) {
  const payload = memoryRebuildPayloadSchema.parse(payloadValue);
  const snapshotIds = new Set(payload.source.memories.map((memory) => memory.id));

  await prisma.$transaction(async (tx) => {
    await tx.companionMemory.updateMany({
      where: {
        userId: payload.userId,
        characterId: payload.characterId ?? undefined,
        status: "active",
        deletedAt: null,
        id: snapshotIds.size > 0 ? { notIn: [...snapshotIds] } : undefined,
      },
      data: { status: "deleted", deletedAt: new Date() },
    });

    for (const memory of payload.source.memories) {
      await upsertSyncedMemory(tx, payload, memory);
    }
  });
}

async function upsertSyncedMemory(
  tx: Prisma.TransactionClient,
  payload: MemorySyncPayload | MemoryRebuildPayload,
  memory: SyncedMemory,
) {
  const deleted = memory.status === "deleted";
  await tx.companionMemory.upsert({
    where: { id: memory.id },
    update: {
      userId: payload.userId,
      characterId: memory.scope === "global" ? null : (memory.characterId ?? payload.characterId ?? null),
      sessionId: memory.scope === "session" ? (memory.sessionId ?? null) : null,
      scope: memory.scope,
      type: memory.type,
      text: memory.text,
      confidence: memory.confidence,
      status: memory.status,
      sourceMessageIds: toInputJson(memory.sourceMessageIds),
      deletedAt: deleted ? new Date() : null,
    },
    create: {
      id: memory.id,
      userId: payload.userId,
      characterId: memory.scope === "global" ? null : (memory.characterId ?? payload.characterId ?? null),
      sessionId: memory.scope === "session" ? (memory.sessionId ?? null) : null,
      scope: memory.scope,
      type: memory.type,
      text: memory.text,
      confidence: memory.confidence,
      status: memory.status,
      sourceMessageIds: toInputJson(memory.sourceMessageIds),
      deletedAt: deleted ? new Date() : null,
    },
  });
}

async function processImageGenerate(payloadValue: Prisma.JsonValue) {
  const payload = imageGeneratePayloadSchema.parse(payloadValue);
  await markGenerationRunning(payload.generationJobId);

  const result = await providers.image.generate({
    prompt: payload.prompt,
    count: payload.count,
    seed: payload.seed,
  });

  if (!result.ok) {
    if (result.error.retryable) throw new Error(result.error.message);
    await enqueueGenerationFailed(payload, result.error.code, result.error.message);
    return;
  }

  const assets = await Promise.all(
    result.data.assets.map(async (asset, index) => {
      const key = asset.key || `${payload.outputPrefix}${index}.webp`;
      await providers.blob.putPrivate({
        key,
        body: new TextEncoder().encode(`mock image ${payload.generationJobId} ${index}`),
        contentType: "image/webp",
      });
      return {
        key,
        width: asset.width,
        height: asset.height,
        contentType: "image/webp",
      };
    }),
  );

  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "generation.completed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "image",
      assets,
      usage: { gpuSeconds: assets.length * 1.2, model: payload.model },
    } satisfies AiFinalizePayload),
    dedupeKey: `generation-finalize:${payload.generationJobId}:completed`,
  });
}

async function processVideoGenerate(payloadValue: Prisma.JsonValue) {
  const payload = videoGeneratePayloadSchema.parse(payloadValue);
  await markGenerationRunning(payload.generationJobId);

  const result = await providers.video.generate({
    prompt: payload.prompt,
    seconds: payload.seconds,
    seed: payload.seed,
  });

  if (!result.ok) {
    if (result.error.retryable) throw new Error(result.error.message);
    await enqueueGenerationFailed(payload, result.error.code, result.error.message);
    return;
  }

  await providers.blob.putPrivate({
    key: result.data.asset.key,
    body: new TextEncoder().encode(`mock video ${payload.generationJobId}`),
    contentType: "video/mp4",
  });

  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "generation.completed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: "video",
      assets: [
        {
          key: result.data.asset.key,
          seconds: result.data.asset.seconds,
          contentType: "video/mp4",
        },
      ],
      usage: { gpuSeconds: payload.seconds * 2, model: payload.model },
    } satisfies AiFinalizePayload),
    dedupeKey: `generation-finalize:${payload.generationJobId}:completed`,
  });
}

async function processFinalize(payloadValue: Prisma.JsonValue) {
  const payload = aiFinalizePayloadSchema.parse(payloadValue);

  if (payload.kind === "chat.completed") return finalizeChatCompleted(payload);
  if (payload.kind === "chat.failed") return finalizeChatFailed(payload);
  if (payload.kind === "memory.forgotten") return finalizeMemoryForgotten(payload);
  if (payload.kind === "generation.completed") return finalizeGenerationCompleted(payload);
  return finalizeGenerationFailed(payload);
}

async function finalizeMemoryForgotten(
  payload: Extract<AiFinalizePayload, { kind: "memory.forgotten" }>,
) {
  await trackEvent(
    "memory_forgotten",
    {
      requestId: payload.requestId,
      scope: payload.scope,
      targetIds: payload.targetIds,
      deletedMemoryIds: payload.deletedMemoryIds,
      reason: payload.reason,
    },
    { userId: payload.userId },
  );
}

async function finalizeChatCompleted(
  payload: Extract<AiFinalizePayload, { kind: "chat.completed" }>,
) {
  const assistant = await prisma.message.findUnique({
    where: { id: payload.assistantMessageId },
    include: { session: true },
  });
  if (!assistant || assistant.status === "deleted") return;

  const outputModeration = await moderateText(
    "message",
    payload.assistantMessageId,
    payload.content,
    "output",
  );
  const finalStatus = outputModeration.status === "blocked" ? "blocked" : "sent";
  const shouldCountUsage = assistant.status !== "sent" && assistant.status !== "blocked";
  const shouldApplySideEffects = shouldCountUsage && finalStatus === "sent";
  const sessionSummary = payload.memoryPatch?.sessionSummary?.text;
  const memorySyncChanges: MemorySyncPayload["changes"] = [];

  await prisma.$transaction(async (tx) => {
    await tx.message.update({
      where: { id: payload.assistantMessageId },
      data: {
        content: payload.content,
        model: payload.model,
        status: finalStatus,
        safetyStatus: outputModeration.status,
        tokenCount: payload.usage.completionTokens,
      },
    });

    const selectedVersion = await tx.messageVersion.findFirst({
      where: { messageId: payload.assistantMessageId, selected: true },
    });
    if (selectedVersion) {
      await tx.messageVersion.update({
        where: { id: selectedVersion.id },
        data: { content: payload.content, model: payload.model },
      });
    } else {
      await tx.messageVersion.create({
        data: {
          messageId: payload.assistantMessageId,
          content: payload.content,
          model: payload.model,
          selected: true,
        },
      });
    }

    await tx.chatSession.update({
      where: { id: payload.sessionId },
      data: {
        lastMessageAt: new Date(),
        memorySummary: sessionSummary ?? assistant.session.memorySummary,
      },
    });

    if (shouldCountUsage) {
      await incrementChatUsage(tx, assistant.session.userId, payload.sessionId);
    }

    if (shouldApplySideEffects && assistant.session.memoryEnabled) {
      memorySyncChanges.push(
        ...(await applyMemoryPatch(
          tx,
          assistant.session.userId,
          assistant.session.characterId,
          payload.sessionId,
          payload.memoryPatch,
        )),
      );
    }

    if (shouldApplySideEffects) {
      await applyRelationshipPatch(
        tx,
        assistant.session.userId,
        assistant.session.characterId,
        payload.relationshipPatch,
      );
    }
  });

  if (memorySyncChanges.length > 0) {
    await jobQueue.enqueue({
      queue: "ai.memory.sync",
      payload: toInputJson({
        version: 1,
        kind: "memory.sync",
        requestId: `${payload.requestId}:memory`,
        userId: assistant.session.userId,
        characterId: assistant.session.characterId,
        changes: memorySyncChanges,
      } satisfies MemorySyncPayload),
      dedupeKey: `memory-sync:${payload.assistantMessageId}`,
    });
  }
}

async function finalizeChatFailed(payload: Extract<AiFinalizePayload, { kind: "chat.failed" }>) {
  await prisma.message.updateMany({
    where: { id: payload.assistantMessageId, status: { not: "deleted" } },
    data: {
      status: "failed",
      content: payload.error.message,
      model: "mock-chat",
      safetyStatus: "unknown",
    },
  });
}

async function applyMemoryPatch(
  tx: Prisma.TransactionClient,
  userId: string,
  characterId: string,
  sessionId: string,
  memoryPatch: ChatCompletedPayload["memoryPatch"],
): Promise<MemorySyncPayload["changes"]> {
  const changes: MemorySyncPayload["changes"] = [];
  if (!memoryPatch?.candidates?.length) return changes;

  for (const candidate of memoryPatch.candidates) {
    const text = candidate.text.trim();
    if (!text) continue;
    if (!(await allowedMemoryCandidate(tx, sessionId, candidate))) continue;
    const scopedCharacterId = candidate.scope === "global" ? null : characterId;
    const scopedSessionId = candidate.scope === "session" ? sessionId : null;

    if (candidate.operation === "delete") {
      const deleted = await tx.companionMemory.findMany({
        where: {
          userId,
          characterId: scopedCharacterId,
          sessionId: scopedSessionId,
          text,
          status: "active",
          deletedAt: null,
        },
        select: { id: true },
      });
      await tx.companionMemory.updateMany({
        where: { id: { in: deleted.map((memory) => memory.id) }, userId },
        data: { status: "deleted", deletedAt: new Date() },
      });
      for (const memory of deleted) changes.push({ operation: "delete", memoryId: memory.id });
      continue;
    }

    const existing = await tx.companionMemory.findFirst({
      where: {
        userId,
        characterId: scopedCharacterId,
        sessionId: scopedSessionId,
        scope: candidate.scope,
        type: candidate.type,
        text,
        status: "active",
        deletedAt: null,
      },
    });

    if (existing) {
      const updated = await tx.companionMemory.update({
        where: { id: existing.id },
        data: {
          confidence: Math.max(existing.confidence, candidate.confidence),
          sourceMessageIds: toInputJson(
            uniqueStrings([
              ...jsonStringArray(existing.sourceMessageIds),
              ...candidate.sourceMessageIds,
            ]),
          ),
        },
      });
      changes.push({ operation: "upsert", memory: syncedMemoryFromRecord(updated) });
    } else {
      const created = await tx.companionMemory.create({
        data: {
          userId,
          characterId: scopedCharacterId,
          sessionId: scopedSessionId,
          scope: candidate.scope,
          type: candidate.type,
          text,
          confidence: candidate.confidence,
          status: "active",
          sourceMessageIds: toInputJson(candidate.sourceMessageIds),
        },
      });
      changes.push({ operation: "upsert", memory: syncedMemoryFromRecord(created) });
    }
  }

  return changes;
}

async function allowedMemoryCandidate(
  tx: Prisma.TransactionClient,
  sessionId: string,
  candidate: MemoryCandidate,
) {
  if (candidate.scope === "global") return false;
  if (candidate.confidence < minimumMemoryConfidence(candidate.type)) return false;
  if (containsProhibitedMemoryText(candidate.text)) return false;
  if (candidate.sourceMessageIds.length === 0) return false;

  const sourceMessages = await tx.message.findMany({
    where: {
      id: { in: candidate.sourceMessageIds },
      sessionId,
      status: "sent",
      safetyStatus: { not: "blocked" },
    },
    select: { id: true },
  });
  return sourceMessages.length > 0;
}

function minimumMemoryConfidence(type: string) {
  if (type === "boundary") return 0.8;
  if (type === "shared_event") return 0.72;
  return 0.7;
}

function containsProhibitedMemoryText(text: string) {
  const normalized = text.toLowerCase();
  return [
    /\b(password|passcode|api key|secret key|private key|seed phrase)\b/,
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b(?:\d[ -]*?){13,19}\b/,
  ].some((pattern) => pattern.test(normalized));
}

function syncedMemoryFromRecord(memory: {
  id: string;
  characterId: string | null;
  sessionId: string | null;
  scope: string;
  type: string;
  text: string;
  confidence: number;
  status: string;
  sourceMessageIds: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): SyncedMemory {
  return {
    id: memory.id,
    characterId: memory.characterId,
    sessionId: memory.sessionId,
    scope: memory.scope as SyncedMemory["scope"],
    type: memory.type as SyncedMemory["type"],
    text: memory.text,
    confidence: memory.confidence,
    status: memory.status as SyncedMemory["status"],
    sourceMessageIds: jsonStringArray(memory.sourceMessageIds),
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

async function applyRelationshipPatch(
  tx: Prisma.TransactionClient,
  userId: string,
  characterId: string,
  relationshipPatch: ChatCompletedPayload["relationshipPatch"],
) {
  const patch = relationshipPatchRecord(relationshipPatch);
  if (!patch) return;

  const existing = await tx.relationshipState.findUnique({
    where: { userId_characterId: { userId, characterId } },
  });
  const signals = mergeSignals(numberRecord(existing?.signals), patch.signalsDelta);
  const boundaries = uniqueStrings([
    ...jsonStringArray(existing?.boundaries),
    ...patch.boundaries,
  ]);
  const summary = clampText(
    [existing?.summary, patch.summaryDelta].filter(Boolean).join("\n"),
    900,
  );
  const stage = patch.stage ?? stageForSignals(signals);

  if (existing) {
    await tx.relationshipState.update({
      where: { id: existing.id },
      data: {
        stage,
        summary: summary || existing.summary,
        signals: toInputJson(signals),
        boundaries: toInputJson(boundaries),
        version: { increment: 1 },
      },
    });
  } else {
    await tx.relationshipState.create({
      data: {
        userId,
        characterId,
        stage,
        summary: summary || null,
        signals: toInputJson(signals),
        boundaries: toInputJson(boundaries),
      },
    });
  }
}

async function finalizeGenerationCompleted(
  payload: Extract<AiFinalizePayload, { kind: "generation.completed" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job) return;
  if (job.status === "completed") return;

  const outputModeration = await moderateText(
    "generation_job",
    payload.generationJobId,
    payload.assets.map((asset) => asset.key).join(" "),
    "output",
  );
  if (outputModeration.status === "blocked") {
    await refundGeneration(job.userId, job.id, job.costDreamcoins, "blocked", "output_blocked");
    return;
  }

  const existingAssets = await prisma.mediaAsset.count({
    where: { sourceJobId: payload.generationJobId },
  });
  const displayUrl =
    payload.mode === "image"
      ? await imageUrlForCharacter(job.characterId ?? undefined)
      : "/images/ourdream/promo-card-female.webp";

  await prisma.$transaction(async (tx) => {
    if (existingAssets === 0) {
      for (const [index, asset] of payload.assets.entries()) {
        await tx.mediaAsset.create({
          data: {
            ownerId: job.userId,
            sourceJobId: job.id,
            characterId: job.characterId,
            type: payload.mode,
            url: displayUrl,
            thumbnailUrl: displayUrl,
            prompt: job.prompt,
            visibility: "private",
            safetyStatus: outputModeration.status,
            metadata: toInputJson({
              index,
              provider: "mock-pipeline",
              providerKey: asset.key,
              contentType: asset.contentType,
              width: asset.width,
              height: asset.height,
              seconds: asset.seconds,
              usage: payload.usage,
            }),
          },
        });
      }
    }

    await tx.generationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        errorCode: null,
      },
    });
  });

  await trackEvent("generation_completed", { jobId: job.id, mode: payload.mode }, { userId: job.userId });
}

async function finalizeGenerationFailed(
  payload: Extract<AiFinalizePayload, { kind: "generation.failed" }>,
) {
  const job = await prisma.generationJob.findUnique({
    where: { id: payload.generationJobId },
  });
  if (!job || job.status === "completed") return;
  await refundGeneration(job.userId, job.id, job.costDreamcoins, "failed", payload.error.code);
}

async function enqueueGenerationFailed(
  payload: ImageGeneratePayload | VideoGeneratePayload,
  code: string,
  message: string,
) {
  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: toInputJson({
      version: 1,
      kind: "generation.failed",
      requestId: payload.requestId,
      generationJobId: payload.generationJobId,
      mode: payload.kind,
      error: { code, message, retryable: false },
    } satisfies AiFinalizePayload),
    dedupeKey: `generation-finalize:${payload.generationJobId}:failed`,
  });
}

async function markGenerationRunning(generationJobId: string) {
  await prisma.generationJob.updateMany({
    where: { id: generationJobId, status: { in: ["queued", "running", "failed", "refunded"] } },
    data: { status: "running", errorCode: null },
  });
}

async function moderateText(
  targetType: string,
  targetId: string,
  content: string,
  layer: string,
) {
  const result = await providers.moderation.check({
    targetType: "text",
    content,
  });
  if (!result.ok) throw new Error(result.error.message);

  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer,
      status: result.data.status,
      policyCode: result.data.policyCode,
      confidence: result.data.confidence,
      details: {},
    },
  });

  return result.data;
}

async function incrementChatUsage(
  tx: Prisma.TransactionClient,
  userId: string,
  sessionId: string,
) {
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  await tx.chatUsage.upsert({
    where: { userId_periodStart: { userId, periodStart } },
    update: { messagesUsed: { increment: 1 }, sessionId },
    create: { userId, sessionId, periodStart, periodEnd, messagesUsed: 1 },
  });
}

async function refundGeneration(
  userId: string,
  jobId: string,
  cost: number,
  status: "failed" | "blocked",
  errorCode: string,
) {
  await prisma.$transaction(async (tx) => {
    const existingRefund = await tx.dreamcoinLedger.findFirst({
      where: { userId, sourceId: jobId, reason: "refund" },
    });
    if (!existingRefund && cost > 0) {
      await appendLedger(tx, userId, cost, "refund", jobId);
    }
    await tx.generationJob.update({
      where: { id: jobId },
      data: { status, errorCode, completedAt: new Date() },
    });
  });
}

async function appendLedger(
  tx: Prisma.TransactionClient,
  userId: string,
  delta: number,
  reason: string,
  sourceId?: string,
) {
  const aggregate = await tx.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  const balance = aggregate._sum.delta ?? 0;
  return tx.dreamcoinLedger.create({
    data: {
      userId,
      delta,
      balanceAfter: balance + delta,
      reason,
      sourceId,
    },
  });
}

async function imageUrlForCharacter(characterId?: string) {
  if (!characterId) return "/images/ourdream/promo-card-female.webp";
  const character = await prisma.character.findUnique({
    where: { id: characterId },
    include: { imageAsset: true },
  });
  return character?.imageAsset?.url ?? "/images/ourdream/card-sarah-mercer.webp";
}

async function trackEvent(
  name: string,
  props: unknown,
  ctx: { userId?: string; anonymousId?: string },
) {
  return prisma.analyticsEvent.create({
    data: {
      userId: ctx.userId,
      anonymousId: ctx.anonymousId,
      name,
      props: toInputJson(props),
    },
  });
}

function clampText(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function relationshipPatchRecord(value: unknown) {
  if (!isRecord(value)) return null;
  const summaryDelta = typeof value.summaryDelta === "string" ? value.summaryDelta : "";
  const signalsDelta = numberRecord(value.signalsDelta);
  const boundaries = jsonStringArray(value.boundaries);
  const stage = relationshipStage(value.stage);
  if (!summaryDelta && Object.keys(signalsDelta).length === 0 && boundaries.length === 0 && !stage) {
    return null;
  }
  return { summaryDelta, signalsDelta, boundaries, stage };
}

function mergeSignals(
  current: Record<string, number>,
  delta: Record<string, number>,
) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    merged[key] = Math.max(0, (merged[key] ?? 0) + value);
  }
  return merged;
}

function stageForSignals(signals: Record<string, number>) {
  const turns = signals.turns ?? 0;
  const warmth = signals.warmth ?? 0;
  const trust = signals.trust ?? 0;
  const familiarity = signals.familiarity ?? 0;
  const score = Math.max(turns, warmth, trust, familiarity);
  if (score >= 20) return "committed";
  if (score >= 8) return "close";
  if (score >= 2) return "familiar";
  return "new";
}

function relationshipStage(value: unknown) {
  return value === "new" || value === "familiar" || value === "close" || value === "committed"
    ? value
    : undefined;
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
  }
  return result;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cryptoRandomId() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
