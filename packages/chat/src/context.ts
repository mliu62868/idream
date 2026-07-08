// SPEC: Build the model context for a turn (design §3 step 8). Recent messages +
// rolling summary come from PG (authority). Persona/entitlement from read-only
// views. Long-term memory + boundaries from the file layer, with a TIMEOUT budget:
// on timeout/error we degrade to "recent messages only" and never block the reply
// (design §5 hot-path degradation). memory_enabled=false reads NO long-term memory.
import type { ChatPrismaClient, ChatCharacterView } from "./db.js";
import { env } from "./env.js";
import { resolvePolicy, snapshotFromView, type ChatPolicy } from "./policy.js";
import { readBoundaries, retrieveMemories } from "./retrieval.js";
import { getRelationshipState } from "./relationship.js";

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
}

export interface BuildContextInput {
  prisma: ChatPrismaClient;
  userId: string;
  characterId: string;
  sessionId: string;
  memoryEnabled: boolean;
  /** Anchor the model context to the user turn being answered/regenerated. */
  userMessageId?: string;
}

export async function buildContext(input: BuildContextInput): Promise<BuiltContext> {
  const { prisma, userId, characterId, sessionId, memoryEnabled, userMessageId } = input;

  const [persona, entitlementRow, session, anchorUserMessage, latestUserMessage] = await Promise.all([
    prisma.chatCharacterView.findUnique({ where: { characterId } }),
    prisma.chatEntitlementView.findUnique({ where: { userId } }),
    prisma.chatSession.findUnique({ where: { id: sessionId } }),
    userMessageId
      ? prisma.message.findUnique({
          where: { id: userMessageId },
          select: { id: true, sessionId: true, role: true, status: true, createdAt: true },
        })
      : Promise.resolve(null),
    prisma.message.findFirst({
      where: { sessionId, role: "user", status: "sent", deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
  ]);
  if (!persona) throw new Error(`character ${characterId} not visible to chat`);
  const anchor =
    anchorUserMessage?.sessionId === sessionId &&
    anchorUserMessage.role === "user" &&
    anchorUserMessage.status === "sent"
      ? anchorUserMessage
      : null;

  const policy = resolvePolicy(snapshotFromView(entitlementRow), {
    memoryEnabled,
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
    orderBy: { createdAt: "desc" },
    take: policy.maxContextMessages,
  });
  const recentMessages: BuiltContext["recentMessages"] = recent
    .reverse()
    .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.content }));

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
  if (memoryEnabled && policy.maxMemories > 0) {
    // Fail-closed: a genuine boundaries read error propagates and aborts the turn.
    boundaries = await readBoundaries(userId);

    const query = [...recentMessages].reverse().find((m) => m.role === "user")?.content ?? "";
    const read = retrieveMemories({ userId, characterId, query, max: policy.maxMemories });
    // Outer hot-path cap. recency = 250ms; igrep mode gets its own budget + margin
    // (retrieveMemories self-degrades to recency on its internal igrep timeout).
    const budget =
      env.MEMORY_RETRIEVAL === "igrep"
        ? env.MEMORY_RETRIEVAL_TIMEOUT_MS + MEMORY_READ_TIMEOUT_MS
        : MEMORY_READ_TIMEOUT_MS;
    longTermMemories = await withTimeout(read, budget, []);

    // Relationship: qualitative bond for tone/continuity (P1-B). Degradable like
    // memories — a slow/failed read drops to null, never blocks the reply. Only
    // injected once a bond has actually formed (version > 0).
    const relRead = getRelationshipState(userId, characterId).then((r) =>
      r.version > 0 ? { stage: r.stage, summary: r.summary } : null,
    );
    relationship = await withTimeout(relRead, MEMORY_READ_TIMEOUT_MS, null);
  }

  const anchoredToLatestTurn = !anchor || anchor.id === latestUserMessage?.id;

  return {
    persona,
    policy,
    // No-memory means no derived context. When regenerating an older turn, skip the
    // rolling summary too: it may contain future turns after the anchor message.
    sessionSummary:
      memoryEnabled && anchoredToLatestTurn
        ? session?.memorySummary ?? null
        : null,
    recentMessages,
    boundaries,
    longTermMemories,
    relationship,
    canUpdateSessionSummary: memoryEnabled && anchoredToLatestTurn,
  };
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
