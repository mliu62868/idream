// SPEC: chat.memory.extract (P1-1, design §5). Derive long-term memory OFF the hot
// path: read the exact PG turn, re-check authority, write mem/*.md. PRIVACY IRON LAW:
// canMemorize re-queries PG message status/safety — never trust diagnostic trace text;
// blocked/deleted/no-memory content must NEVER become long-term memory (PRD §7.2).
// Each memory line carries source_message_ids back-linking PG.
import type { ChatPrismaClient } from "./db.js";
import type { Prisma } from "../generated/client/client.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import {
  relationshipEvidenceForTurn,
} from "./relationship.js";
import { extractCandidates } from "./extract.js";
import { resolvePolicy, snapshotFromView } from "./policy.js";
import {
  projectChatFileMutations,
  withTurnAuthority,
} from "./file-mutations.js";
import type { ChatMemoryExtractPayload } from "@idream/shared/contracts";
import { loadSessionLinkage } from "./relationship-authority.js";
import { createId } from "./id.js";
import {
  applySceneDelta,
  deriveSceneDelta,
  emptySceneState,
  parseSceneState,
} from "./scene.js";

export type MemoryExtractPayload = ChatMemoryExtractPayload;

export interface MemoryExtractHooks {
  beforeAuthorityLock?: () => Promise<void> | void;
  afterAuthorityLocked?: () => Promise<void> | void;
  projectorPrisma?: ChatPrismaClient;
}

