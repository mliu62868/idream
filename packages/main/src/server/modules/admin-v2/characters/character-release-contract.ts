import {
  characterReleaseSchema,
  parseCharacterReleaseAssetManifest,
  type CharacterRelease as CharacterReleaseResponse,
  type CharacterReleaseAssetSlot,
} from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";

// SPEC: release placement slot → 生产用途，全仓唯一一份。
// INTENT: 这张三行表此前在四个文件里各存一份对象字面量：release-executor 用它当发布闸的判据
// （「这张图的生产批次用途对不对」），workspace / renderer-preview / production-journey 用它把
// manifest 投影成图池。四份一致纯属巧合——改一处不改另一处，运营看到的图池就会与发布闸给出
// 不同答案，而类型系统看不见四个独立的字面量。
// INVARIANT: `satisfies Record<CharacterReleaseAssetSlot, …>` 让「shared 新增一个槽位而这里没跟」
// 变成编译错误。
const RELEASE_PURPOSE_BY_SLOT = {
  character_avatar: "character_cover",
  character_hero: "character_hero",
  character_chat: "character_chat",
} as const satisfies Readonly<Record<CharacterReleaseAssetSlot, string>>;

export type CharacterReleaseAssetPurpose =
  (typeof RELEASE_PURPOSE_BY_SLOT)[CharacterReleaseAssetSlot];

export function characterReleaseAssetPurpose(
  slotKey: string,
): CharacterReleaseAssetPurpose | null {
  return slotKey in RELEASE_PURPOSE_BY_SLOT
    ? RELEASE_PURPOSE_BY_SLOT[slotKey as CharacterReleaseAssetSlot]
    : null;
}

// SPEC: 一个用途恰好对应一个 placement 才算数；重复或缺失都当作「这个用途没有图」。
// INTENT: 预览链专用（workspace 预览投影 + renderer preview token 校验），两处此前是逐字相同的
// 两份实现。这里从严是因为 renderer 要按 token 里的 assetPack 验签发内容，歧义必须 fail-closed。
// production-journey 的完成度统计**故意**用另一条更宽的规则（见那边注释），不要合并。
export function characterReleaseExactAssetPackByPurpose(
  release: unknown,
): Partial<Record<CharacterReleaseAssetPurpose, string>> {
  const purposes = characterReleasePlacements(release).flatMap((placement) => {
    const purpose = characterReleaseAssetPurpose(placement.slotKey);
    return purpose ? [[purpose, placement.assetId] as const] : [];
  });
  return Object.fromEntries(
    purposes.filter(([purpose]) =>
      purposes.filter(([candidate]) => candidate === purpose).length === 1
    ),
  );
}

const STRICT_RELEASE_PROVENANCE_SCHEMA =
  "character-release-generation-provenance-v2";
// SPEC: 当前发布策略版本 —— 证据按它判新旧，升版即让旧 Release 的合格证明失效。
// INTENT: 住在发布契约这一层，是因为它同时被三方要用：release-validation 签发证据、
// 本文件的严格发布契约验收证据、ourdream 的公开目录只认这一版的证据。此前三处各存一份
// 字面量（STRICT_RELEASE_POLICY_VERSION / MODERN_CHARACTER_RELEASE_POLICY_VERSION），
// 升版时漏改任何一处都是静默放行旧证据。release-validation 依赖本文件，所以常量只能沉在
// 这一侧；那边保留同名再导出，调用方的 import 路径不变。
export const CHARACTER_RELEASE_POLICY_VERSION = "character-release-policy-v2";
const STRICT_RELEASE_SLOTS = [
  "character_avatar",
  "character_hero",
  "character_chat",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function versionValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return stringValue(value, "unavailable");
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isoDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : value;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function strictVersionValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(value);
  }
  const string = nullableString(value);
  return string === "unavailable" ? null : string;
}

