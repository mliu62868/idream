import type { Prisma } from "@prisma/client";
import { isRecord } from "@/server/lib/request-json";
import { pruneUndefined } from "./json-values";
import type {
  GenerationPromptCharacter,
  GenerationVisualProfile,
} from "./generation-character-authority";
import type {
  GenerationCreateBody,
  GenerationSource,
} from "./generation-request-schema";

// SPEC: 把一次生成请求（角色身份 + 用户意图 + 预设/Look 片段）编译成投给 runner 的
// prompt / negativePrompt / momentSpec。
//
// INTENT: prompt 拼装是纯函数 —— 没有库、没有事务、没有 HTTP。把它和写库的那段分开，
// 是为了让"这段文字为什么长这样"能被单独读懂、单独改，而不必先读懂 447 行的下单事务。

export function buildGenerationPrompt(input: {
  mode: "image" | "video";
  character: GenerationPromptCharacter | null;
  visualProfile: GenerationVisualProfile | null;
  consistencyMode: "balanced" | "strict" | "creative";
  userPrompt?: string;
  presetFragment: string;
  lookFragment: string;
  sourceType?: string;
}) {
  const userPrompt = cleanPromptText(input.userPrompt, 900);
  const base =
    input.mode === "image"
      ? buildImageGenerationPrompt({
          character: input.character,
          visualProfile: input.visualProfile,
          consistencyMode: input.consistencyMode,
          userPrompt,
          sourceType: input.sourceType,
        })
      : buildVideoGenerationPrompt(input.character, userPrompt);
  const preset = cleanPromptText(input.presetFragment, 500);
  const look = cleanPromptText(input.lookFragment, 500);
  return clampPrompt(
    [base, look ? `Active look: ${look}` : null, preset ? `Scene details: ${preset}` : null]
      .filter(Boolean)
      .join(". "),
    2_000,
  );
}

function buildImageGenerationPrompt(input: {
  character: GenerationPromptCharacter | null;
  visualProfile: GenerationVisualProfile | null;
  consistencyMode: "balanced" | "strict" | "creative";
  userPrompt: string;
  sourceType?: string;
}) {
  const request =
    input.userPrompt ||
    (input.sourceType === "chat_image"
      ? "candid in-character portrait shared from the current moment"
      : "natural in-character portrait");

  if (!input.character) {
    return clampPrompt(
      [
        "High quality original companion portrait",
        `Requested scene: ${request}`,
        "single coherent subject, expressive face, natural pose, well-lit face, properly exposed, sharp focus, detailed eyes, natural skin texture, clean composition",
      ].join(". "),
      2_000,
    );
  }

  const character = input.character;
  const visualProfile = input.visualProfile;
  const details = [
    cleanPromptText(character.description, 500),
    ...promptDetails(character.appearance, "Appearance"),
    ...promptDetails(character.advancedDetails, "Character detail"),
  ].filter(Boolean);
  const presentation = [
    "adult",
    cleanPromptText(character.gender, 80),
    cleanPromptText(character.style, 80),
  ].filter(Boolean);

  return clampPrompt(
    [
      `High quality in-character portrait photo of ${cleanPromptText(character.name, 120)}`,
      presentation.length ? `Subject: ${presentation.join(", ")}` : null,
      visualProfile
        ? `Locked identity: ${cleanPromptText(visualProfile.identityPrompt, 900)}`
        : details.length
          ? `Character: ${details.join("; ")}`
          : null,
      visualProfile ? consistencyPromptFragment(input.consistencyMode) : null,
      visualProfile && details.length ? `Character notes: ${details.join("; ")}` : null,
      `Requested scene: ${request}`,
      "single coherent subject, face and body matching the character, expressive eyes, natural pose, well-lit visible face, properly exposed, sharp focus, detailed skin and hair, clean photographic composition",
    ]
      .filter(Boolean)
      .join(". "),
    2_000,
  );
}

function consistencyPromptFragment(mode: "balanced" | "strict" | "creative") {
  if (mode === "strict") {
    return "Identity consistency: strict; preserve the same face, hairstyle, eye color, body type, and signature traits from the locked identity";
  }
  if (mode === "creative") {
    return "Identity consistency: creative; allow scene and styling variation while preserving the core face, hair, and signature traits";
  }
  return "Identity consistency: balanced; preserve the character identity while allowing the requested scene, pose, outfit, and lighting";
}

