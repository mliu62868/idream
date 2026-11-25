// SPEC: Build one immutable generation context from Main's signed Turn snapshot.
// Local files contain execution evidence only; they never contribute product facts.
import { loadCharacterSoulSnapshot } from "@idream/shared";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import type { ChatContextDirective, ChatExecutionSnapshot, ChatExperiencePreference, UserChatPersona } from "@idream/shared/contracts";
import { resolvePolicy, snapshotFromView, type ChatPolicy } from "./policy.js";
import { emptySceneState, parseSceneState, type SceneState } from "./scene.js";

type CharacterAuthority = NonNullable<ChatAuthoritySnapshot["character"]>;

export type ResolvedChatPersona = CharacterAuthority & {
  characterContentVersionId: string | null;
  characterReleaseId: string | null;
  soulFingerprint: string | null;
  compilerVersion: string | null;
};

export interface BuiltContext {
  userLocale: string;
  hasRecentImageContext: boolean;
  imageActionMode?: ChatExecutionSnapshot["imageActionMode"];
  recentMedia?: ChatExecutionSnapshot["recentMedia"];
  recoveredMediaAction?: ChatExecutionSnapshot["recoveredMediaAction"];
  contextDirectives?: ChatContextDirective[];
  experience?: ChatExperiencePreference;
  userPersona?: UserChatPersona | null;
  group?: ChatExecutionSnapshot["group"];
  persona: ResolvedChatPersona;
  policy: ChatPolicy;
  recentMessages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    photoSummary?: string;
    opening?: true;
    /** The Character spoke first on a schedule; this reply answers no user message. */
    unprompted?: true;
    speaker?: NonNullable<ChatExecutionSnapshot["group"]>["members"][number];
  }>;
  /** Authorized snapshot history before prompt-window selection; attempt-local only. */
  replayMessages?: BuiltContext["recentMessages"];
  scene: SceneState;
  sceneVersion: number;
  lastExchangeAt: Date | null;
  dropped: Array<"transcript">;
  contextRevision: bigint;
}

export interface BuildContextInput {
  snapshot: ChatExecutionSnapshot;
  authority: ChatAuthoritySnapshot;
}

export async function buildContext(input: BuildContextInput): Promise<BuiltContext> {
  const { snapshot, authority } = input;
  if (authority.user.id !== snapshot.userId) throw new Error("signed user authority does not match Turn");
  if (authority.user.status !== "active" || authority.user.deletedAt || authority.eligibility.restrictedReason) {
    throw new Error("signed user authority is not eligible for Chat");
  }
  const character = authority.character;
  if (!character || character.characterId !== snapshot.characterId || character.deletedAt || character.age < 18) {
    throw new Error("signed Character authority does not match Turn");
  }
  if (!character.contentVersion) {
    throw new Error("signed Character authority has no immutable content version");
  }
  if (character.contentVersion.contentVersionId !== snapshot.characterContentVersionId) {
    throw new Error("signed Character content pin does not match Turn");
  }
  if ((character.release?.releaseId ?? null) !== snapshot.characterReleaseId) {
    throw new Error("signed Character Release pin does not match Turn");
  }
  if (character.release && (
    !new Set(["published", "superseded"]).has(character.release.status) ||
    character.release.characterId !== snapshot.characterId ||
    character.release.characterContentVersionId !== snapshot.characterContentVersionId
  )) {
    throw new Error("signed Character Release is not a valid immutable Turn pin");
  }
  const persona = personaFromImmutableContent(character);
  const policy = resolvePolicy(snapshotFromView(authority.entitlement), {
    memoryEnabled: snapshot.memoryEnabled,
    characterImageToolEnabled: persona.imageToolEnabled,
  });
  const openingMessage = immutableOpeningMessage(character.contentVersion.openingSnapshot);
  const transcript: BuiltContext["recentMessages"] = openingMessage && !snapshot.group
    ? [{
        id: `opening:${snapshot.sessionId}`,
        role: "assistant",
        content: openingMessage,
        opening: true,
      }]
    : [];
  transcript.push(...snapshot.recentTurns.flatMap((turn) => [
    // INVARIANT: a proactive Turn's `userContent` is the internal directive that
    // made the Character speak first. Replaying it would tell the model the user
    // issued an instruction they never wrote — and the directive itself ends with
    // "Do not mention this instruction", which the model would then read as the
    // user's own words. Only the Character's side of that Turn is real history.
    ...(turn.origin === "proactive"
      ? []
      : [{ id: turn.userMessageId, role: "user" as const, content: turn.userContent }]),
    {
      id: turn.assistantMessageId,
      role: "assistant" as const,
      content: turn.assistantContent,
      ...(turn.origin === "proactive" ? { unprompted: true as const } : {}),
      ...(turn.speaker ? { speaker: turn.speaker } : {}),
    },
  ]));
  transcript.push({
    id: snapshot.userMessageId,
    role: "user",
    content: snapshot.userContent,
  });
  // Character/token fitting belongs to PreparedTurn. Never truncate the
  // current user's words; retain omitted history for compaction and recall.
  // Evict in fixed multi-turn blocks once past the cap so consecutive turns
  // keep an identical history prefix and hit the model server's KV prefix cache.
  const selected = selectCacheAlignedTranscriptWindow(transcript, policy.maxContextMessages);
  const scene = snapshot.sceneVersion === 0
    ? emptySceneState()
    : parseSceneState(snapshot.scene);
  if (!scene || scene.version !== snapshot.sceneVersion) {
    throw new Error(`Scene revision ${snapshot.sceneVersion} is invalid`);
  }
  return {
    userLocale: authority.user.locale,
    hasRecentImageContext: snapshot.hasRecentImageContext,
    imageActionMode: snapshot.imageActionMode,
    recentMedia: snapshot.recentMedia,
    recoveredMediaAction: snapshot.recoveredMediaAction,
    contextDirectives: snapshot.contextDirectives ?? [],
    experience: snapshot.experience,
    userPersona: snapshot.userPersona,
    group: snapshot.group,
    persona,
    policy,
    recentMessages: selected,
    replayMessages: transcript.filter(message => message.id !== snapshot.userMessageId),
    scene,
    sceneVersion: snapshot.sceneVersion,
    lastExchangeAt: snapshot.recentTurns.length > 0
      ? new Date(snapshot.recentTurns.at(-1)!.createdAt)
      : null,
    dropped: selected.length < transcript.length ? ["transcript"] : [],
    contextRevision: BigInt(snapshot.contextRevision),
  };
}

