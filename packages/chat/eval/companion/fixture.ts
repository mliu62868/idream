// SPEC: turn one eval case into the signed Main snapshots that Chat receives in
// production (ChatExecutionSnapshot + ChatAuthoritySnapshot). The harness then
// runs them through the real context builder, PreparedTurn compiler and engine.
// INVARIANT: every fixture is schema-validated with the shared contract, so a
// case that would be rejected by Main/Chat cannot silently become a prompt-only
// experiment.
import { createHash } from "node:crypto";
import { compileCharacterSoul } from "@idream/shared";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import { chatExecutionSnapshotSchema, type ChatExecutionSnapshot } from "@idream/shared/contracts";

export type PersonaFixture = {
  name: string;
  age: number;
  gender: string;
  characterPromise: string;
  detailsMarkdown?: string;
  firstMessage?: string;
};

export type HistoryTurn = {
  user: string;
  assistant: string;
  /** Group chats only: persona key of the member who wrote `assistant`. */
  speaker?: string;
};

export type SceneFixture = {
  location: string | null;
  time: string | null;
  participants: string[];
  emotionalBeat: string | null;
  unresolvedThreads: string[];
};

export type TurnFixture = {
  persona: string;
  locale?: string;
  history?: HistoryTurn[];
  user: string;
  /** Persona keys; the responding persona must be one of them. */
  group?: string[];
  scene?: SceneFixture;
  experience?: {
    responseLength?: "auto" | "short" | "long";
    interactionIntensity?: "gentle" | "balanced" | "expressive";
    sceneGeneration?: "follow" | "advance";
  };
  userPersona?: { name: string; description: string };
  customInstruction?: string;
  pinnedMemories?: string[];
  media?: {
    /** Entitlement + Character image tool. Default false. */
    imageTool?: boolean;
    imageActionMode?: "chat" | "paid" | "library";
    libraryKinds?: Array<"image" | "video">;
    hasRecentImageContext?: boolean;
    recentMedia?: NonNullable<ChatExecutionSnapshot["recentMedia"]>;
  };
  /** Default false: the harness executes in private memory mode. */
  memoryEnabled?: boolean;
  modelTier?: "free" | "premium" | "deluxe";
};

const id = (...parts: string[]) => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);

