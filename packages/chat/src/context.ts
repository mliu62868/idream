// SPEC: Build the model context for a turn (design §3 step 8). Recent messages +
// rolling summary come from PG (authority). Persona/entitlement from read-only
// views. Long-term memory + boundaries from the file layer, with a TIMEOUT budget:
// on timeout/error we degrade to "recent messages only" and never block the reply
// (design §5 hot-path degradation). memory_enabled=false reads NO long-term memory.
import { resolveCharacterPersonaSnapshot } from "@idream/shared";
import type { ChatPrismaClient, ChatCharacterView } from "./db.js";
import { env } from "./env.js";
import { resolvePolicy, snapshotFromView, type ChatPolicy } from "./policy.js";
import { readBoundaries, retrieveMemories } from "./retrieval.js";
import { getRelationshipState } from "./relationship.js";
import {
  CHAT_CONTEXT_INVALIDATING_FILE_MUTATIONS,
  withReadableChatFileSnapshot,
} from "./file-mutations.js";

const MEMORY_READ_TIMEOUT_MS = 250;

const PHOTO_AWARENESS_MESSAGE_WINDOW = 6;

export interface BuiltContext {
  persona: ChatCharacterView;
  policy: ChatPolicy;
  sessionSummary: string | null;
  recentMessages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    /** P4 Task 5: set when this assistant message delivered a completed photo — the
     * agent's own recollection of what it sent, injected as a context line by
     * generate.ts's buildModelMessages (not stored, not user-visible). */
    photoSummary?: string;
  }>;
  boundaries: string[];
  longTermMemories: string[];
  /** Qualitative companion bond for tone/continuity (P1-B). Null when none/incognito. */
  relationship: { stage: string; summary: string } | null;
  /** False for no-memory sessions and old-turn regenerations. */
  canUpdateSessionSummary: boolean;
  /** Privacy/context fence revalidated after the model returns. */
  sessionContextRevision: bigint;
  fileContextRevision: bigint;
}

export interface BuildContextInput {
  prisma: ChatPrismaClient;
  userId: string;
  characterId: string;
  sessionId: string;
  /** Immutable authority captured on the assistant turn, not the mutable session preference. */
  turnMemoryEnabled: boolean;
  /** Anchor the model context to the user turn being answered/regenerated. */
  userMessageId?: string;
}

export async function buildContext(input: BuildContextInput): Promise<BuiltContext> {
  return withReadableChatFileSnapshot(
    input.userId,
    () => buildContextSnapshot(input),
    input.prisma,
  );
}

