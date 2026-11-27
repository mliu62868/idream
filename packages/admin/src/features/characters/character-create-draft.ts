import {
  characterProjectCreateRequestSchema,
  characterProjectDraftSchema,
  characterProjectProductionReadyDraftSchema,
  type CharacterProjectDraft,
} from "@idream/shared/admin";
import { CHARACTER_STYLES, GENDERS, isCatalogMember } from "@idream/shared/catalog";
import type { DurableMutationIntent } from "@/lib/durable-mutation-intent";

type Draft = CharacterProjectDraft;

// SPEC: 创建只问「一个角色之所以是角色」的两件事——它是谁，它长什么样。
// INTENT: 市场简报、负责人、排期和 QA 计划不影响角色成立，也不参与发布，因此不进入草稿契约。
export const characterCreateSteps = [
  "Persona",
  "Visual direction",
] as const;

export const initialDraft: Draft = {
  persona: {
    name: "",
    age: 18,
    gender: "female",
    characterPromise: "",
    detailsMarkdown: "",
    firstMessage: "",
  },
  visualDirection: {
    identityAnchor: "",
    stableTraits: [],
    style: "realistic",
    referenceDirection: "",
  },
};

// SPEC: 每一句只说这一步真正拦人的东西，不多列一项。
// INTENT: Soul 只有基本信息与一个可选 Markdown 扩展，不再要求用户拆填人格、语气与示例对话。
export const characterCreateStepRequirements = [
  "Give the character a name, short description, and opening message.",
  "Say who they look like, the features that never change, and the image mood.",
] as const;

export function isCharacterCreateStepComplete(draft: Draft, step: number) {
  if (step === 0) {
    return characterProjectDraftSchema.shape.persona.safeParse(draft.persona)
      .success;
  }
  if (step === 1) {
    return characterProjectDraftSchema.shape.visualDirection.safeParse(
      draft.visualDirection,
    ).success;
  }
  return characterProjectProductionReadyDraftSchema.safeParse(draft).success;
}

export function firstIncompleteCharacterCreateStep(draft: Draft) {
  return isCharacterCreateStepComplete(draft, 0) ? 1 : 0;
}

export function localDraftStorageKey(actorId: string) {
  return `idream.admin.character-create-draft.v3:${actorId}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function isRecoverableLocalDraft(value: unknown): value is Draft {
  if (!isRecord(value)) return false;
  const persona = value.persona;
  const visualDirection = value.visualDirection;
  if (!isRecord(persona) || !isRecord(visualDirection)) return false;
  return (
    [
      persona.name,
      persona.characterPromise,
      persona.detailsMarkdown,
      persona.firstMessage,
      visualDirection.identityAnchor,
      visualDirection.referenceDirection,
    ].every((item) => typeof item === "string") &&
    typeof persona.age === "number" &&
    isCatalogMember(GENDERS, persona.gender) &&
    isCatalogMember(CHARACTER_STYLES, visualDirection.style) &&
    isStringArray(visualDirection.stableTraits)
  );
}

export function readLocalDraft(actorId: string) {
  if (typeof window === "undefined" || requestedDraftTarget()) return null;
  try {
    const currentRaw = window.localStorage.getItem(
      localDraftStorageKey(actorId),
    );
    if (!currentRaw) return null;
    const value: unknown = JSON.parse(currentRaw);
    return isRecoverableLocalDraft(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveLocalDraft(actorId: string, draft: Draft): boolean {
  if (typeof window === "undefined") return false;
  try {
    const key = localDraftStorageKey(actorId);
    const serialized = JSON.stringify(draft);
    window.localStorage.setItem(key, serialized);
    return window.localStorage.getItem(key) === serialized;
  } catch {
    // The in-memory draft remains usable when browser storage is unavailable.
    return false;
  }
}

export function clearLocalDraft(actorId: string) {
  try {
    window.localStorage.removeItem(localDraftStorageKey(actorId));
  } catch {
    // Nothing else is required when browser storage is unavailable.
  }
}

export function draftKey(value: Draft) {
  return JSON.stringify(value);
}

export function requestedDraftTarget() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("draft");
}

export function pinDraftToUrl(characterId: string) {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("draft", characterId);
    window.history.replaceState(
      null,
      "",
      `${url.pathname}?${url.searchParams.toString()}`,
    );
    return true;
  } catch {
    return false;
  }
}

export function draftFromCreateIntent(
  intent: DurableMutationIntent | null,
): Draft | null {
  const parsed = characterProjectCreateRequestSchema.safeParse(
    intent?.requestSnapshot,
  );
  if (!parsed.success) return null;
  return {
    persona: parsed.data.persona,
    visualDirection: parsed.data.visualDirection,
  };
}

export function tagIdsFromCreateIntent(intent: DurableMutationIntent | null): string[] {
  const parsed = characterProjectCreateRequestSchema.safeParse(intent?.requestSnapshot);
  return parsed.success ? [...(parsed.data.tagIds ?? [])] : [];
}

export function requestedTemplate() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("template");
}
