// SPEC: Build the model context for a turn (design §3 step 8). Recent messages +
// pinned Soul/Scene/relationship and transcript form Chat's product authority.
// Official igrep injects generic memory inside the DSH runtime.
import { loadCharacterSoulSnapshot } from "@idream/shared";
import type { ReleasedKnowledgeSnapshot } from "@idream/shared/chat/companion-runtime";
import type { ChatPrismaClient, ChatCharacterView } from "./db.js";
import type { Prisma } from "../generated/client/client.js";
import { resolvePolicy, snapshotFromView, type ChatPolicy } from "./policy.js";
import { readBoundaries } from "./boundaries.js";
import { getRelationshipState } from "./relationship.js";
import {
  CHAT_CONTEXT_INVALIDATING_FILE_MUTATIONS,
  withReadableChatFileSnapshot,
} from "./file-mutations.js";
import {
  emptySceneState,
  parseSceneState,
  type SceneState,
} from "./scene.js";
import { buildReleasedKnowledgeSnapshot } from "./released-knowledge.js";

const RELATIONSHIP_READ_TIMEOUT_MS = 250;

const PHOTO_AWARENESS_MESSAGE_WINDOW = 6;

export interface BuiltContext {
  persona: ResolvedChatPersona;
  policy: ChatPolicy;
  recentMessages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    /** P4 Task 5: set when this assistant message delivered a completed photo — the
     * agent's own recollection of what it sent, injected as a context line by
     * generate.ts's buildModelMessages (not stored, not user-visible). */
    photoSummary?: string;
    /** The pinned opening line that started this session; it is conversation
     * content, not an orphaned reply, so transcript clipping keeps it. */
    opening?: true;
  }>;
  boundaries: string[];
  /** Qualitative companion bond for tone/continuity (P1-B). Null when none/incognito. */
  relationship: { stage: string; summary: string; version: number } | null;
  /** Immutable Scene revision pinned by the user turn being answered. */
  scene: SceneState;
  sceneVersion: number;
  /** When the previous exchange happened, so the turn state can say how long it has been. */
  lastExchangeAt: Date | null;
  /** Budget degradation is explicit; callers must surface it in PreparedTurn. */
  dropped: Array<"transcript">;
  /** Privacy/context fence revalidated after the model returns. */
  sessionContextRevision: bigint;
  fileContextRevision: bigint;
  /** Release/content-pinned bytes eligible for the sidecar's read-only knowledge/. */
  releasedKnowledge: ReleasedKnowledgeSnapshot;
}

export type ResolvedChatPersona = ChatCharacterView & {
  soulFingerprint?: string | null;
  compilerVersion?: string | null;
};

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
    (tx) => buildContextSnapshot({ ...input, prisma: tx }),
    input.prisma,
  );
}

type BuildContextSnapshotInput = Omit<BuildContextInput, "prisma"> & {
  prisma: ChatPrismaClient | Prisma.TransactionClient;
};