async function buildContextSnapshot(
  input: BuildContextInput,
): Promise<BuiltContext> {
  const { prisma, userId, characterId, sessionId, turnMemoryEnabled, userMessageId } = input;

  const [currentPersona, entitlementRow, session, anchorUserMessage, latestUserMessage] = await Promise.all([
    prisma.chatCharacterView.findUnique({ where: { characterId } }),
    prisma.chatEntitlementView.findUnique({ where: { userId } }),
    prisma.chatSession.findUnique({ where: { id: sessionId } }),
    userMessageId
      ? prisma.message.findUnique({
          where: { id: userMessageId },
          select: {
            id: true,
            sessionId: true,
            role: true,
            status: true,
            createdAt: true,
            characterContentVersionId: true,
            characterReleaseId: true,
          },
        })
      : Promise.resolve(null),
    prisma.message.findFirst({
      where: { sessionId, role: "user", status: "sent", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
  ]);
  if (!currentPersona) throw new Error(`character ${characterId} not visible to chat`);
  const anchor =
    anchorUserMessage?.sessionId === sessionId &&
    anchorUserMessage.role === "user" &&
    anchorUserMessage.status === "sent"
      ? anchorUserMessage
      : null;

  const pinnedContentVersionId =
    anchor?.characterContentVersionId ?? session?.characterContentVersionId ?? null;
  const pinnedReleaseId =
    anchor?.characterReleaseId ?? session?.characterReleaseId ?? null;
  const contentVersion = pinnedContentVersionId
    ? await prisma.chatCharacterContentVersionView.findUnique({
        where: { contentVersionId: pinnedContentVersionId },
      })
    : null;
  if (
    pinnedContentVersionId &&
    (!contentVersion || contentVersion.characterId !== characterId)
  ) {
    throw new Error(
      `pinned content version ${pinnedContentVersionId} is unavailable for character ${characterId}`,
    );
  }
  const persona = contentVersion
    ? personaFromImmutableContent(currentPersona, contentVersion.personaSnapshot, {
        characterContentVersionId: contentVersion.contentVersionId,
        characterReleaseId: pinnedReleaseId,
      })
    : currentPersona;

  const policy = resolvePolicy(snapshotFromView(entitlementRow), {
    memoryEnabled: turnMemoryEnabled,
    characterImageToolEnabled: persona.imageToolEnabled,
  });

  const recent = await prisma.message.findMany({
    where: {
      sessionId,
      status: "sent",
      role: { in: ["user", "assistant"] },
      deletedAt: null,
      ...(anchor ? { createdAt: { lte: anchor.createdAt } } : {}),
    },
    // user + assistant are born in one transaction and therefore share
    // createdAt. In the DESC window assistant must sort first so reverse()
    // restores the semantic user → assistant order.
    orderBy: [{ createdAt: "desc" }, { role: "asc" }],
    take: policy.maxContextMessages,
  });
  const orderedRecent: BuiltContext["recentMessages"] = recent
    .reverse()
    .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.content }));
  const recentMessages = fitRecentTranscript(orderedRecent, policy.maxContextChars);

  // P4 Task 5: photo awareness. Only the most recent window of assistant turns is
  // worth reminding the model about — older deliveries are already summarized away
  // by the rolling session summary.
  const photoAwareMessageIds = recentMessages
    .slice(-PHOTO_AWARENESS_MESSAGE_WINDOW)
    .filter((m) => m.role === "assistant")
    .map((m) => m.id);
  if (photoAwareMessageIds.length > 0) {
    const attachments = await prisma.messageAttachment.findMany({
      where: { messageId: { in: photoAwareMessageIds }, kind: "generated_image", status: "completed" },
      select: { messageId: true, promptHint: true, metadata: true },
      orderBy: { createdAt: "asc" },
    });
    const summaryByMessageId = new Map<string, string>();
    for (const attachment of attachments) {
      if (summaryByMessageId.has(attachment.messageId)) continue;
      const metadata = (attachment.metadata ?? {}) as Record<string, unknown>;
      const summary = typeof metadata.summary === "string" ? metadata.summary : attachment.promptHint;
      if (summary) summaryByMessageId.set(attachment.messageId, summary);
    }
    for (const message of recentMessages) {
      const summary = summaryByMessageId.get(message.id);
      if (summary) message.photoSummary = summary;
    }
  }

  // File-layer retrieval (design §3 step 8 / P0-G). Boundaries and normal memories
  // are read SEPARATELY with different reliability contracts:
  //   - boundaries: full read every turn, NO timeout/degrade. A read error fails
  //     closed (throws) so we never generate a boundary-less reply.
  //   - long-term memories: degradable. Timeout/error → drop to recent-only.
  let boundaries: string[] = [];
  let longTermMemories: string[] = [];
  let relationship: BuiltContext["relationship"] = null;

  // Global interaction boundaries are not memories. They remain in force for
  // incognito sessions and zero-memory tiers, and any read failure aborts the
  // turn rather than silently generating without them.
  boundaries = await readBoundaries(userId);

  if (turnMemoryEnabled && policy.maxMemories > 0) {
    const query =
      [...recentMessages]
        .reverse()
        .find((message) => message.role === "user")?.content ?? "";
    const read = retrieveMemories({
      userId,
      characterId,
      query,
      max: policy.maxMemories,
    });
    // Outer hot-path cap. recency = 250ms; igrep mode gets its own budget +
    // margin (retrieveMemories self-degrades to recency on its own timeout).
    const budget =
      env.MEMORY_RETRIEVAL === "igrep"
        ? env.MEMORY_RETRIEVAL_TIMEOUT_MS + MEMORY_READ_TIMEOUT_MS
        : MEMORY_READ_TIMEOUT_MS;
    longTermMemories = await withTimeout(read, budget, []);

    // Relationship is degradable like ordinary memories. A committed pending
    // mutation is not: buildContext's shared user lock makes this one coherent
    // PG + file authority snapshot.
    const relRead = getRelationshipState(userId, characterId).then((value) =>
      value.version > 0
        ? { stage: value.stage, summary: value.summary }
        : null,
    );
    relationship = await withTimeout(
      relRead,
      MEMORY_READ_TIMEOUT_MS,
      null,
    );
  }

  const anchoredToLatestTurn = !anchor || anchor.id === latestUserMessage?.id;
  const latestInvalidatingMutation =
    await prisma.chatFileMutation.findFirst({
      where: {
        userId,
        status: "applied",
        kind: {
          in: [...CHAT_CONTEXT_INVALIDATING_FILE_MUTATIONS],
        },
      },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });

  return {
    persona,
    policy,
    // No-memory means no derived context. When regenerating an older turn, skip the
    // rolling summary too: it may contain future turns after the anchor message.
    sessionSummary:
      turnMemoryEnabled && anchoredToLatestTurn
        ? session?.memorySummary ?? null
        : null,
    recentMessages,
    boundaries,
    longTermMemories,
    relationship,
    canUpdateSessionSummary: turnMemoryEnabled && anchoredToLatestTurn,
    sessionContextRevision: session?.contextRevision ?? 0n,
    fileContextRevision: latestInvalidatingMutation?.sequence ?? 0n,
  };
}

