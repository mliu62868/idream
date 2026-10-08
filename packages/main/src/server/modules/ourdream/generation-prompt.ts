import type { Prisma } from "@prisma/client";
import { CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT } from "@idream/shared/admin";
import { isRecord } from "@/server/lib/request-json";
import { characterVisualProfileSnapshotHash } from "../admin-v2/characters/release-snapshot";
import { pruneUndefined } from "./json-values";
import type {
  GenerationPromptCharacter,
  GenerationVisualProfile,
} from "./generation-character-authority";
import {
  assembleIdentityPrompt,
  IDENTITY_ASSEMBLER_VERSION,
  toTraitRecord,
  traitsHashOf,
  type IdentityTraits,
} from "./identity-assembler";
import type {
  GenerationCreateBody,
  GenerationSource,
} from "./generation-request-schema";

const MUTABLE_CLOTHING_TRAIT = /(?:\b(?:jacket|hoodie|coat|shirt|t-?shirt|tank top|crop(?:ped)? top|off-shoulder top|sweater|robe|dress|skirt|shorts|jeans|pants|trousers|blouse|lingerie|bra|panties|underwear|swimsuit|bikini)\b|(?:外套|上衣|衬衫|毛衣|长袍|睡袍|裙|短裤|牛仔裤|内衣|泳装))/i;

/**
 * SPEC: Chat Agent supplies both new-image and edit directions; Main freezes
 * them under the Turn action identity. Neither owns Character identity.
 * Main removes accidental age / hair-colour / eye-colour / skin-tone claims
 * before the direction enters prompt compilation; the pinned Visual Profile
 * and reference set remain the only identity authority.
 */
