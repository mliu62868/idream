import type { CharacterWorkspaceDetail } from "@idream/shared/admin";

/**
 * SPEC: 一份完整、合法的 CharacterWorkspaceDetail，测试在其上做局部覆盖。
 * INTENT: 各测试原本各写各的 `{...} as unknown as CharacterWorkspaceDetail`，只填了
 *         14 个契约字段里的 8 个。强转把类型检查整个关掉了——shared 里给投影加一个必填
 *         字段、改一个字段名，这些测试照样全绿，于是"契约变了"这件事在 admin 侧无人接。
 *         这份 base 用 satisfies 校验，契约一动它就编译不过。
 * INVARIANT: 这里的值只求合法与好读，不承诺和线上投影一致；需要什么事实由各测试覆盖。
 */
const base = {
  character: {
    id: "character-fixture",
    name: "Mira",
    age: 24,
    description: "A fixture Character used by admin workspace tests.",
    gender: "female",
    style: "realistic",
    visibility: "public",
    legacyStatus: "draft",
    imageUrl: null,
    updatedAt: "2026-07-30T12:00:00.000Z",
  },
  project: {
    id: "project-fixture",
    characterId: "character-fixture",
    ownerId: null,
    phase: "idea",
    audience: "",
    companionNeed: "",
    hypothesis: "",
    differentiation: "",
    targetPlacementKeys: [],
    successCriteria: [],
    productionPackage: "",
    qaPlan: "",
    draftImageAssetId: null,
    draftAssetPackHash: "",
    draftAssetPack: {},
    draftAssetRouteAuthority: {
      status: "empty",
      currentRouteFingerprint: null,
      stalePurposes: [],
      missingPurposes: [],
      recoveryPurpose: null,
      qaReady: false,
      qaBlockers: [],
    },
    plannedLaunchAt: null,
    version: 1,
    updatedAt: "2026-07-30T12:00:00.000Z",
  },
  soul: {
    valid: true,
    current: {
      contentVersionId: "content-fixture",
      version: 1,
      schemaVersion: 1,
      compilerVersion: "character-soul-1",
      fingerprint: "fixture-fingerprint",
      estimatedTokens: 256,
      soul: {},
      markdown: "# Mira",
      systemPrompt: "You are Mira.",
      diagnostics: [],
    },
    previous: null,
    changedFields: [],
  },
  journey: {
    projectionVersion: 1,
    asOf: "2026-07-30T12:00:00.000Z",
    stage: "visual_setup",
    status: "blocked",
    steps: [
      { code: "visual_identity", state: "current", deepLink: "/admin/characters/character-fixture" },
      { code: "image_assets", state: "upcoming", deepLink: "/admin/characters/character-fixture" },
      { code: "preview_qa", state: "upcoming", deepLink: "/admin/characters/character-fixture" },
      { code: "release", state: "upcoming", deepLink: "/admin/characters/character-fixture" },
      { code: "live_monitor", state: "upcoming", deepLink: "/admin/characters/character-fixture" },
    ],
    blockers: [],
    primaryAction: {
      code: "create_primary_portrait",
      deepLink: "/admin/characters/character-fixture",
      command: null,
    },
    assetPack: {
      draft: { availablePurposes: [], missingPurposes: [], completed: 0, total: 3 },
      live: { availablePurposes: [], missingPurposes: [], completed: 0, total: 3 },
    },
    release: {
      servingState: "inactive",
      currentReleaseId: null,
      candidateReleaseId: null,
    },
  },
  mediaOperations: {
    projectionVersion: 1,
    asOf: "2026-07-30T12:00:00.000Z",
    operations: [
      {
        modality: "image",
        requestId: null,
        status: null,
        attempt: null,
        provider: null,
        timing: null,
        costDreamcoins: null,
        output: null,
        recoverability: {
          state: "unavailable",
          reason: null,
          actionHref: null,
          actionConfirmation: null,
        },
        studioHref: "/admin/characters/character-fixture",
        operationsHref: null,
      },
      {
        modality: "video",
        requestId: null,
        status: null,
        attempt: null,
        provider: null,
        timing: null,
        costDreamcoins: null,
        output: null,
        recoverability: {
          state: "unavailable",
          reason: null,
          actionHref: null,
          actionConfirmation: null,
        },
        studioHref: "/admin/characters/character-fixture",
        operationsHref: null,
      },
      {
        modality: "voice",
        requestId: null,
        status: null,
        attempt: null,
        provider: null,
        timing: null,
        costDreamcoins: null,
        output: null,
        recoverability: {
          state: "unavailable",
          reason: null,
          actionHref: null,
          actionConfirmation: null,
        },
        studioHref: "/admin/characters/character-fixture",
        operationsHref: null,
      },
    ],
  },
  visual: {
    activeIdentity: null,
    anchors: [],
    references: [],
    videoSources: [],
    activeReferenceSet: null,
    routeQualifications: [],
    routeEvaluation: {
      ready: false,
      blocker: null,
      sampleMinimum: 3,
      evaluatorVersion: "identity_eval_v1",
      profiles: [],
    },
    identityBootstrap: {
      state: "new",
      allowed: false,
      nextIdentityVersion: 1,
      blockers: [],
      profile: null,
    },
    readiness: {
      ready: false,
      qualificationPolicyVersion: "qualification_policy_v1",
      blockers: [],
      productionDeepLink: "/admin/characters/character-fixture",
    },
  },
  voice: {
    provider: "fish_audio",
    cloningAvailable: true,
    runtimeStatus: "ready",
    runtimeEngine: "omlx",
    runtimeVersion: null,
    runtimeLanguage: "en",
    currentVoiceId: null,
    effectiveVoiceId: "fish-female-default",
    authoritySource: "system_default",
    systemDefaults: {
      provider: "fish_audio",
      source: "environment",
      settingVersion: 1,
      updatedAt: null,
      defaultVoiceId: "fish-female-default",
      genderVoiceIds: {
        female: "fish-female-default",
        male: "fish-female-default",
        trans: "fish-female-default",
      },
      delivery: {
        preset: "sensual",
        intensity: 0.6,
        speed: 1,
        temperature: 0.7,
        topP: 0.7,
        topK: 40,
        repetitionPenalty: 1.1,
      },
      catalog: [],
    },
    activeProfile: null,
    candidateProfile: null,
    history: [],
  },
  serving: null,
  activeCommand: null,
  releases: [],
  qaRuns: [],
  preview: {
    live: null,
    draft: {
      releaseId: null,
      contentVersionId: null,
      label: "Draft Preview",
      name: "Mira",
      description: "",
      persona: {},
      opening: {},
      appearance: {},
      imageUrl: null,
      assetPack: {
        character_cover: { assetId: null, imageUrl: null, status: "missing" },
        character_hero: { assetId: null, imageUrl: null, status: "missing" },
        character_chat: { assetId: null, imageUrl: null, status: "missing" },
      },
      assetPackReady: false,
      renderUrl: null,
    },
    changedFields: [],
  },
  performance: [],
  portfolio: {
    latestDecision: null,
    changeMarkers: [],
  },
} satisfies CharacterWorkspaceDetail;