async function buildContextSnapshot(
  input: BuildContextSnapshotInput,
): Promise<BuiltContext> {
  const {
    prisma,
    userId,
    characterId,
    sessionId,
    turnMemoryEnabled,
    userMessageId,
  } = input;

  const currentPersona = await prisma.chatCharacterView.findUnique({
    where: { characterId },
  });
  const entitlementRow = await prisma.chatEntitlementView.findUnique({
    where: { userId },
  });
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
  });
  const anchorUserMessage = userMessageId
    ? await prisma.message.findUnique({
        where: { id: userMessageId },
        select: {
          id: true,
          sessionId: true,
          role: true,
          status: true,
          createdAt: true,
          characterContentVersionId: true,
          characterReleaseId: true,
          sceneVersion: true,
        },
      })
    : null;
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
  const release = pinnedReleaseId
    ? await prisma.chatCharacterReleaseView.findUnique({
        where: { releaseId: pinnedReleaseId },
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
  if (pinnedReleaseId && !release) {
    throw new Error(
      `pinned release ${pinnedReleaseId} is unavailable for character ${characterId}`,
    );
  }
  const releasedKnowledge = buildReleasedKnowledgeSnapshot({
    characterId,
    contentVersion: contentVersion
      ? {
          contentVersionId: contentVersion.contentVersionId,
          characterId: contentVersion.characterId,
          personaSnapshot: contentVersion.personaSnapshot,
        }
      : null,
    release: release
      ? {
          releaseId: release.releaseId,
          characterId: release.characterId,
          characterContentVersionId: release.characterContentVersionId,
          status: release.status,
        }
      : null,
  });
  const persona: ResolvedChatPersona = contentVersion
    ? personaFromImmutableContent(currentPersona, contentVersion.personaSnapshot, {
        characterContentVersionId: contentVersion.contentVersionId,
        characterReleaseId: pinnedReleaseId,
      })
    : { ...currentPersona, soulFingerprint: null, compilerVersion: null };

  const sceneVersion = anchor?.sceneVersion ?? 0;
  const scene = sceneVersion === 0
    ? emptySceneState()
    : parseSceneState((await prisma.chatSceneRevision.findFirst({
        where: { sessionId, version: sceneVersion },
        select: { snapshot: true },
      }))?.snapshot);
  if (!scene) {
    throw new Error(
      `scene revision ${sceneVersion} is unavailable for session ${sessionId}`,
    );
  }
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
  const previousExchange = recent.find((m) => m.id !== anchor?.id);
  const lastExchangeAt = anchor ? previousExchange?.createdAt ?? null : null;
  const orderedRecent: BuiltContext["recentMessages"] = recent
    .reverse()
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      ...(isOpeningMessage(m.runtimeTrace) ? { opening: true as const } : {}),
    }));
  const fittedTranscript = fitRecentTranscript(orderedRecent, policy.maxContextChars);
  const recentMessages = fittedTranscript.messages;
  const dropped: BuiltContext["dropped"] = fittedTranscript.dropped
    ? ["transcript"]
    : [];

  // Only the bounded recent transcript receives attachment-awareness hints.
  // Older media remains in MessageAttachment/Main authority and is never
  // compressed into a second prose-summary authority.
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

  // Global boundaries fail closed and remain independent from generic memory.
  let boundaries: string[] = [];
  let relationship: BuiltContext["relationship"] = null;

  // Global interaction boundaries are not memories. They remain in force for
  // incognito sessions and zero-memory tiers, and any read failure aborts the
  // turn rather than silently generating without them.
  boundaries = await readBoundaries(userId);

  if (turnMemoryEnabled) {
    // Relationship is Chat-owned companion state, not generic RAG memory. It
    // remains in PreparedTurn when the official runtime plugin owns recall.
    const relRead = getRelationshipState(userId, characterId).then((value) =>
      value.version > 0
        ? { stage: value.stage, summary: value.summary, version: value.version }
        : null,
    );
    relationship = await withTimeout(
      relRead,
      RELATIONSHIP_READ_TIMEOUT_MS,
      null,
    );
  }

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
    recentMessages,
    boundaries,
    relationship,
    scene,
    sceneVersion,
    lastExchangeAt,
    dropped,
    sessionContextRevision: session?.contextRevision ?? 0n,
    fileContextRevision: latestInvalidatingMutation?.sequence ?? 0n,
    releasedKnowledge,
  };
}

/** service.ts records the pinned opening as an assistant message with this trace kind. */
function isOpeningMessage(runtimeTrace: unknown): boolean {
  return typeof runtimeTrace === "object" && runtimeTrace !== null && !Array.isArray(runtimeTrace)
    && (runtimeTrace as Record<string, unknown>).messageKind === "opening";
}

function personaFromImmutableContent(
  current: ChatCharacterView,
  snapshotValue: unknown,
  pin: {
    readonly characterContentVersionId: string;
    readonly characterReleaseId: string | null;
  },
): ResolvedChatPersona {
  const loaded = loadCharacterSoulSnapshot(snapshotValue);
  if (!loaded.ok) {
    throw new Error(
      `character content ${pin.characterContentVersionId} has no complete immutable Soul: ${loaded.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  const identity = loaded.snapshot.soul.identity;
  return {
    ...current,
    name: identity.name,
    age: identity.age,
    description: identity.characterPromise,
    systemPrompt: loaded.snapshot.compiled.systemPrompt,
    relationship: identity.relationshipArchetype,
    characterContentVersionId: pin.characterContentVersionId,
    characterReleaseId: pin.characterReleaseId,
    soulFingerprint: loaded.snapshot.compiled.fingerprint,
    compilerVersion: loaded.snapshot.compiled.compilerVersion,
  };
}

export function fitRecentTranscript(
  messages: BuiltContext["recentMessages"],
  maxChars: number,
): { messages: BuiltContext["recentMessages"]; dropped: boolean } {
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
  // Never begin a clipped context with an orphan assistant response. The
  // session's pinned opening is the one assistant line that legitimately
  // starts a conversation; dropping it made the character forget how the
  // scene opened from the second turn on.
  if (selected.length > 1 && selected[0]?.role === "assistant" && !selected[0].opening) selected.shift();
  return { messages: selected, dropped: selected.length < messages.length };
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