function hasStrictReleaseResponseAuthority(
  release: CharacterReleaseResponse,
) {
  if (release.legacy) return true;
  const placements = release.releaseOwnedPlacements;
  const slotKeys = placements.map((placement) => placement.slotKey);
  const assetIds = placements.map((placement) => placement.assetId);
  const avatar = placements.find(
    (placement) => placement.slotKey === "character_avatar",
  );
  return release.policyVersion === CHARACTER_RELEASE_POLICY_VERSION &&
    placements.length === STRICT_RELEASE_SLOTS.length &&
    new Set(slotKeys).size === STRICT_RELEASE_SLOTS.length &&
    STRICT_RELEASE_SLOTS.every((slotKey) => slotKeys.includes(slotKey)) &&
    new Set(assetIds).size === STRICT_RELEASE_SLOTS.length &&
    avatar?.assetId === release.visualIdentity.anchorAssetId &&
    ![
      release.visualIdentity.visualProfileId,
      release.visualIdentity.anchorAssetId,
      release.visualIdentity.referenceSetRevisionId,
      release.generationRoute.generationProfileKey,
      release.generationRoute.generationProfileVersion,
      release.generationRoute.workflowKey,
      release.generationRoute.workflowVersion,
    ].includes("unavailable");
}

function strictReleaseProjection(
  release: Record<string, unknown>,
  provenance: Record<string, unknown>,
) {
  const manifest = parseCharacterReleaseAssetManifest(
    release.releasePlacementManifest,
  );
  const route = record(provenance.requiredReleaseRoute);
  const visualProfileId = nullableString(release.visualProfileId);
  const visualProfileVersion = positiveInteger(release.visualProfileVersion);
  const referenceSetRevisionId = nullableString(release.referenceSetRevisionId);
  const generationProfileKey = nullableString(route.generationProfileKey);
  const generationProfileVersion = strictVersionValue(
    route.generationProfileVersion,
  );
  const workflowKey = nullableString(route.workflowKey);
  const workflowVersion = strictVersionValue(route.workflowVersion);
  const avatar = manifest?.placements.find(
    (placement) => placement.slotKey === "character_avatar",
  );

  if (
    provenance.schemaVersion !== STRICT_RELEASE_PROVENANCE_SCHEMA ||
    provenance.policyVersion !== CHARACTER_RELEASE_POLICY_VERSION ||
    !manifest ||
    !avatar ||
    !visualProfileId ||
    !visualProfileVersion ||
    !referenceSetRevisionId ||
    !generationProfileKey ||
    !generationProfileVersion ||
    !workflowKey ||
    !workflowVersion
  ) {
    return null;
  }

  return {
    visualIdentity: {
      visualProfileId,
      visualProfileVersion,
      anchorAssetId: avatar.assetId,
      referenceSetRevisionId,
    },
    generationRoute: {
      generationProfileKey,
      generationProfileVersion,
      workflowKey,
      workflowVersion,
    },
    releaseOwnedPlacements: manifest.placements.map((placement) => ({
      slotKey: placement.slotKey,
      slotVersion: placement.slotVersion,
      assetId: placement.assetId,
    })),
    policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
  };
}

export function characterReleasePlacements(release: unknown) {
  const source = record(release);
  if (Array.isArray(source.releaseOwnedPlacements)) {
    return source.releaseOwnedPlacements.flatMap((item) => {
      const placement = record(item);
      const slotKey = nullableString(placement.slotKey);
      const assetId = nullableString(placement.assetId);
      if (!slotKey || !assetId) return [];
      return [{
        slotKey,
        slotVersion: typeof placement.slotVersion === "number" && placement.slotVersion > 0
          ? Math.floor(placement.slotVersion)
          : 1,
        assetId,
      }];
    });
  }

  const manifest = record(source.releasePlacementManifest);
  const raw = Array.isArray(source.releasePlacementManifest)
    ? source.releasePlacementManifest
    : Array.isArray(manifest.placements)
      ? manifest.placements
      : [];
  return raw.flatMap((item) => {
    const placement = record(item);
    const slotKey = nullableString(placement.slotKey)
      ?? nullableString(placement.placementId);
    const assetId = nullableString(placement.assetId);
    if (!slotKey || !assetId) return [];
    return [{
      slotKey,
      slotVersion: typeof placement.slotVersion === "number" && placement.slotVersion > 0
        ? Math.floor(placement.slotVersion)
        : 1,
      assetId,
    }];
  });
}

