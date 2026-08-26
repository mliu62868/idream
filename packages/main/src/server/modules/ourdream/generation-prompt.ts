import type { Prisma } from "@prisma/client";
import { isRecord } from "@/server/lib/request-json";
import { pruneUndefined } from "./json-values";
import type {
  GenerationPromptCharacter,
  GenerationVisualProfile,
} from "./generation-character-authority";
import {
  assembleIdentityPrompt,
  toTraitRecord,
  type IdentityTraits,
} from "./identity-assembler";
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
  const presentation = [
    "adult",
    cleanPromptText(character.gender, 80),
    cleanPromptText(character.style, 80),
  ].filter(Boolean);
  // INTENT: 一个角色只有一种描述法。Release 有没有 pin 身份，决定的是**走不走参考图路由**
  // （那是 Release 权威，不在这里）；它不该决定这个角色在提示词里被怎么描述。此前没有
  // Visual Profile 的角色走另一条分支：把整个 advancedDetails 摊平当描述，并且**整段丢掉
  // 一致性片段** —— 于是「Identity variation: strict/balanced/creative」这个用户点得到的
  // 控件，对 16 个公开角色里的 15 个逐字节无效，点了等于没点。
  // 标签保持两种，因为它们说的是两件不同的真事：pin 了 Visual Profile 时那段文字是密封
  // 版本化的，确实"锁定"；没 pin 时只是从角色内容现推的描述，叫 locked 就是撒谎。
  const direction = visualDirectionOf(character);
  const identityPrompt = visualProfile
    ? cleanPromptText(visualProfile.identityPrompt, 900)
    : assembleIdentityPrompt(direction.traits).identityPrompt;
  const identityLabel = visualProfile ? "Locked identity" : "Character identity";

  return clampPrompt(
    [
      `High quality in-character portrait photo of ${cleanPromptText(character.name, 120)}`,
      presentation.length ? `Subject: ${presentation.join(", ")}` : null,
      identityPrompt ? `${identityLabel}: ${identityPrompt}` : null,
      direction.anchor ? `Visual identity anchor: ${direction.anchor}` : null,
      direction.stableTraits.length
        ? `Stable visual traits: ${direction.stableTraits.join(", ")}`
        : null,
      consistencyPromptFragment(input.consistencyMode),
      cleanPromptText(character.description, 500)
        ? `Character notes: ${cleanPromptText(character.description, 500)}`
        : null,
      `Requested scene: ${request}`,
      "single coherent subject, face and body matching the character, expressive eyes, natural pose, well-lit visible face, properly exposed, sharp focus, detailed skin and hair, clean photographic composition",
    ]
      .filter(Boolean)
      .join(". "),
    2_000,
  );
}

/**
 * SPEC: 读角色**视觉方向**的规范形状 —— `appearance` 的 `identityAnchor` /
 * `stableTraits` / `faceTraits` / `hairTraits` / `bodyTraits` / `signatureTraits`
 * （后四者可以直接挂在 appearance 上，也可以嵌在 `appearance.structured` 下）。
 * INTENT: 这套字段名不是我发明的 —— `buildEditorialPortraitIdentity`
 * （admin-v2/characters/image-readiness-repair.ts）早就按它构造 Visual Profile 的
 * identityPrompt，并在注释里立了那条边界：「biography, premise, and scene text must
 * never become visual identity」。图片提示词这条路径此前不知道这套形状的存在，于是
 * 退回去摊平整包 `advancedDetails`，把 tone / backstory / firstMessage、甚至
 * `provenance.seedSource: src/lib/…` 发给了图像供应商，还把 2000 字预算吃光。
 * 两条路径现在读同一套字段、用同一套措辞，改一处时另一处要跟。
 * INVARIANT: `signature` 只认 `advancedDetails.signature`，不做「退回整个记录」的兜底 ——
 * 那个兜底正是人设泄进图片提示词的入口。`appearance` 保留兜底：它本来就是外貌记录，
 * 用户向导建的角色把外貌平铺在顶层是合法形状；只排掉 `sourceImage` 这类路径字段。
 */
function visualDirectionOf(character: GenerationPromptCharacter): {
  anchor: string;
  stableTraits: string[];
  traits: IdentityTraits;
} {
  const appearance = isRecord(character.appearance) ? character.appearance : {};
  const structured = isRecord(appearance.structured) ? appearance.structured : {};
  const group = (key: string) =>
    namedGroup(appearance[key] ?? structured[key]);
  return {
    anchor: cleanPromptText(
      typeof appearance.identityAnchor === "string" ? appearance.identityAnchor : "",
      400,
    ),
    stableTraits: (Array.isArray(appearance.stableTraits) ? appearance.stableTraits : [])
      .filter((trait): trait is string => typeof trait === "string")
      .map((trait) => cleanPromptText(trait, 120))
      .filter(Boolean)
      .slice(0, 12),
    traits: {
      face: toTraitRecord(group("faceTraits") ?? visualGroup(character.appearance, "face")),
      hair: toTraitRecord(group("hairTraits") ?? visualGroup(character.appearance, "hair")),
      body: toTraitRecord(group("bodyTraits") ?? visualGroup(character.appearance, "body")),
      signature: toTraitRecord(
        group("signatureTraits")
          ?? namedGroup((isRecord(character.advancedDetails) ? character.advancedDetails : {}).signature),
      ),
      style: toTraitRecord({
        style: character.style ?? "realistic",
        gender: character.gender ?? "female",
        age: String(character.age),
        name: character.name,
      }),
    },
  };
}

/** 规范形状里的 traits 组：只有真的是记录才算数，空记录当作「没有」交给兜底。 */
function namedGroup(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return Object.keys(value).length > 0 ? value : null;
}

function visualGroup(value: Prisma.JsonValue, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const direct = value[key];
  if (isRecord(direct)) return direct;
  return Object.fromEntries(
    Object.entries(value).filter(
      ([childKey, child]) =>
        childKey !== "sourceImage" &&
        !["identityAnchor", "stableTraits", "referenceDirection"].includes(childKey) &&
        ["string", "number", "boolean"].includes(typeof child),
    ),
  );
}

// 措辞不再提"locked identity" —— 同一段文字现在也服务于没有 pin 身份的角色，说"locked"就是撒谎。
function consistencyPromptFragment(mode: "balanced" | "strict" | "creative") {
  if (mode === "strict") {
    return "Identity consistency: strict; preserve the same face, hairstyle, eye color, body type, and signature traits described above";
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

export function cleanPromptText(value: string | null | undefined, max = 2_000) {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return clampPrompt(cleaned, max);
}

export function clampPrompt(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 3).trimEnd()}...`;
}
