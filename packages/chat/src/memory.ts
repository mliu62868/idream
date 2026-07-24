// SPEC: chat.memory.extract (P1-1, design §5). Derive long-term memory OFF the hot
// path: read the exact PG turn, re-check authority, write mem/*.md. PRIVACY IRON LAW:
// canMemorize re-queries PG message status/safety — never trust diagnostic trace text;
// blocked/deleted/no-memory content must NEVER become long-term memory (PRD §7.2).
// Each memory line carries source_message_ids back-linking PG.
import type { ChatPrismaClient } from "./db.js";
import { chatPrisma, chatProjectorPrisma } from "./db.js";
import {
  relationshipSignalForTurn,
  relationshipTurnSummary,
} from "./relationship.js";
import { extractCandidates } from "./extract.js";
import { resolvePolicy, snapshotFromView } from "./policy.js";
import {
  assertNoPendingChatFileMutationsTx,
  projectChatFileMutations,
  recordChatFileMutation,
  runWithProjectedChatFiles,
} from "./file-mutations.js";
import { lockTurn } from "./turn-lock.js";
import type { ChatMemoryExtractPayload } from "@idream/shared/contracts";
import {
  relationshipMessageSelect,
  resolveRelationshipLinkage,
} from "./relationship-authority.js";

// Re-export the extractor surface so existing importers keep their path.
export { deriveCandidates } from "./extract.js";
export type { MemoryCandidate } from "./extract.js";

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
  if (assistant.memoryExtractedAttempt >= payload.attempt) return { written: 0, skipped: "already_extracted" };
  if (assistant.memoryAuthority === "disabled") {
    return { written: 0, skipped: "turn_memory_disabled" };
  }
  if (assistant.memoryAuthority !== "enabled") {
    return { written: 0, skipped: "turn_memory_legacy_unknown" };
  }
  const [messages, receipts] = await Promise.all([
    prisma.message.findMany({
      where: { sessionId: session.id },
      select: relationshipMessageSelect,
    }),
    prisma.chatSendReceipt.findMany({
      where: { sessionId: session.id },
      select: {
        userMessageId: true,
        assistantMessageId: true,
      },
    }),
  ]);
  const linkage = resolveRelationshipLinkage(messages, receipts);
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
  const candidates = await extractCandidates({
    userText: userMessage.content,
    sourceMessageId: userMessage.id,
    userId: session.userId,
    characterId: session.characterId,
  });
  await hooks.beforeAuthorityLock?.();

  // The same user+turn advisory lock serializes extraction with send, edit,
  // regenerate, memory preference changes, and privacy deletion. Re-read the
  // exact source rows under that lock before any file-layer side effect.
  const committed = await runWithProjectedChatFiles(
    session.userId,
    () => prisma.$transaction(async (tx) => {
    await lockTurn(tx, session.userId, session.id);
    await assertNoPendingChatFileMutationsTx(tx, session.userId);
    const [
      currentSession,
      currentAssistant,
      currentUserMessage,
      currentMessages,
      currentReceipts,
    ] =
      await Promise.all([
        tx.chatSession.findUnique({ where: { id: session.id } }),
        tx.message.findUnique({ where: { id: assistant.id } }),
        tx.message.findUnique({ where: { id: userMessage.id } }),
        tx.message.findMany({
          where: { sessionId: session.id },
          select: relationshipMessageSelect,
        }),
        tx.chatSendReceipt.findMany({
          where: { sessionId: session.id },
          select: {
            userMessageId: true,
            assistantMessageId: true,
          },
        }),
      ]);
    const currentLinkage = resolveRelationshipLinkage(
      currentMessages,
      currentReceipts,
    );
    if (
      !currentSession ||
      currentSession.userId !== session.userId ||
      currentSession.characterId !== session.characterId ||
      currentSession.status === "deleted" ||
      currentSession.deletedAt
    ) {
      return {
        result: { written: 0, skipped: "no_session" },
        mutationId: null,
      };
    }
    if (
      !currentAssistant ||
      currentAssistant.sessionId !== session.id ||
      currentAssistant.role !== "assistant"
    ) {
      return {
        result: { written: 0, skipped: "wrong_assistant" },
        mutationId: null,
      };
    }
    if (currentAssistant.attempt !== payload.attempt) {
      return {
        result: { written: 0, skipped: "stale_attempt" },
        mutationId: null,
      };
    }
    if (currentAssistant.memoryExtractedAttempt >= payload.attempt) {
      return {
        result: { written: 0, skipped: "already_extracted" },
        mutationId: null,
      };
    }
    if (currentAssistant.memoryAuthority === "disabled") {
      return {
        result: { written: 0, skipped: "turn_memory_disabled" },
        mutationId: null,
      };
    }
    if (currentAssistant.memoryAuthority !== "enabled") {
      return {
        result: { written: 0, skipped: "turn_memory_legacy_unknown" },
        mutationId: null,
      };
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
      return {
        result: { written: 0, skipped: "stale_source" },
        mutationId: null,
      };
    }
    if (
      !canMemorize(currentUserMessage) ||
      !canMemorize(currentAssistant)
    ) {
      return {
        result: { written: 0, skipped: "blocked_or_deleted" },
        mutationId: null,
      };
    }

    await hooks.afterAuthorityLocked?.();

    const entitlement = await tx.chatEntitlementView.findUnique({
      where: { userId: currentSession.userId },
    });
    const policy = resolvePolicy(snapshotFromView(entitlement), {
      memoryEnabled: true,
    });
    const relationshipSignal = relationshipSignalForTurn(
      currentUserMessage.content,
    );
    // Commit only the immutable intent here. The projector advances the DB
    // watermark in the same completion transaction that marks this intent
    // applied, so `memoryExtractedAttempt` never claims a file write that has
    // not actually succeeded.
    const mutationId = await recordChatFileMutation(
      tx,
      currentSession.userId,
      {
        kind: "memory_extract",
        sessionId: currentSession.id,
        userMessageId: currentUserMessage.id,
        characterId: currentSession.characterId,
        turnKey: currentAssistant.id,
        attempt: payload.attempt,
        summaryDelta: relationshipTurnSummary(currentUserMessage.content),
        warmth: relationshipSignal.warmth,
        familiarity: relationshipSignal.familiarity,
        candidates,
        maxStored: policy.maxStoredMemories,
      },
    );

    return {
      result: { written: candidates.length, skipped: null },
      mutationId,
    };
    }),
    projectorPrisma,
  );
  if (committed.mutationId) {
    await projectChatFileMutations(
      session.userId,
      projectorPrisma,
    );
  }
  return committed.result;
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