export function sanitizeChatImageDirection(
  value: string,
  options: { rejectTruncation?: boolean } = {},
): string {
  return chatDirectionText(value, 1_200, options.rejectTruncation)
    .replace(
      /\b(?:young\s+)?(?:woman|man|person)\s+(?:around|aged?)\s+\d{1,3}\s+years?\s+old\b/gi,
      "adult character",
    )
    .replace(
      /\b\d{1,3}[\s-]year[\s-]old\s+(?:woman|man|person)\b/gi,
      "adult character",
    )
    .replace(/\byoung\s+(?:woman|man|person)\b/gi, "adult character")
    .replace(/\b(?:mature[\s-]looking|elderly|teen(?:age)?|adolescent)\s+(?:woman|man|person)\b/gi, "adult character")
    .replace(
      /\b(?:jet[\s-]?black|golden[\s-]?blonde|platinum|blonde?|brunette|black|brown|dark|red|auburn|ginger|silver|white|grey|gray|blue|green|pink|purple)\s+(?=(?:(?:long|short|shoulder[\s-]length|wavy|curly|straight|loose|tousled|damp)\s+){0,3}hair\b)/gi,
      "",
    )
    .replace(
      /\b(?:hazel[\s-]?brown|hazel|amber|blue|green|brown|black|grey|gray|violet)\s+eyes?\b/gi,
      "eyes",
    )
    .replace(
      /\b(?:very\s+fair|fair|porcelain|olive|tan|tanned|dark|brown|black|white|pale)\s+skin\b/gi,
      "skin",
    )
    .replace(/\b(?:oval|round|heart[\s-]shaped|angular|square)\s+face\b/gi, "face")
    .replace(
      /\b(?:(?:very\s+)?(?:long|short|shoulder[\s-]length|waist[\s-]length|wavy|curly|straight|coily|thick|fine)\s+){1,4}hair\b/gi,
      "hair",
    )
    .replace(
      /\b(?:petite|slim|slender|curvy|voluptuous|athletic|muscular|stocky|tall|short)(?:\s+(?:hourglass|pear[\s-]shaped|broad[\s-]shouldered))?\s+(?:body|figure|build|proportions?)\b/gi,
      "",
    )
    .replace(/\b(?:hourglass|pear[\s-]shaped)\s+(?:body|figure|proportions?)\b/gi, "")
    .replace(
      /\bwith\s+(?:an?\s+)?(?:different|small|large|button|aquiline|straight|wide|narrow)\s+nose(?:\s+and\s+(?:full|thin|plump|wide|narrow)\s+lips?)?/gi,
      "",
    )
    .replace(
      /\b(?:different|small|large|button|aquiline|straight|wide|narrow|full|thin|plump)\s+(?:nose|lips?)\b/gi,
      "",
    )
    .replace(/,\s*,+/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

export function compileChatImagePrompt(
  agentScene: string,
  requestedNudity: "unspecified" | "none" | "full",
  options: { rejectTruncation?: boolean } = {},
): string {
  options = { rejectTruncation: true, ...options };
  let scene = sanitizeChatImageDirection(agentScene || "candid in-character photo", options);
  if (requestedNudity === "full") {
    scene = scene
      .replace(
        /\b(?:fully\s+clothed(?:\s+in)?|wearing|dressed\s+in)\s+(?:(?:a|an|the)\s+)?(?:[\w-]+\s+){0,3}(?:robe|dress|shirt|top|lingerie|bra|panties|underwear|swimsuit|bikini|clothes|clothing)\b/gi,
        "",
      )
      .replace(/\b(?:silk|satin|lace)\s+(?:robe|dress|lingerie|underwear)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return chatDirectionText(
      `Adult scene requirement: depict the adult character fully nude, with no clothing or robe. Requested scene: ${scene}`,
      900,
      options.rejectTruncation,
    );
  }
  if (requestedNudity === "none") {
    scene = scene
      .replace(/\b(?:fully\s+)?(?:nude|naked|unclothed)\b/gi, "")
      .replace(/\b(?:without (?:any )?clothes|no clothes)\b/gi, "")
      .replace(/(?:裸照|裸体|全裸|赤裸|一丝不挂|脱光)/gu, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return chatDirectionText(
      `Wardrobe requirement: keep the adult character clothed; no nudity. Requested scene: ${scene}`,
      900,
      options.rejectTruncation,
    );
  }
  return chatDirectionText(scene || "candid in-character photo", 900, options.rejectTruncation);
}

function requirePromptBudget(text: string, max: number): string {
  if (text.length > max) throw new RangeError(`The complete image facts exceed the ${max}-character generation budget; shorten the scene without dropping required facts`);
  return text;
}

function chatDirectionText(value: string, max: number, rejectTruncation = false): string {
  // Validate the complete normalized text, including structural wardrobe
  // prefixes. Truncating first can silently drop a user's final constraint.
  const normalized = cleanPromptText(value, Infinity);
  if (rejectTruncation && normalized.length > max) {
    throw new RangeError(`Image instructions exceed the ${max}-character generation direction budget. Shorten the request while retaining all required facts and changes.`);
  }
  return clampPrompt(normalized, max);
}

// SPEC: 把一次生成请求（角色身份 + 用户意图 + 预设/Look 片段）编译成投给 runner 的
// prompt / negativePrompt / momentSpec。
//
// INTENT: prompt 拼装是纯函数 —— 没有库、没有事务、没有 HTTP。把它和写库的那段分开，
// 是为了让"这段文字为什么长这样"能被单独读懂、单独改，而不必先读懂 447 行的下单事务。

function isChatContinuitySource(sourceType: string | undefined) {
  return sourceType === "chat_image" || sourceType === "chat_handoff" || sourceType === "chat_video";
}

export function buildGenerationPrompt(input: {
  mode: "image" | "video";
  character: GenerationPromptCharacter | null;
  visualProfile: GenerationVisualProfile | null;
  consistencyMode: "balanced" | "strict" | "creative";
  userPrompt?: string;
  presetFragment: string;
  lookFragment: string;
  sourceType?: string;
  sourceImageAssetId?: string;
}) {
  const chat = isChatContinuitySource(input.sourceType);
  const look = cleanPromptText(input.lookFragment, Infinity);
  // The public request schema accepts 2000-character directions. Only Chat has
  // a published 900/2000 execution budget; Look does not change that authority.
  const userPrompt = chat
    ? requirePromptBudget(input.userPrompt?.trim() ?? "", 900)
    : cleanPromptText(input.userPrompt, Infinity);
  const preset = cleanPromptText(input.presetFragment, Infinity);
  const base =
    input.mode === "image"
      ? buildImageGenerationPrompt({
          character: input.character,
          visualProfile: input.visualProfile,
          consistencyMode: input.consistencyMode,
          userPrompt,
          sourceType: input.sourceType,
          sourceImageAssetId: input.sourceImageAssetId,
          lookFragment: look,
          presetFragment: preset,
        })
      : buildVideoGenerationPrompt(input.character, userPrompt);
  const compiled = [base, input.mode === "video" && look ? `Active look: ${look}` : null, input.mode === "video" && preset ? `Scene details: ${preset}` : null]
    .filter(Boolean).join(". ");
  if (chat && compiled.length > 2_000) throw new RangeError("The complete Chat image facts and pinned identity exceed the 2000-character generation budget");
  return compiled;
}

function withOptionalImagePolish(mandatory: string, polish: string) {
  // 2000 is a packing target for optional polish, not a provider limit. Ordinary
  // Generator facts survive beyond it; Chat's explicit budget is checked above.
  return mandatory.length + polish.length + 2 <= 2_000
    ? `${mandatory}. ${polish}`
    : mandatory;
}

function buildImageGenerationPrompt(input: {
  character: GenerationPromptCharacter | null;
  visualProfile: GenerationVisualProfile | null;
  consistencyMode: "balanced" | "strict" | "creative";
  userPrompt: string;
  sourceType?: string;
  sourceImageAssetId?: string;
  lookFragment: string;
  presetFragment: string;
}) {
  const request =
    input.userPrompt ||
    (isChatContinuitySource(input.sourceType)
      ? "candid in-character portrait shared from the current moment"
      : "natural in-character portrait");

  // The source owns the scene being edited. Reusing the new-portrait template
  // made the identity portrait compete with it for framing and background.
  if (input.sourceImageAssetId) {
    return [
      "Edit the supplied source image; do not create a new portrait",
      "Preserve its composition, framing, camera angle, pose, background and lighting unless the requested edit explicitly changes them",
      ...(input.character ? [
        "Any separate identity reference identifies the same adult person only; do not copy that reference's crop, pose, clothes or background",
        "Preserve the source subject's face, age, hair and body proportions",
      ] : ["Preserve the source image's subjects, objects and visual details; do not add a person or other subject unless explicitly requested"]),
      `Apply only this requested edit: ${request}`,
      input.lookFragment ? `Active look: ${input.lookFragment}` : null,
      input.presetFragment ? `Scene details: ${input.presetFragment}` : null,
    ].filter(Boolean).join(". ");
  }

  if (!input.character) {
    // Freeplay can depict objects or scenery; a portrait finish invents a human subject.
    return withOptionalImagePolish(
      [
        "High quality original image",
        `Requested scene: ${request}`,
        input.lookFragment ? `Active look: ${input.lookFragment}` : null,
        input.presetFragment ? `Scene details: ${input.presetFragment}` : null,
      ].filter(Boolean).join(". "),
      "coherent scene, properly exposed, sharp focus, detailed textures, clean composition",
    );
  }

  const character = input.character;
  const visualProfile = input.visualProfile;
  const lookIdentity = input.lookFragment && visualProfile
    ? sealedLookIdentity(visualProfile, character.id)
    : null;
  const presentation = [
    "adult",
    cleanPromptText(lookIdentity?.gender ?? character.gender, 80),
    cleanPromptText(lookIdentity?.style ?? character.style, 80),
  ].filter(Boolean);
  // INTENT: 一个角色只有一种描述法。Release 有没有 pin 身份，决定的是**走不走参考图路由**
  // （那是 Release 权威，不在这里）；它不该决定这个角色在提示词里被怎么描述。此前没有
  // Visual Profile 的角色走另一条分支：把整个 advancedDetails 摊平当描述，并且**整段丢掉
  // 一致性片段** —— 于是「Identity variation: strict/balanced/creative」这个用户点得到的
  // 控件，对 16 个公开角色里的 15 个逐字节无效，点了等于没点。
  // 标签保持两种，因为它们说的是两件不同的真事：pin 了 Visual Profile 时那段文字是密封
  // 版本化的，确实"锁定"；没 pin 时只是从角色内容现推的描述，叫 locked 就是撒谎。
  const direction = lookIdentity
    ? { anchor: CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT, stableTraits: [] }
    : visualProfile && identityReplacesAppearanceText(visualProfile)
      ? { anchor: "", stableTraits: [] }
      : visualDirectionOf(character);
  const identityPrompt = lookIdentity?.identityPrompt ?? (visualProfile
    ? cleanPromptText(visualProfile.identityPrompt, Infinity)
    : assembleIdentityPrompt(visualDirectionOf(character).traits).identityPrompt);
  const identityLabel = visualProfile ? "Locked identity" : "Character identity";

  const mandatory = [
      `High quality in-character portrait photo of ${cleanPromptText(lookIdentity?.name ?? character.name, 120)}`,
      presentation.length ? `Subject: ${presentation.join(", ")}` : null,
      // Preserve sealed stable facts. A guarded derived cache is projected above;
      // manual or unknown identities keep their original text and receive the
      // current Look/Moment priority rules without rewriting sealed storage.
      ...(input.lookFragment ? [
        "Active look and Requested scene override baseline clothing, pose and background in identity descriptions and reference images",
        "Preserve the same adult face, age, hair, eye color, skin and body proportions",
        "Scene details apply only where they do not conflict with the Active look or Requested scene",
      ] : []),
      identityPrompt ? `${identityLabel}: ${identityPrompt}` : null,
      direction.anchor ? `Visual identity anchor: ${direction.anchor}` : null,
      direction.stableTraits.length
        ? `Stable visual traits: ${direction.stableTraits.join(", ")}`
        : null,
      consistencyPromptFragment(input.consistencyMode),
      // Biography describes the Character's premise, not this image. Keeping
      // its setting here can override the requested scene (for example, a
      // yacht biography competing with a conservatory). Identity comes from
      // the pinned visual facts above; the moment comes from the request.
      `Requested scene: ${request}`,
      input.lookFragment ? `Active look: ${input.lookFragment}` : null,
      input.presetFragment ? `Scene details: ${input.presetFragment}` : null,
    ]
      .filter(Boolean)
      .join(". ");
  const finish = "single coherent subject, face and body matching the character, expressive eyes, natural pose, well-lit visible face, properly exposed, sharp focus, detailed skin and hair, clean photographic composition";
  return withOptionalImagePolish(mandatory, finish);
}

/**
 * SPEC: true when an operator wrote this identity (Visual identity "change look" or the
 * identity form). Its text then replaces the creation-time appearance text, which is
 * frozen once an identity exists and may still describe the previous look.
 * INTENT: derived identities (first portrait bootstrap, editorial, create preview) only
 * say "match the portrait"; for them the frozen appearance text is the only written
 * description, so it must stay in the prompt.
 */
function identityReplacesAppearanceText(profile: GenerationVisualProfile) {
  const source = profile.createdFrom;
  return typeof source === "string" &&
    (source === "admin_passport_edit" || source.startsWith("identity_calibration:"));
}

/**
 * A derived identity cache may include its original scene in face.prompt and
 * premise fields. Only a new portrait with a Look projects sealed stable facts;
 * manual/unknown/stale profiles retain their original prompt. JSONB may reorder
 * capped v1 prompt lines, so provenance and canonical hashes decide derivation,
 * not raw prompt byte equality. The full canonical portrait protects facial
 * geometry and marks that were described only in that scene-shaped container.
 *
 * Anchor candidates do not prove dispatch authority. The caller still locks and
 * validates the exact reference revision and available media before admission.
 */
function sealedLookIdentity(profile: GenerationVisualProfile, characterId: string) {
  const adapter = isRecord(profile.adapterRefs) ? profile.adapterRefs : {};
  const identity = isRecord(adapter.identity) ? adapter.identity : {};
  if (identity.source !== "derived" || identity.assemblerVersion !== IDENTITY_ASSEMBLER_VERSION ||
      profile.characterId !== characterId || !Number.isInteger(profile.version) || profile.version < 1 ||
      !Array.isArray(profile.anchorAssetIds) || !profile.anchorAssetIds.some(assetId => typeof assetId === "string" && assetId.trim())) return null;
  const traits: IdentityTraits = {
    face: toTraitRecord(profile.faceTraits), hair: toTraitRecord(profile.hairTraits),
    body: toTraitRecord(profile.bodyTraits), signature: toTraitRecord(profile.signatureTraits),
    style: toTraitRecord(profile.styleTraits),
  };
  if (identity.traitsHash !== traitsHashOf(traits) ||
      !profile.immutableHash || characterVisualProfileSnapshotHash(profile) !== profile.immutableHash) return null;

  const without = (record: Record<string, string>, excluded: readonly string[]) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !excluded.includes(key)));
  const face = without(traits.face, ["prompt"]);
  const signature = without(traits.signature, ["description", "firstMessage", "detailsMarkdown"]);
  const { name, age, gender, style } = traits.style;
  const ageNumber = Number(age);
  if (![name, age, gender, style].every(value => typeof value === "string" && value.trim()) ||
      !Number.isInteger(ageNumber) || ageNumber < 18 ||
      ![face, traits.hair, traits.body].every(group => Object.values(group).some(value => value.trim()))) return null;

  // Keep every unknown non-premise trait, including full hair/body descriptions.
  // Preserve complete stable facts: Chat rejects assembled overflow while the
  // ordinary Generator keeps them instead of applying the v1 cache's caps.
  const details = [
    ["Appearance face", face], ["Appearance hair", traits.hair],
    ["Appearance body", traits.body], ["Character detail signature", signature],
  ] as const;
  const identityPrompt = [
    `${cleanPromptText(name, Infinity)}, adult ${cleanPromptText(gender, Infinity)} companion`,
    `${cleanPromptText(age, Infinity)} years old`, `${cleanPromptText(style, Infinity)} visual style`,
    ...details.flatMap(([label, group]) => Object.entries(group)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, value]) => `${label} ${cleanPromptText(key, Infinity)}: ${cleanPromptText(value, Infinity)}`)),
  ].join("; ");
  return { name, gender, style, identityPrompt };
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
      Infinity,
    ),
    // INTENT: stableTraits 的历史官方数据混进了卡面服装。服装是 Moment/Look，
    // 不是身份；继续把它当 identity 会直接与换装、裸体等用户意图冲突。
    stableTraits: (Array.isArray(appearance.stableTraits) ? appearance.stableTraits : [])
      .filter((trait): trait is string => typeof trait === "string")
      .map((trait) => cleanPromptText(trait, Infinity))
      .filter(Boolean)
      .filter((trait) => !MUTABLE_CLOTHING_TRAIT.test(trait)),
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
  visualProfile: Pick<GenerationVisualProfile, "negativeIdentityPrompt"> | null,
) {
  const cleanBase = cleanPromptText(base, Infinity);
  const identityNegative = cleanPromptText(visualProfile?.negativeIdentityPrompt, Infinity);
  const seen = new Set<string>();
  return [cleanBase, identityNegative].filter(Boolean).join(", ").split(",").map(term => term.trim()).filter(term => {
    const key = term.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(", ") || null;
}

export function buildMomentSpec(
  body: GenerationCreateBody,
  source?: GenerationSource,
  requestFingerprint?: string,
) {
  const controls = body.controls as Record<string, unknown>;
  const rawInput = cleanPromptText(body.prompt, 2_000) || "A natural in-character moment";
  const continuitySources: string[] = [];
  if (isChatContinuitySource(source?.sourceType)) continuitySources.push("chat_context");
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
      isChatContinuitySource(source?.sourceType) ? "continue" : "unspecified",
    camera: typeof controls.camera === "string" ? controls.camera : undefined,
    lighting: typeof controls.lighting === "string" ? controls.lighting : undefined,
    styleDelta: typeof controls.styleDelta === "string" ? controls.styleDelta : undefined,
    // Input provenance is not semantic understanding or pixel verification.
    verification: "direct_input",
    continuitySources,
    createdAt: new Date().toISOString(),
  });
}

function buildVideoGenerationPrompt(
  character: GenerationPromptCharacter | null,
  userPrompt: string,
) {
  const subject = character?.name ? cleanPromptText(character.name, 120) : "an original companion";
  return userPrompt || `Video generation for ${subject}`;
}

export function defaultImageNegativePrompt(templateNegative: string | null, sourceType?: string) {
  const base =
    cleanPromptText(templateNegative, Infinity) ||
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
