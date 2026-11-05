import { AdminV2RequestError } from "@/components/admin/api";

/**
 * SPEC: 精选保存请求只由「保存前列表、新列表、读到的版本」决定，运营不填任何文字。
 * INVARIANT: expectedVersion 是真正的护栏：别人先保存时服务端回 409，绝不盲写覆盖。
 */
export function featuredSaveBody(
  savedIds: readonly string[],
  nextIds: readonly string[],
  expectedVersion: number,
) {
  const saved = new Set(savedIds);
  const next = new Set(nextIds);
  const added = nextIds.filter((id) => !saved.has(id)).length;
  const removed = savedIds.filter((id) => !next.has(id)).length;
  return {
    characterIds: [...nextIds],
    expectedVersion,
    reason: `Update Featured (+${added}, -${removed})`,
  };
}

export const FEATURED_MAX_CHARACTERS = 24;

export type FeaturedVersionConflict = {
  settingVersion: number;
  configuredCharacterIds: string[];
};

export function featuredVersionConflictFromError(
  cause: unknown,
): FeaturedVersionConflict | null {
  if (
    !(cause instanceof AdminV2RequestError) ||
    cause.status !== 409 ||
    !isRecord(cause.details) ||
    cause.details.reason !== "featured_setting_version_conflict" ||
    typeof cause.details.settingVersion !== "number" ||
    !Number.isInteger(cause.details.settingVersion) ||
    cause.details.settingVersion < 0 ||
    !Array.isArray(cause.details.configuredCharacterIds) ||
    !cause.details.configuredCharacterIds.every(
      (id) => typeof id === "string",
    )
  ) {
    return null;
  }
  return {
    settingVersion: cause.details.settingVersion,
    configuredCharacterIds: cause.details.configuredCharacterIds,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// SPEC: 把一个 ID 挪到新位置，其余相对顺序不变；越界时原样返回。
export function moveFeaturedId(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
