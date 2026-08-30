// SPEC: Build one immutable generation context from Main's signed Turn snapshot.
// Local files contain execution evidence only; they never contribute product facts.
import { loadCharacterSoulSnapshot } from "@idream/shared";
import type { ChatAuthoritySnapshot } from "@idream/shared/bff";
import type { ChatExecutionSnapshot } from "@idream/shared/contracts";
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
  persona: ResolvedChatPersona;
  policy: ChatPolicy;
  recentMessages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    photoSummary?: string;
    opening?: true;
  }>;
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
  const transcript: BuiltContext["recentMessages"] = snapshot.recentTurns.flatMap((turn) => [
    { id: turn.userMessageId, role: "user" as const, content: turn.userContent },
    { id: turn.assistantMessageId, role: "assistant" as const, content: turn.assistantContent },
  ]);
  transcript.push({
    id: snapshot.userMessageId,
    role: "user",
    content: snapshot.userContent,
  });
  const fitted = fitRecentTranscript(
    transcript.slice(-policy.maxContextMessages),
    policy.maxContextChars,
  );
  const scene = snapshot.sceneVersion === 0
    ? emptySceneState()
    : parseSceneState(snapshot.scene);
  if (!scene || scene.version !== snapshot.sceneVersion) {
    throw new Error(`Scene revision ${snapshot.sceneVersion} is invalid`);
  }
  return {
    persona,
    policy,
    recentMessages: fitted.messages,
    scene,
    sceneVersion: snapshot.sceneVersion,
    lastExchangeAt: snapshot.recentTurns.length > 0
      ? new Date(snapshot.recentTurns.at(-1)!.createdAt)
      : null,
    dropped: fitted.dropped ? ["transcript"] : [],
    contextRevision: BigInt(snapshot.contextRevision),
  };
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
        selected.unshift({ ...message, content: `…${message.content.slice(-Math.max(1, remaining - 1))}` });
      }
      break;
    }
    selected.unshift(message);
    used += message.content.length;
  }
  if (selected.length > 1 && selected[0]?.role === "assistant" && !selected[0].opening) selected.shift();
  return { messages: selected, dropped: selected.length < messages.length };
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