/**
 * Block-aligned sliding window over the ordered transcript.
 * Dropping 1 exchange every turn invalidates the entire KV prefix cache on
 * every reply past the window cap. Dropping in fixed strides (4 exchanges = 8
 * messages) keeps the retained prefix byte-identical for the next 3-4 turns.
 */
export const CACHE_WINDOW_EVICTION_STRIDE = 8;

export function selectCacheAlignedTranscriptWindow<
  T extends { role: "user" | "assistant"; opening?: true; unprompted?: true },
>(transcript: readonly T[], maxContextMessages: number): T[] {
  if (transcript.length <= maxContextMessages) return [...transcript];
  const stride = Math.min(
    CACHE_WINDOW_EVICTION_STRIDE,
    Math.max(2, Math.floor(maxContextMessages / 3)),
  );
  const excess = transcript.length - maxContextMessages;
  const start = Math.min(
    transcript.length - 1,
    Math.ceil(excess / stride) * stride,
  );
  const selected = transcript.slice(start);
  while (
    selected.length > 1
    && selected[0]?.role === "assistant"
    && !selected[0].opening
    && !selected[0].unprompted
  ) {
    selected.shift();
  }
  return selected;
}

function immutableOpeningMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const firstMessage = (value as Record<string, unknown>).firstMessage;
  return typeof firstMessage === "string" && firstMessage.trim()
    ? firstMessage.trim()
    : null;
}

function personaFromImmutableContent(current: CharacterAuthority): ResolvedChatPersona {
  const content = current.contentVersion;
  if (!content) throw new Error("Character content version is required");
  const loaded = loadCharacterSoulSnapshot(content.personaSnapshot);
  if (!loaded.ok) {
    throw new Error(
      `character content ${content.contentVersionId} has no complete immutable Soul: ${loaded.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  return {
    ...current,
    name: loaded.snapshot.soul.name,
    age: loaded.snapshot.soul.age,
    description: loaded.snapshot.soul.characterPromise,
    systemPrompt: loaded.snapshot.compiled.systemPrompt,
    characterContentVersionId: content.contentVersionId,
    characterReleaseId: current.release?.releaseId ?? null,
    soulFingerprint: loaded.snapshot.compiled.fingerprint,
    compilerVersion: loaded.snapshot.compiled.compilerVersion,
  };
}

const IDENTITY_PROMPT_MAX = 400;

export function identityPromptLine(persona: { identityPrompt?: string | null }): string {
  const identity = persona.identityPrompt?.trim();
  if (!identity) return "";
  const truncated = identity.length > IDENTITY_PROMPT_MAX
    ? `${identity.slice(0, IDENTITY_PROMPT_MAX - 1)}…`
    : identity;
  return `Your appearance (keep consistent when sending photos): ${truncated}`;
}