export function characterReleaseContract(value: unknown): CharacterReleaseResponse {
  const existing = characterReleaseSchema.safeParse(value);
  if (existing.success) {
    if (!hasStrictReleaseResponseAuthority(existing.data)) {
      throw Errors.internal(
        "Non-legacy Character Release response is missing strict v2 authority",
        { releaseId: existing.data.id },
      );
    }
    return existing.data;
  }

  const release = record(value);
  if (typeof release.legacy !== "boolean") {
    throw Errors.internal(
      "Character Release is missing its explicit authority kind",
      { releaseId: nullableString(release.id) },
    );
  }
  const provenance = record(release.generationProvenance);
  const legacy = release.legacy === true;
  const strictProjection = legacy
    ? null
    : strictReleaseProjection(release, provenance);
  if (!legacy && !strictProjection) {
    throw Errors.internal(
      "Non-legacy Character Release is missing strict v2 authority",
      { releaseId: nullableString(release.id) },
    );
  }
  const requiredRoute = Object.keys(record(provenance.requiredReleaseRoute)).length > 0
    ? record(provenance.requiredReleaseRoute)
    : provenance;
  const placements = strictProjection?.releaseOwnedPlacements
    ?? characterReleasePlacements(release);

  const projected = characterReleaseSchema.safeParse({
    id: release.id,
    projectId: release.projectId,
    revisionId: release.revisionId,
    characterContentVersionId: release.characterContentVersionId,
    visualIdentity: strictProjection?.visualIdentity ?? {
      visualProfileId: stringValue(release.visualProfileId, "unavailable"),
      visualProfileVersion: typeof release.visualProfileVersion === "number"
        && release.visualProfileVersion > 0
        ? release.visualProfileVersion
        : 1,
      anchorAssetId: placements[0]?.assetId ?? "unavailable",
      referenceSetRevisionId: stringValue(release.referenceSetRevisionId, "unavailable"),
    },
    generationRoute: strictProjection?.generationRoute ?? {
      generationProfileKey: stringValue(requiredRoute.generationProfileKey, "unavailable"),
      generationProfileVersion: versionValue(requiredRoute.generationProfileVersion),
      workflowKey: stringValue(requiredRoute.workflowKey, "unavailable"),
      workflowVersion: versionValue(requiredRoute.workflowVersion),
    },
    releaseOwnedPlacements: placements,
    snapshotHash: release.snapshotHash,
    policyVersion: strictProjection?.policyVersion
      ?? stringValue(provenance.policyVersion, "character-release-policy-v1"),
    legacy,
    status: release.status,
    publishedAt: release.publishedAt === null ? null : isoDate(release.publishedAt),
    supersedesId: nullableString(release.supersedesId),
    rollbackOfReleaseId: nullableString(release.rollbackOfReleaseId),
    version: release.version,
    createdAt: isoDate(release.createdAt),
    updatedAt: isoDate(release.updatedAt),
  });
  if (!projected.success) {
    throw Errors.internal(
      "Character Release authority projection is invalid",
      {
        releaseId: nullableString(release.id),
        issues: projected.error.issues,
      },
    );
  }
  if (!hasStrictReleaseResponseAuthority(projected.data)) {
    throw Errors.internal(
      "Character Release authority projection is not idempotently strict",
      { releaseId: nullableString(release.id) },
    );
  }
  return projected.data;
}