export function imageNegativePrompt(
  base: string | null,
  visualProfile: GenerationVisualProfile | null,
) {
  const cleanBase = cleanPromptText(base, 900);
  const identityNegative = cleanPromptText(visualProfile?.negativeIdentityPrompt, 400);
  return [cleanBase, identityNegative].filter(Boolean).join(", ") || null;
}

export function buildMomentSpec(
  body: GenerationCreateBody,
  source?: GenerationSource,
  requestFingerprint?: string,
) {
  const controls = body.controls as Record<string, unknown>;
  const rawInput = cleanPromptText(body.prompt, 2_000) || "A natural in-character moment";
  const continuitySources: string[] = [];
  if (source?.sourceType === "chat_image") continuitySources.push("chat_context");
  if (body.prompt) continuitySources.push("user_prompt");
  if (typeof controls.lookId === "string") continuitySources.push("character_look");
  if (typeof controls.sourceImageAssetId === "string") continuitySources.push("source_image");
  if (continuitySources.length === 0) continuitySources.push("product_default");

  return pruneUndefined({
    schemaVersion: "1",
    parserVersion: "moment-direct-v1",
    requestFingerprint,
    rawInput,
    scene: rawInput,
    action: typeof controls.pose === "string" ? controls.pose : undefined,
    expression: typeof controls.expression === "string" ? controls.expression : undefined,
    outfitIntent: typeof controls.outfitPresetId === "string" ? "change" : "unspecified",
    outfit: typeof controls.outfit === "string" ? controls.outfit : undefined,
    locationContinuity:
      source?.sourceType === "chat_image" ? "continue" : "unspecified",
    camera: typeof controls.camera === "string" ? controls.camera : undefined,
    lighting: typeof controls.lighting === "string" ? controls.lighting : undefined,
    styleDelta: typeof controls.styleDelta === "string" ? controls.styleDelta : undefined,
    confidence: 1,
    continuitySources,
    createdAt: new Date().toISOString(),
  });
}

function buildVideoGenerationPrompt(
  character: GenerationPromptCharacter | null,
  userPrompt: string,
) {
  const subject = character?.name ? cleanPromptText(character.name, 120) : "an original companion";
  return clampPrompt(userPrompt || `Video generation for ${subject}`, 2_000);
}

export function defaultImageNegativePrompt(templateNegative: string | null, sourceType?: string) {
  const base =
    cleanPromptText(templateNegative, 700) ||
    "low quality, distorted anatomy, extra fingers, watermark, text";
  const uiBlockers =
    "logo, user interface, app screen, phone screenshot, chat bubbles, buttons, icons, blurry, underexposed, silhouette, overly dark";
  return sourceType === "chat_image" ? `${base}, ${uiBlockers}` : `${base}, ${uiBlockers}`;
}

function promptDetails(value: Prisma.JsonValue, label: string) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .flatMap(([key, raw]) => promptDetailValue(`${label}.${key}`, raw))
    .filter(Boolean)
    .slice(0, 8);
}

function promptDetailValue(key: string, value: unknown): string[] {
  const cleanKey = cleanPromptText(key.replace(/[_.]+/g, " "), 80);
  if (!cleanKey || /source\s*image/i.test(cleanKey)) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const cleanValue = cleanPromptText(String(value), 180);
    if (!cleanValue || /^https?:\/\//i.test(cleanValue) || cleanValue.startsWith("/")) return [];
    return [`${cleanKey}: ${cleanValue}`];
  }
  if (Array.isArray(value)) {
    const values = value
      .filter((item): item is string | number | boolean =>
        ["string", "number", "boolean"].includes(typeof item),
      )
      .map((item) => cleanPromptText(String(item), 120))
      .filter((item) => item && !/^https?:\/\//i.test(item) && !item.startsWith("/"))
      .slice(0, 5);
    return values.length ? [`${cleanKey}: ${values.join(", ")}`] : [];
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .flatMap(([childKey, raw]) => promptDetailValue(`${key}.${childKey}`, raw))
      .slice(0, 8);
  }
  return [];
}

export function cleanPromptText(value: string | null | undefined, max = 2_000) {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return clampPrompt(cleaned, max);
}

export function clampPrompt(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 3).trimEnd()}...`;
}