function personaFromImmutableContent(
  current: ChatCharacterView,
  snapshotValue: unknown,
  pin: {
    readonly characterContentVersionId: string;
    readonly characterReleaseId: string | null;
  },
): ChatCharacterView {
  const snapshot = resolveCharacterPersonaSnapshot(snapshotValue);
  if (!snapshot) {
    throw new Error(
      `character content ${pin.characterContentVersionId} has no complete immutable persona`,
    );
  }
  return {
    ...current,
    name: snapshot.name,
    age: snapshot.age,
    description: snapshot.description,
    systemPrompt: snapshot.systemPrompt,
    relationship: snapshot.relationship,
    characterContentVersionId: pin.characterContentVersionId,
    characterReleaseId: pin.characterReleaseId,
  };
}

function fitRecentTranscript(
  messages: BuiltContext["recentMessages"],
  maxChars: number,
): BuiltContext["recentMessages"] {
  const selected: BuiltContext["recentMessages"] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (message.content.length > remaining) {
      if (selected.length === 0) {
        selected.unshift({ ...message, content: `…${message.content.slice(-(Math.max(1, remaining - 1)))}` });
      }
      break;
    }
    selected.unshift(message);
    used += message.content.length;
  }
  // Never begin a clipped context with an orphan assistant response.
  if (selected.length > 1 && selected[0]?.role === "assistant") selected.shift();
  return selected;
}

const IDENTITY_PROMPT_MAX = 400;

/** Shared by generate.ts (assistant system prompt) and agent-tools.ts (tool planner
 * prompt) so the visual passport line — when present — reads identically in both. */
export function identityPromptLine(persona: { identityPrompt?: string | null }): string {
  const identity = persona.identityPrompt?.trim();
  if (!identity) return "";
  const truncated = identity.length > IDENTITY_PROMPT_MAX ? `${identity.slice(0, IDENTITY_PROMPT_MAX - 1)}…` : identity;
  return `Your appearance (keep consistent when sending photos): ${truncated}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
