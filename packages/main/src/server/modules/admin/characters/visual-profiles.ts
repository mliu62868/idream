// SPEC: Visual Passport 编辑器（P2 Task 8）—— 角色视觉身份档案（CharacterVisualProfile）的
//       版本列表 + 铸造新 active 版本，供 OfficialDetailPage 内嵌的 VisualPassportPanel 使用。
// INTENT: 不复用 ourdream/service.ts 的 createActiveCharacterVisualProfileVersion /
//         characterVisualProfileCreateData 作为创建入口 —— 二者都通过 buildCharacterIdentityPrompt
//         从角色的 name/age/description/gender/style/appearance/advancedDetails 重新派生
//         identityPrompt，并把 negativeIdentityPrompt 写死成同一句泛化文案，不接受显式覆盖；
//         而本编辑器的目的恰恰是让运营直接编辑 identityPrompt/negativeIdentityPrompt/traits/style/seed。
//         因此本文件在自己的事务里镜像同样的 archive-prior-active + version+1 模式（写法参照
//         ourdream/service.ts:1572-1588 与 setMediaAsCharacterImage/addMediaToIdentity 里显式
//         carry-forward 未变字段的方式），仅在 create data 上覆盖运营提交的字段。
// INVARIANTS:
//   - 读用 content.read（与同一 content/characters 资源下的 getContentCharacter 一致）；
//     写用 content.official.write（与 official.ts 编辑角色视觉身份用的是同一把权限，
//     且本面板挂载于全程以 content.official.write 门控的 OfficialDetailPage 内，保持一致）。
//   - POST 要求 reason.trim().length>=3（zod）且 confirmation===`${characterId}:visual-profile`。
//   - 锚点/参考图池（anchorAssetIds/referenceAssetIds）本编辑器只读继承自当前 active（或角色
//     imageAssetId 兜底），不在这里编辑 —— 池编辑属 P3 素材联动范畴。
//   - archive 旧 active 与创建新 active 必须在同一事务内完成。
// EXAMPLE: GET .../visual-profiles → { items: [...] } version desc；
//          POST { identityPrompt, reason, confirmation } → 铸 v(prev+1) active，旧 active → archived。
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import {
  actorWithPermission,
  jsonBody,
  toInputJson,
  writeAudit,
} from "@/server/modules/admin/shared/legacy-primitives";
import {
  IDENTITY_ASSEMBLER_VERSION,
  assembleIdentityPrompt,
  toTraitRecord,
  traitsHashOf,
  type IdentityTraits,
} from "@/server/modules/ourdream/identity-assembler";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";

const styleEnum = z.enum(["realistic", "anime", "hybrid", "other"]);
const traitsRecordSchema = z.record(z.string(), z.unknown());

const createVisualProfileSchema = z.object({
  // 缺省时由 traits 派生（source: "derived"）；显式给出则原样存 + 标记 manual —— 运营意志优先，
  // 修正漂移的机制是标记而非禁止（见 identity-assembler.ts SPEC）。
  identityPrompt: z.string().trim().min(1).max(2_000).optional(),
  negativeIdentityPrompt: z.string().trim().max(2_000).optional(),
  style: styleEnum.optional(),
  defaultSeed: z.string().trim().max(200).optional(),
  faceTraits: traitsRecordSchema.optional(),
  hairTraits: traitsRecordSchema.optional(),
  bodyTraits: traitsRecordSchema.optional(),
  signatureTraits: traitsRecordSchema.optional(),
  styleTraits: traitsRecordSchema.optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(200),
});

// 注：faceTraits/hairTraits/bodyTraits/signatureTraits/styleTraits 额外纳入 select ——
// 面板要求"当前 active 的 traits 只读 JSON 视图"，而这些字段正是 traits 本体。
// adapterRefs 只用于服务端计算 identitySource/identityStale，响应前会被剥离——
// 面板不展示 LoRA/adapter 之类的生成模型接线细节，只展示派生出的只读徽标。
const visualProfileSelect = {
  id: true,
  version: true,
  status: true,
  style: true,
  identityPrompt: true,
  negativeIdentityPrompt: true,
  faceTraits: true,
  hairTraits: true,
  bodyTraits: true,
  signatureTraits: true,
  styleTraits: true,
  defaultSeed: true,
  anchorAssetIds: true,
  referenceAssetIds: true,
  qualityScore: true,
  consistencyScore: true,
  createdFrom: true,
  createdAt: true,
  adapterRefs: true,
} as const;

type SelectedVisualProfile = {
  faceTraits: unknown;
  hairTraits: unknown;
  bodyTraits: unknown;
  signatureTraits: unknown;
  styleTraits: unknown;
  adapterRefs: unknown;
};

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function visualProfileConfirmation(characterId: string): string {
  return `${characterId}:visual-profile`;
}

function currentTraitsOf(profile: SelectedVisualProfile): IdentityTraits {
  return {
    face: toTraitRecord(profile.faceTraits),
    hair: toTraitRecord(profile.hairTraits),
    body: toTraitRecord(profile.bodyTraits),
    signature: toTraitRecord(profile.signatureTraits),
    style: toTraitRecord(profile.styleTraits),
  };
}