export function buildSnapshots(
  caseId: string,
  turn: TurnFixture,
  personas: Record<string, PersonaFixture>,
  now: Date,
): { snapshot: ChatExecutionSnapshot; authority: ChatAuthoritySnapshot } {
  const persona = personas[turn.persona];
  if (!persona) throw new Error(`${caseId}: unknown persona ${turn.persona}`);
  const userId = `eval-user-${id(caseId)}`;
  const characterId = (key: string) => `eval-character-${key}`;
  const sessionId = (key: string) => `eval-session-${id(caseId, key)}`;
  const compiled = compileCharacterSoul({
    name: persona.name, age: persona.age, gender: persona.gender,
    characterPromise: persona.characterPromise,
    ...(persona.detailsMarkdown ? { detailsMarkdown: persona.detailsMarkdown } : {}),
  });
  if (!compiled.ok) {
    throw new Error(`${caseId}: persona ${turn.persona} does not compile: ${compiled.diagnostics.map(d => d.code).join(",")}`);
  }
  const contentVersionId = `eval-content-${turn.persona}-${id(JSON.stringify(compiled.snapshot))}`;
  const group = turn.group ? {
    id: `eval-group-${id(caseId)}`,
    ordinal: 1,
    members: turn.group.map(key => {
      const member = personas[key];
      if (!member) throw new Error(`${caseId}: unknown group member ${key}`);
      return { characterId: characterId(key), sessionId: sessionId(key), name: member.name };
    }),
  } : undefined;
  const memberFor = (key: string | undefined) => {
    if (!group) {
      if (key) throw new Error(`${caseId}: speaker is only valid in a group case`);
      return undefined;
    }
    const resolved = group.members.find(member => member.characterId === characterId(key ?? turn.persona));
    if (!resolved) throw new Error(`${caseId}: speaker ${key} is not a group member`);
    return resolved;
  };
  const history = turn.history ?? [];
  const recentTurns = history.map((entry, index) => {
    const speaker = memberFor(entry.speaker);
    return {
      turnId: `eval-turn-${id(caseId, String(index))}`,
      userMessageId: `eval-user-message-${id(caseId, String(index))}`,
      assistantMessageId: `eval-assistant-message-${id(caseId, String(index))}`,
      userContent: entry.user,
      assistantContent: entry.assistant,
      // Two minutes apart, ending three minutes before the current message.
      createdAt: new Date(now.getTime() - (history.length - index + 1) * 120_000).toISOString(),
      ...(speaker ? { speaker } : {}),
    };
  });
  const scene = turn.scene ? { schemaVersion: 1 as const, version: 3, ...turn.scene } : null;
  const directives = [
    ...(turn.customInstruction ? [{ id: `eval-instruction-${id(caseId)}`, kind: "custom_instruction" as const, content: turn.customInstruction, version: 1 }] : []),
    ...(turn.pinnedMemories ?? []).map((content, index) => ({ id: `eval-pin-${id(caseId, String(index))}`, kind: "pinned_memory" as const, content, version: 1 })),
  ];
  const snapshot = chatExecutionSnapshotSchema.parse({
    version: 1,
    turnId: `eval-turn-${id(caseId, "current")}`,
    sessionId: sessionId(turn.persona),
    userMessageId: `eval-user-message-${id(caseId, "current")}`,
    assistantMessageId: `eval-assistant-message-${id(caseId, "current")}`,
    attempt: 1,
    userId,
    characterId: characterId(turn.persona),
    characterContentVersionId: contentVersionId,
    characterReleaseId: null,
    characterVisualProfileId: null,
    characterVisualProfileVersion: null,
    memoryEnabled: turn.memoryEnabled ?? false,
    contextDirectives: directives,
    ...(turn.experience ? { experience: {
      responseLength: turn.experience.responseLength ?? "auto",
      interactionIntensity: turn.experience.interactionIntensity ?? "balanced",
      sceneGeneration: turn.experience.sceneGeneration ?? "follow",
      version: 1,
    } } : {}),
    userPersona: turn.userPersona ? { enabled: true, ...turn.userPersona, version: 1 } : null,
    contextRevision: history.length * 2 + 1,
    userContent: turn.user,
    imageActionMode: turn.media?.imageActionMode ?? "chat",
    imageEditSourceAssetId: turn.media?.hasRecentImageContext ? (turn.media.recentMedia?.[0]?.mediaAssetId ?? null) : null,
    ...(turn.media?.recentMedia ? { recentMedia: turn.media.recentMedia } : {}),
    ...(group ? { group } : {}),
    hasRecentImageContext: turn.media?.hasRecentImageContext ?? false,
    recentTurns,
    sceneVersion: scene?.version ?? 0,
    scene,
  });
  const imageTool = turn.media?.imageTool ?? false;
  const authority: ChatAuthoritySnapshot = {
    version: 1,
    user: { id: userId, displayName: null, locale: turn.locale ?? "en", status: "active", deletedAt: null, dataClass: "audit" },
    eligibility: { ageGateAccepted: true, ageVerified: true, jurisdiction: null, restrictedReason: null },
    entitlement: { modelTier: turn.modelTier ?? "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: imageTool },
    character: {
      characterId: characterId(turn.persona), creatorId: null, name: persona.name, age: persona.age,
      description: persona.characterPromise, systemPrompt: null, visibility: "public", status: "approved",
      voiceId: null, visualProfileId: null, visualProfileVersion: null, identityPrompt: null,
      imageToolEnabled: imageTool, mediaLibraryKinds: turn.media?.libraryKinds ?? [], deletedAt: null,
      contentVersion: {
        contentVersionId, characterId: characterId(turn.persona), version: 1,
        contentHash: id(JSON.stringify(compiled.snapshot)),
        personaSnapshot: compiled.snapshot,
        openingSnapshot: persona.firstMessage ? { firstMessage: persona.firstMessage } : {},
        appearanceSnapshot: {},
      },
      release: null,
    },
  };
  return { snapshot, authority };
}