/**
 * INTENT: 数组按整体替换，不做逐项合并——测试写 `anchors: [a]` 的意思一定是"就这一个"。
 */
type FixtureOverrides<T> = T extends readonly unknown[] ? T
  : T extends object ? { readonly [K in keyof T]?: FixtureOverrides<T[K]> }
  : T;

function merge(current: unknown, override: unknown): unknown {
  if (
    override === null ||
    typeof override !== "object" ||
    Array.isArray(override) ||
    current === null ||
    typeof current !== "object" ||
    Array.isArray(current)
  ) {
    return override;
  }
  const next: Record<string, unknown> = { ...(current as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    next[key] = merge(next[key], value);
  }
  return next;
}

/**
 * SPEC: 在完整 base 上做深合并，产出一份仍然完整的投影。
 * INTENT: overrides 是对象字面量，TypeScript 的多余属性检查会挡下写错/已改名的字段——
 *         这正是 `as unknown as` 丢掉的那道检查。
 */
export function characterWorkspaceDetail(
  overrides: FixtureOverrides<CharacterWorkspaceDetail> = {},
): CharacterWorkspaceDetail {
  return withCharacterWorkspaceDetail(base, overrides);
}

/**
 * SPEC: 在某个已经调好的投影上再改一层，仍然产出完整投影。
 * INTENT: 测试文件常有自己的一份 data（本文件的公共前置），各用例再在它上面微调。
 *         用扩展运算符手写这一层就等于每次都要把嵌套对象补全，写不动就会退回强转。
 */
export function withCharacterWorkspaceDetail(
  current: CharacterWorkspaceDetail,
  overrides: FixtureOverrides<CharacterWorkspaceDetail> = {},
): CharacterWorkspaceDetail {
  return merge(current, overrides) as CharacterWorkspaceDetail;
}