// adapterRefs.identity 缺失（历史行 / 未接线）视为 manual，恒不 stale——保守默认，不倒扣历史数据。
function identityDisplayFields<T extends SelectedVisualProfile>(
  profile: T,
): Omit<T, "adapterRefs"> & {
  identitySource: "derived" | "manual";
  identityStale: boolean;
} {
  const { adapterRefs, ...rest } = profile;
  const identity =
    adapterRefs && typeof adapterRefs === "object" && "identity" in adapterRefs
      ? (adapterRefs as { identity?: unknown }).identity
      : undefined;
  const source =
    identity &&
    typeof identity === "object" &&
    (identity as { source?: unknown }).source === "derived"
      ? "derived"
      : "manual";
  const storedHash =
    identity &&
    typeof identity === "object" &&
    typeof (identity as { traitsHash?: unknown }).traitsHash === "string"
      ? (identity as { traitsHash: string }).traitsHash
      : undefined;
  const identityStale =
    source === "derived" && storedHash !== undefined
      ? traitsHashOf(currentTraitsOf(profile)) !== storedHash
      : false;
  return { ...rest, identitySource: source, identityStale };
}

// GET /api/v1/admin/content/characters/{id}/visual-profiles
export async function listCharacterVisualProfiles(
  request: Request,
  characterId: string,
): Promise<Response> {
  await actorWithPermission(request, "content.read");

  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: { id: true },
  });
  if (!character) throw Errors.notFound("Character not found");

  const items = await prisma.characterVisualProfile.findMany({
    where: { characterId },
    orderBy: { version: "desc" },
    select: visualProfileSelect,
  });
  return ok({ items: items.map((item) => identityDisplayFields(item)) });
}

// POST /api/v1/admin/content/characters/{id}/visual-profiles
export async function createCharacterVisualProfile(
  request: Request,
  characterId: string,
): Promise<Response> {
  const actor = await actorWithPermission(request, "content.official.write");
  const body = createVisualProfileSchema.parse(await jsonBody(request));
  if (body.confirmation !== visualProfileConfirmation(characterId)) {
    throw Errors.badRequest("Confirmation did not match visual profile target");
  }

  const character = await prisma.character.findUnique({
    where: { id: characterId },
    select: { id: true, imageAssetId: true },
  });
  if (!character) throw Errors.notFound("Character not found");

  const created = await prisma.$transaction(async (tx) => {
    const active = await tx.characterVisualProfile.findFirst({
      where: { characterId, status: "active" },
      orderBy: { version: "desc" },
    });
    if (active) {
      await tx.characterVisualProfile.updateMany({
        where: { characterId, status: "active" },
        data: { status: "archived" },
      });
    }
    // 池只读继承：沿用当前 active 的锚点/参考图；首个版本时兜底角色主图。
    const anchorAssetIds = active
      ? jsonStringArray(active.anchorAssetIds)
      : character.imageAssetId
        ? [character.imageAssetId]
        : [];
    const referenceAssetIds = active
      ? jsonStringArray(active.referenceAssetIds)
      : [];
    const version = (active?.version ?? 0) + 1;

    const faceTraits = body.faceTraits ?? active?.faceTraits ?? {};
    const hairTraits = body.hairTraits ?? active?.hairTraits ?? {};
    const bodyTraits = body.bodyTraits ?? active?.bodyTraits ?? {};
    const signatureTraits =
      body.signatureTraits ?? active?.signatureTraits ?? {};
    const styleTraits = body.styleTraits ?? active?.styleTraits ?? {};

    // identityPrompt 显式给出 → 原样存 + manual（运营意志优先，不强制重派生）；
    // 缺省 → 由当前 traits（body 覆盖，缺省继承 active）派生 + derived，traitsHash 一并落盘
    // 供后续读时做 staleness 自检（见 identityDisplayFields）。
    const traits: IdentityTraits = {
      face: toTraitRecord(faceTraits),
      hair: toTraitRecord(hairTraits),
      body: toTraitRecord(bodyTraits),
      signature: toTraitRecord(signatureTraits),
      style: toTraitRecord(styleTraits),
    };
    const derived = assembleIdentityPrompt(traits);
    const identityPrompt = body.identityPrompt ?? derived.identityPrompt;
    const negativeIdentityPrompt =
      body.negativeIdentityPrompt ?? active?.negativeIdentityPrompt ?? null;
    const style = body.style ?? active?.style ?? "realistic";
    const source = body.identityPrompt ? "manual" : "derived";
    const traitsHash = body.identityPrompt
      ? traitsHashOf(traits)
      : derived.traitsHash;

    return tx.characterVisualProfile.create({
      data: {
        characterId,
        version,
        status: "active",
        style,
        identityPrompt,
        negativeIdentityPrompt,
        faceTraits: toInputJson(faceTraits),
        hairTraits: toInputJson(hairTraits),
        bodyTraits: toInputJson(bodyTraits),
        signatureTraits: toInputJson(signatureTraits),
        styleTraits: toInputJson(styleTraits),
        anchorAssetIds: toInputJson(anchorAssetIds),
        referenceAssetIds: toInputJson(referenceAssetIds),
        defaultSeed: body.defaultSeed ?? active?.defaultSeed ?? null,
        adapterRefs: toInputJson({
          identity: {
            traitsHash,
            assemblerVersion: IDENTITY_ASSEMBLER_VERSION,
            source,
          },
        }),
        immutableHash: characterVisualProfileSnapshotHash({
          version,
          style,
          identityPrompt,
          negativeIdentityPrompt,
          faceTraits: toInputJson(faceTraits),
          hairTraits: toInputJson(hairTraits),
          bodyTraits: toInputJson(bodyTraits),
          signatureTraits: toInputJson(signatureTraits),
          styleTraits: toInputJson(styleTraits),
          anchorAssetIds,
          referenceAssetIds,
        }),
        evidenceState: "candidate",
        createdFrom: "admin_passport_edit",
      },
      select: visualProfileSelect,
    });
  });

  await writeAudit(request, actor, {
    action: "content.visual_profile.create",
    targetType: "character",
    targetId: characterId,
    reason: body.reason,
    after: {
      visualProfileId: created.id,
      version: created.version,
      status: created.status,
    },
  });

  return ok({ item: identityDisplayFields(created) });
}