export async function processMemoryExtract(
  payload: MemoryExtractPayload,
  prisma: ChatPrismaClient = chatPrisma,
  hooks: MemoryExtractHooks = {},
): Promise<{ written: number; skipped: string | null }> {
  const projectorPrisma =
    hooks.projectorPrisma ?? chatProjectorPrisma;
  const session = await prisma.chatSession.findUnique({ where: { id: payload.sessionId } });
  if (!session) return { written: 0, skipped: "no_session" };
  // A prior committed mutation may have crashed before its file projection.
  // Reads and new derivations first drain that durable ledger or fail closed.
  await projectChatFileMutations(session.userId, projectorPrisma);

  // Find the user turn that preceded this assistant message.
  const assistant = await prisma.message.findUnique({ where: { id: payload.assistantMessageId } });
  if (!assistant) return { written: 0, skipped: "no_assistant" };
  if (assistant.sessionId !== session.id || assistant.role !== "assistant") {
    return { written: 0, skipped: "wrong_assistant" };
  }
  if (assistant.attempt !== payload.attempt) return { written: 0, skipped: "stale_attempt" };
  const existingScene = await prisma.chatSceneRevision.findUnique({
    where: {
      sourceAssistantMessageId_sourceAttempt: {
        sourceAssistantMessageId: assistant.id,
        sourceAttempt: payload.attempt,
      },
    },
  });
  if (
    assistant.memoryAuthority === "enabled" &&
    assistant.memoryExtractedAttempt >= payload.attempt &&
    existingScene
  ) {
    return { written: 0, skipped: "already_extracted" };
  }
  const { linkage } = await loadSessionLinkage(prisma, session.id);
  const userMessage = linkage.sources.get(assistant.id);
  if (!userMessage) return { written: 0, skipped: "no_user_turn" };
  if (
    payload.userMessageId &&
    payload.userMessageId !== userMessage.id
  ) {
    return { written: 0, skipped: "wrong_user_turn" };
  }
  if (userMessage.sessionId !== session.id || userMessage.role !== "user") {
    return { written: 0, skipped: "wrong_user_turn" };
  }
  if (assistant.replyToMessageId && userMessage.id !== assistant.replyToMessageId) {
    return { written: 0, skipped: "wrong_user_turn" };
  }

  // canMemorize: re-check PG authority — sent + not deleted + safety passed.
  if (!canMemorize(userMessage) || !canMemorize(assistant)) {
    return { written: 0, skipped: "blocked_or_deleted" };
  }

  // Semantic extraction (igrep mem derive) when enabled, regex floor otherwise —
  // off the hot path, so a slow LLM only delays this worker, never a reply.
  const candidates = assistant.memoryAuthority === "enabled"
    ? await extractCandidates({
        userText: userMessage.content,
        sourceMessageId: userMessage.id,
        userId: session.userId,
        characterId: session.characterId,
      })
    : [];
  const sceneDelta = deriveSceneDelta({
    userText: userMessage.content,
    assistantText: assistant.content,
  });
  await hooks.beforeAuthorityLock?.();

  // The same user+turn advisory lock serializes extraction with send, edit,
  // regenerate, memory preference changes, and privacy deletion. Re-read the
  // exact source rows under that lock before any file-layer side effect.
  return withTurnAuthority(
    {
      userId: session.userId,
      sessionId: session.id,
      prisma,
      projectorPrisma,
    },
    async (tx, recordIntent) => {
    const [
      currentSession,
      currentAssistant,
      currentUserMessage,
      currentSceneRevision,
      { linkage: currentLinkage },
    ] =
      await Promise.all([
        tx.chatSession.findUnique({ where: { id: session.id } }),
        tx.message.findUnique({ where: { id: assistant.id } }),
        tx.message.findUnique({ where: { id: userMessage.id } }),
        tx.chatSceneRevision.findUnique({
          where: {
            sourceAssistantMessageId_sourceAttempt: {
              sourceAssistantMessageId: assistant.id,
              sourceAttempt: payload.attempt,
            },
          },
        }),
        loadSessionLinkage(tx, session.id),
      ]);
    if (
      !currentSession ||
      currentSession.userId !== session.userId ||
      currentSession.characterId !== session.characterId ||
      currentSession.status === "deleted" ||
      currentSession.deletedAt
    ) {
      return { written: 0, skipped: "no_session" };
    }
    if (
      !currentAssistant ||
      currentAssistant.sessionId !== session.id ||
      currentAssistant.role !== "assistant"
    ) {
      return { written: 0, skipped: "wrong_assistant" };
    }
    if (currentAssistant.attempt !== payload.attempt) {
      return { written: 0, skipped: "stale_attempt" };
    }
    if (
      currentAssistant.memoryAuthority === "enabled" &&
      currentAssistant.memoryExtractedAttempt >= payload.attempt &&
      currentSceneRevision
    ) {
      return { written: 0, skipped: "already_extracted" };
    }
    if (
      !currentUserMessage ||
      currentUserMessage.sessionId !== session.id ||
      currentUserMessage.role !== "user" ||
      currentLinkage.sources.get(currentAssistant.id)?.id !==
        currentUserMessage.id ||
      (
        currentAssistant.replyToMessageId !== null &&
        currentAssistant.replyToMessageId !== currentUserMessage.id
      ) ||
      currentUserMessage.content !== userMessage.content
    ) {
      return { written: 0, skipped: "stale_source" };
    }
    if (
      !canMemorize(currentUserMessage) ||
      !canMemorize(currentAssistant)
    ) {
      return { written: 0, skipped: "blocked_or_deleted" };
    }

    await hooks.afterAuthorityLocked?.();

    if (!currentSceneRevision) {
      const anchor = currentUserMessage.sceneVersion === 0
        ? emptySceneState()
        : parseSceneState((await tx.chatSceneRevision.findFirst({
            where: {
              sessionId: currentSession.id,
              version: currentUserMessage.sceneVersion,
            },
            select: { snapshot: true },
          }))?.snapshot);
      if (!anchor) {
        return { written: 0, skipped: "invalid_scene_anchor" };
      }
      const latest = await tx.chatSceneRevision.findFirst({
        where: { sessionId: currentSession.id },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const nextScene = {
        ...applySceneDelta(anchor, sceneDelta),
        version: (latest?.version ?? 0) + 1,
      };
      await tx.chatSceneRevision.create({
        data: {
          id: createId("scene"),
          sessionId: currentSession.id,
          version: nextScene.version,
          sourceAssistantMessageId: currentAssistant.id,
          sourceAttempt: payload.attempt,
          snapshot: nextScene as unknown as Prisma.InputJsonValue,
        },
      });
    }

    if (currentAssistant.memoryAuthority !== "enabled") {
      // Scene continuity is ordinary conversation state, not long-term memory.
      // Incognito turns advance Scene but write no files, relationship evidence,
      // summary, or candidate memories.
      return {
        written: 0,
        skipped: currentAssistant.memoryAuthority === "disabled"
          ? "scene_only_memory_disabled"
          : "scene_only_legacy_unknown",
      };
    }

    const entitlement = await tx.chatEntitlementView.findUnique({
      where: { userId: currentSession.userId },
    });
    const policy = resolvePolicy(snapshotFromView(entitlement), {
      memoryEnabled: true,
    });
    const relationshipEvidence = relationshipEvidenceForTurn({
      userMessageId: currentUserMessage.id,
      assistantMessageId: currentAssistant.id,
      userText: currentUserMessage.content,
      assistantText: currentAssistant.content,
    });
    // Commit only the immutable intent here. The projector advances the DB
    // watermark in the same completion transaction that marks this intent
    // applied, so `memoryExtractedAttempt` never claims a file write that has
    // not actually succeeded.
    await recordIntent({
      kind: "memory_extract",
      sessionId: currentSession.id,
      userMessageId: currentUserMessage.id,
      characterId: currentSession.characterId,
      turnKey: currentAssistant.id,
      attempt: payload.attempt,
      summaryDelta: "",
      relationshipEvidence,
      candidates,
      maxStored: policy.maxStoredMemories,
    });

    return { written: candidates.length, skipped: null };
    },
  );
}

interface MemorableMessage {
  status: string;
  safetyStatus: string;
  deletedAt: Date | null;
}

/** PRIVACY: only sent, non-deleted, safety-passed messages may seed memory. */
export function canMemorize(message: MemorableMessage): boolean {
  return (
    message.status === "sent" &&
    message.deletedAt === null &&
    (message.safetyStatus === "passed" || message.safetyStatus === "unknown")
  );
}
