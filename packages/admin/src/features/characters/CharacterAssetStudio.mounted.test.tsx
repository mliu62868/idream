// @vitest-environment happy-dom

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<(path: string, options?: {
    readonly method?: string;
    readonly idempotencyKey?: string;
    readonly body?: unknown;
  }) => Promise<unknown>>(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});
vi.mock("@/components/admin/i18n", () => ({
  adminDateLocale: () => undefined,
  useAdminI18n: () => ({
    locale: "en" as const,
    t: (
      value: string,
      values?: Readonly<Record<string, string | number>>,
    ) => Object.entries(values ?? {}).reduce(
      (text, [key, replacement]) =>
        text.replaceAll(`{${key}}`, String(replacement)),
      value,
    ),
    value: (value: string) => value.replaceAll("_", " "),
  }),
}));

import {
  characterWorkspaceDetail,
  withCharacterWorkspaceDetail,
} from "./character-workspace-fixture";
import { CharacterAssetStudio } from "./CharacterAssetStudio";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import {
  beginDurableMutationIntent,
  readActiveDurableMutationIntent,
  updateDurableMutationIntent,
} from "@/lib/durable-mutation-intent";

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Character Asset Studio");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

const productionPurposes = [
  "character_cover",
  "character_hero",
  "character_chat",
] as const;

// 服务端 journey 投影：图池完成度、下一张该做什么都读它。
// 这里按「已经在当前路线下可用的用途」构造，和服务端 projectCurrentDraftAssetPack 的口径一致
// —— 被软删/路线过期的选择不算 available。
function journeyFor(
  available: readonly (typeof productionPurposes)[number][] = [],
) {
  const progress = (
    availablePurposes: readonly (typeof productionPurposes)[number][],
  ) => ({
    availablePurposes: [...availablePurposes],
    missingPurposes: productionPurposes.filter(
      (purpose) => !availablePurposes.includes(purpose),
    ),
    completed: availablePurposes.length,
    total: 3 as const,
  });
  return {
    assetPack: { draft: progress(available), live: progress([]) },
    release: {
      servingState: "inactive" as const,
      currentReleaseId: null,
      candidateReleaseId: null,
    },
  };
}

type RouteQualification =
  CharacterWorkspaceDetail["visual"]["routeQualifications"][number];

// SPEC: 一条完整的路线资格；各用例只覆盖自己关心的字段。
// INTENT: routeQualifications 是数组，覆盖时整条替换——契约给它加字段，这里必须补上，
//         不能像以前那样靠 `as unknown as` 把整块类型检查关掉。
function routeQualification(
  overrides: Partial<RouteQualification> = {},
): RouteQualification {
  return {
    id: "qualification-1",
    routeFingerprint: "route-fingerprint",
    generationProfileKey: "profile-reference-v1",
    generationProfileVersion: 1,
    workflowKey: "qwen-image-edit-img2img",
    workflowVersion: 1,
    style: "realistic",
    matrixKey: "mounted-matrix",
    sampleCount: 40,
    passCount: 40,
    identityMatch: 0.97,
    result: "qualified",
    evidence: {},
    policyVersion: "character-release-policy-v2",
    evaluatedAt: "2026-07-16T12:00:00.000Z",
    expiresAt: null,
    stale: false,
    identityContract: {
      maxReferences: 1,
      acceptedRoles: ["identity_anchor"],
      supportsLookReference: false,
      supportsSourceImageWithIdentity: false,
    },
    profileCapabilities: {
      referenceImages: true,
      initImage: false,
    },
    sourceVariationAuthority: {
      routeFingerprint: "route-fingerprint",
      ready: true,
      blocker: null,
    },
    ...overrides,
  };
}

const data = characterWorkspaceDetail({
  character: {
    id: "character-no-bootstrap-route",
    name: "Mira",
    description: "A precise evening companion.",
    imageUrl: null,
  },
  journey: journeyFor(),
  project: {
    version: 1,
    draftImageAssetId: null,
    draftAssetPack: {},
    draftAssetSelections: {},
  },
  preview: {
    draft: {
      name: "Mira",
      description: "A precise evening companion.",
      imageUrl: null,
      opening: { firstMessage: null },
    },
  },
  visual: {
    activeIdentity: null,
    anchors: [],
    references: [],
    activeReferenceSet: null,
    routeQualifications: [],
    identityBootstrap: {
      state: "new",
      allowed: true,
      nextIdentityVersion: 1,
      blockers: [],
      profile: null,
    },
    readiness: {
      ready: false,
      qualificationPolicyVersion: "character-release-policy-v2",
      blockers: [],
      productionDeepLink: "/admin/characters/character-no-bootstrap-route?tab=assets",
    },
  },
});

describe("Character Asset Studio bootstrap route projection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    adminV2Request.mockResolvedValue({ items: [], pageInfo: { endCursor: null, hasNextPage: false } });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
    vi.restoreAllMocks();
  });

  it("stays in first-portrait mode and disables generation when authority is allowed but no profile exists", async () => {
    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={data}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.textContent?.includes("First identity portrait") === true);

    expect(container.textContent).toContain("No active text-to-image bootstrap profile is available");
    const generate = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Generate 1 portrait"));
    expect(generate).toBeDefined();
    expect(generate?.disabled).toBe(true);
    expect(container.textContent).not.toContain("Complete visual setup");
    expect(container.textContent).not.toContain("New image");
  });

  it("opens ready characters in the recurring image library with a new-batch composer", async () => {
    const readyData = withCharacterWorkspaceDetail(data, {
      character: {
        ...data.character,
        id: "character-ready-library",
        name: "Alexa Reeves",
        imageUrl: "/alexa.webp",
      },
      project: {
        ...data.project,
        draftAssetRouteAuthority: {
          status: "current",
          missingPurposes: [],
          stalePurposes: [],
          qaBlockers: [],
        },
      },
      preview: {
        ...data.preview,
        draft: {
          ...data.preview.draft,
          name: "Alexa Reeves",
          imageUrl: "/alexa.webp",
        },
      },
      visual: {
        ...data.visual,
        activeIdentity: {
          id: "identity-alexa-v1",
          version: 1,
          immutableHash: "identity-alexa-v1-hash",
        },
        identityBootstrap: {
          state: "blocked_existing_authority",
          allowed: false,
          nextIdentityVersion: 2,
          blockers: ["grounded_or_unknown_identity_history_exists"],
          profile: null,
        },
        readiness: { ...data.visual.readiness, ready: true, blockers: [] },
        routeQualifications: [routeQualification({
          id: "qualification-alexa",
          generationProfileKey: "profile-alexa",
          sourceVariationAuthority: {
            routeFingerprint: "route-alexa",
            ready: false,
            blocker: "workflow_source_identity_combination_unsupported",
          },
        })],
      },
    });

    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={readyData}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.textContent?.includes("New image") === true);

    expect(container.textContent).toContain("Inspect");
    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain("Visual identity");
    expect(container.textContent).not.toContain("Image purpose filters");
    expect(container.textContent).not.toContain("One image per generation");
    expect(container.querySelector('img[alt="Alexa Reeves image 1"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Adjust the creative brief");
    expect(container.textContent).not.toContain("Review generation route");
    const generate = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Generate 1 portrait"));
    expect(generate?.disabled).toBe(false);
  });

  it("does not claim the generation route is locked when only identity evidence is ready", async () => {
    const routeBlockedData = withCharacterWorkspaceDetail(data, {
      character: {
        ...data.character,
        id: "character-route-blocked",
        imageUrl: "/mira.webp",
      },
      visual: {
        ...data.visual,
        activeIdentity: {
          id: "identity-mira-v1",
          version: 1,
          immutableHash: "identity-mira-v1-hash",
        },
        activeReferenceSet: {
          id: "reference-set-mira-v1",
          revision: 1,
          status: "active",
          references: [{
            mediaAssetId: "mira-anchor",
            role: "identity_anchor",
            available: true,
            url: "/mira.webp",
            thumbnailUrl: null,
            qualityScore: null,
            identityScore: null,
          }],
        },
        routeQualifications: [],
        identityBootstrap: {
          state: "blocked_existing_authority",
          allowed: false,
          nextIdentityVersion: 2,
          blockers: ["grounded_or_unknown_identity_history_exists"],
          profile: null,
        },
        readiness: {
          ...data.visual.readiness,
          ready: false,
          blockers: [{
            code: "generation_route_unqualified",
            message: "No qualified generation route exists.",
            deepLink: "/admin/characters/character-no-bootstrap-route?tab=identity",
          }],
        },
      },
    });

    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={routeBlockedData}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.textContent?.includes("Image production setup") === true);

    expect(container.textContent).toContain("Visual identity v1");
    expect(container.textContent).toContain("References 1");
    expect(container.textContent).not.toContain(
      "Identity, references, and route are protected",
    );
    expect(container.textContent).toContain("Unavailable");
  });

  it("explains live-portrait enablement and keeps a failed repair beside the action", async () => {
    const repairableData = withCharacterWorkspaceDetail(data, {
      character: {
        ...data.character,
        id: "character-repairable-live-portrait",
        name: "Alexa Reeves",
        imageUrl: "/alexa.webp",
      },
      visual: {
        ...data.visual,
        identityBootstrap: {
          state: "blocked_existing_authority",
          allowed: false,
          nextIdentityVersion: 1,
          blockers: ["live_portrait_available"],
          profile: null,
        },
        readiness: {
          ...data.visual.readiness,
          ready: false,
          blockers: [{
            code: "identity_missing",
            message: "No immutable Visual Identity version is pinned.",
            deepLink: "/admin/characters/character-no-bootstrap-route?tab=identity",
          }],
        },
        imageReadiness: {
          state: "repairable",
          fingerprint: "repairable-live-portrait-fingerprint",
          repair: {
            kind: "adopt_live_portrait",
            sourceAssetId: "alexa-live-portrait",
          },
        },
      },
    });
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/image-readiness/repair")) {
        throw new Error("Admin authority request failed (500)");
      }
      return { items: [], pageInfo: { endCursor: null, hasNextPage: false } };
    });

    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={repairableData}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.textContent?.includes("Use existing portrait") === true);

    const enable = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Use existing portrait"));
    expect(enable).toBeDefined();
    await act(async () => enable?.click());
    await waitUntil(() => container.textContent?.includes(
      "Image production could not be enabled. Your live images were not changed. Try again.",
    ) === true);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(container.firstElementChild?.firstElementChild).toBe(alert);
    expect(container.textContent).not.toContain("Admin authority request failed (500)");
  });

  it("direct-loads and releases an exact committed Run after it falls outside the recent 20", async () => {
    const characterId = "character-committed-run-projection";
    const actorId = "operator-committed-run-projection";
    const runId = "committed-first-portrait-run";
    const scope = `character-asset:create:${actorId}:${characterId}`;
    const intent = beginDurableMutationIntent({
      scope,
      signature: "committed-first-portrait-signature",
      createIdempotencyKey: () =>
        "committed-first-portrait-idempotency-key",
      requestSnapshot: {
        title: "Mira · Primary portrait",
        purpose: "character_cover",
        targetType: "character",
        targetId: characterId,
        profileId: "bootstrap-profile-v1",
        presetIds: [],
        referenceAssetIds: [],
        bootstrapIdentity: true,
        orientation: "4:5",
        count: 4,
        brief: "Define the first reviewed portrait for Mira.",
        consistencyMode: "strict",
        priority: "normal",
        reason: "Create the reviewed first identity anchor",
      },
    });
    updateDurableMutationIntent(intent, {
      status: "committed_projection_pending",
      committedTargetId: runId,
    });
    const run = {
      id: runId,
      purpose: "character_cover",
      target: { type: "character", id: characterId },
      executionOutcome: "succeeded",
      reviewState: "pending",
      counts: {
        total: 2,
        generated: 2,
        reviewed: 0,
        approved: 0,
        placed: 0,
        failed: 0,
      },
      updatedAt: "2026-07-17T12:00:00.000Z",
    };
    const detail = {
      ...run,
      lifecycleState: "active",
      version: 1,
      items: [
        {
          id: "committed-first-portrait-item",
          ordinal: 0,
          status: "generated",
          executionState: "ready",
          version: 1,
          asset: {
            id: "committed-first-portrait-asset",
            url: "/committed-first-portrait.webp",
            thumbnailUrl: "/committed-first-portrait-thumb.webp",
          },
          lineage: {
            generationProfileKey: "bootstrap-profile-v1",
            workflowKey: "bootstrap-workflow",
            requestId: "committed-first-portrait-request",
            providerRequestId: "committed-first-portrait-provider",
          },
        },
        {
          id: "comparison-first-portrait-item",
          ordinal: 1,
          status: "generated",
          executionState: "ready",
          version: 1,
          asset: {
            id: "comparison-first-portrait-asset",
            url: "/comparison-first-portrait.webp",
            thumbnailUrl: "/comparison-first-portrait-thumb.webp",
          },
          lineage: {
            generationProfileKey: "bootstrap-profile-v1",
            workflowKey: "bootstrap-workflow",
            requestId: "comparison-first-portrait-request",
            providerRequestId: "comparison-first-portrait-provider",
          },
        },
      ],
    };
    const recentRuns = Array.from({ length: 20 }, (_, index) => ({
      ...run,
      id: `newer-first-portrait-run-${index}`,
      updatedAt: `2026-07-${String(17 - Math.floor(index / 2)).padStart(2, "0")}T13:00:00.000Z`,
    }));
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: recentRuns,
          pageInfo: { endCursor: "next-page", hasNextPage: true },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        return detail;
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });
    const committedData = withCharacterWorkspaceDetail(data, {
      character: { ...data.character, id: characterId },
    });

    await act(async () => root.render(
      <CharacterAssetStudio
        actorId={actorId}
        commitProjectMutation={async ({ commit }) => ({
          result: await commit(),
          refreshed: true,
        })}
        data={committedData}
        onContinue={() => undefined}
        onProjectReload={async () => undefined}
        permissions={{
          read: true,
          create: true,
          review: true,
          selectDraft: true,
        }}
      />,
    ));
    await waitUntil(() =>
      container.textContent?.includes("Candidate 1") === true
    );

    expect(readActiveDurableMutationIntent({ scope })).toBeNull();
    expect(container.textContent).not.toContain("Created Run receipt");
    expect(adminV2Request).toHaveBeenCalledWith(
      `/api/v2/admin/creative/runs/${runId}`,
      expect.objectContaining({ schema: expect.anything() }),
    );
    const selectCandidate = [...container.querySelectorAll<HTMLButtonElement>(
      "button",
    )].find((button) =>
      button.getAttribute("aria-label") === "View candidate 1"
    );
    expect(selectCandidate?.disabled).toBe(false);

    const compareCandidate = [...container.querySelectorAll<HTMLButtonElement>(
      "button",
    )].find((button) =>
      button.getAttribute("aria-label") ===
        "Compare candidate 2 with current candidate"
    );
    expect(compareCandidate?.disabled).toBe(false);
    await act(async () => compareCandidate?.click());
    expect(container.textContent).toContain("Two-candidate comparison");
    expect(container.textContent).toContain(
      "Compare the current decision without changing authority",
    );
    expect(container.textContent).toContain("Make current");
  });

  // SPEC: 「已提交的 Run 还读不到」和「随便哪条 Run 读失败」是两件事，必须走两个出口。
  // INTENT: 前者只是投影还没跟上，运营台该看到「重试校验即可」的旁注；把它渲染成红色错误
  //         会让人以为生成失败，转头去点第二次生成——那正是幂等键要防的重复 Run。
  it("keeps a failed committed-Run projection in the retry notice instead of the error exit", async () => {
    const characterId = "character-committed-run-unavailable";
    const actorId = "operator-committed-run-unavailable";
    const runId = "committed-run-awaiting-projection";
    const scope = `character-asset:create:${actorId}:${characterId}`;
    const intent = beginDurableMutationIntent({
      scope,
      signature: "committed-run-awaiting-signature",
      createIdempotencyKey: () => "committed-run-awaiting-key",
      requestSnapshot: {
        title: "Mira · Primary portrait",
        purpose: "character_cover",
        targetType: "character",
        targetId: characterId,
        profileId: "bootstrap-profile-v1",
        presetIds: [],
        referenceAssetIds: [],
        bootstrapIdentity: true,
        orientation: "4:5",
        count: 4,
        brief: "Define the first reviewed portrait for Mira.",
        consistencyMode: "strict",
        priority: "normal",
        reason: "Create the reviewed first identity anchor",
      },
    });
    updateDurableMutationIntent(intent, {
      status: "committed_projection_pending",
      committedTargetId: runId,
    });
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return { items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        throw new Error("projection replica unavailable");
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => root.render(<CharacterAssetStudio
      actorId={actorId}
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={withCharacterWorkspaceDetail(data, {
        character: { ...data.character, id: characterId },
      })}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.textContent?.includes(
      "The committed Run projection is still unavailable",
    ) === true);

    expect(container.textContent).toContain("projection replica unavailable");
    expect(container.textContent).toContain(
      "Verification can be retried without another create request",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("routes a Run projection failure with nothing committed to the error exit", async () => {
    const pinnedRunId = "draft-pinned-run-unavailable";
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return { items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === `/api/v2/admin/creative/runs/${pinnedRunId}`) {
        throw new Error("Creative Run projection is temporarily unreadable");
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={withCharacterWorkspaceDetail(data, {
        project: {
          ...data.project,
          draftAssetSelections: {
            character_cover: {
              assetId: "pinned-asset",
              runId: pinnedRunId,
              itemId: "pinned-item",
              reviewDecisionId: "pinned-review",
              generationJobId: "pinned-job",
            },
          },
        },
      })}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.querySelector('[role="alert"]') !== null);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Creative Run projection is temporarily unreadable",
    );
    expect(container.textContent).not.toContain(
      "The committed Run projection is still unavailable",
    );
  });

  it("keeps a committed Run receipt locked when the detail belongs to another Character", async () => {
    const characterId = "character-locked-run-projection";
    const actorId = "operator-locked-run-projection";
    const runId = "wrong-character-first-portrait-run";
    const scope = `character-asset:create:${actorId}:${characterId}`;
    const intent = beginDurableMutationIntent({
      scope,
      signature: "wrong-character-first-portrait-signature",
      createIdempotencyKey: () =>
        "wrong-character-first-portrait-key",
      requestSnapshot: {
        title: "Mira · Primary portrait",
        purpose: "character_cover",
        targetType: "character",
        targetId: characterId,
        profileId: "bootstrap-profile-v1",
        presetIds: [],
        referenceAssetIds: [],
        bootstrapIdentity: true,
        orientation: "4:5",
        count: 4,
        brief: "Define the first reviewed portrait for Mira.",
        consistencyMode: "strict",
        priority: "normal",
        reason: "Create the reviewed first identity anchor",
      },
    });
    updateDurableMutationIntent(intent, {
      status: "committed_projection_pending",
      committedTargetId: runId,
    });
    const run = {
      id: runId,
      purpose: "character_cover",
      target: { type: "character", id: "another-character" },
      executionOutcome: "succeeded",
      reviewState: "pending",
      counts: {
        total: 0,
        generated: 0,
        reviewed: 0,
        approved: 0,
        placed: 0,
        failed: 0,
      },
      updatedAt: "2026-07-17T12:00:00.000Z",
    };
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        return {
          ...run,
          lifecycleState: "active",
          version: 1,
          items: [],
        };
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });
    const committedData = withCharacterWorkspaceDetail(data, {
      character: { ...data.character, id: characterId },
    });

    await act(async () => root.render(
      <CharacterAssetStudio
        actorId={actorId}
        commitProjectMutation={async ({ commit }) => ({
          result: await commit(),
          refreshed: true,
        })}
        data={committedData}
        onContinue={() => undefined}
        onProjectReload={async () => undefined}
        permissions={{
          read: true,
          create: true,
          review: true,
          selectDraft: true,
        }}
      />,
    ));
    await waitUntil(() =>
      container.textContent?.includes(
        "does not match this Character and image purpose",
      ) === true
    );

    expect(readActiveDurableMutationIntent({ scope })).toMatchObject({
      status: "committed_projection_pending",
      committedTargetId: runId,
    });
    expect(container.textContent).toContain("Created Run receipt");
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label*="creative brief"]',
      )?.disabled,
    ).toBe(true);
  });

  it("disables More like from projected profile authority and enables it only for the complete positive route", async () => {
    const runId = "source-variation-run";
    const runSummary = {
      id: runId,
      purpose: "character_cover",
      executionOutcome: "succeeded",
      reviewState: "approved",
      counts: {
        total: 1,
        generated: 1,
        reviewed: 1,
        approved: 1,
        placed: 0,
        failed: 0,
      },
      updatedAt: "2026-07-16T12:00:00.000Z",
    };
    const runDetail = {
      ...runSummary,
      version: 2,
      items: [{
        id: "source-variation-item",
        ordinal: 0,
        status: "approved",
        version: 1,
        asset: {
          id: "source-variation-asset",
          url: "/source-variation.webp",
          thumbnailUrl: "/source-variation-thumb.webp",
        },
        review: {
          id: "source-variation-review",
          supersedesDecisionId: null,
          decision: "approved",
          identityConsistency: "passed",
          score: 96,
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          reason: "Visible evidence passed",
        },
        lineage: {
          generationProfileKey: "profile-source-v1",
          workflowKey: "source-identity-workflow",
          requestId: "request-source-v1",
          providerRequestId: "provider-source-v1",
        },
      }],
    };
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [runSummary],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        return runDetail;
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });
    // INTENT: 只写这一屏用得上的那几块；videoSources / routeEvaluation 由 base 补齐，
    //         所以标成 Partial 再交给 withCharacterWorkspaceDetail 深合并。
    const readyVisual: Partial<CharacterWorkspaceDetail["visual"]> = {
      activeIdentity: {
        id: "identity-source-v1",
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Stable Mira identity",
        negativeIdentityPrompt: null,
        traits: { face: {}, hair: {}, body: {}, signature: {}, style: {} },
        immutableHash: "identity-source-hash",
        evidenceState: "reviewed_bootstrap",
        defaultSeed: null,
        anchorAssetIds: [],
        createdFrom: "mounted-test",
        createdAt: "2026-07-16T12:00:00.000Z",
      },
      anchors: [],
      references: [],
      activeReferenceSet: {
        id: "reference-set-source-v1",
        revision: 1,
        status: "active",
        selectorVersion: "mounted-source-v1",
        snapshotHash: "reference-source-hash",
        createdFrom: "mounted-test",
        createdAt: "2026-07-16T12:00:00.000Z",
        references: [{
          mediaAssetId: "anchor-source-v1",
          role: "identity_anchor",
          available: true,
          url: "/anchor-source.webp",
          thumbnailUrl: null,
          qualityScore: 96,
          identityScore: 0.98,
        }],
      },
      routeQualifications: [{
        id: "qualification-source-v1",
        routeFingerprint: "route-source-v1",
        generationProfileKey: "profile-source-v1",
        generationProfileVersion: 1,
        workflowKey: "source-identity-workflow",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: "matrix-source-v1",
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.98,
        result: "qualified",
        evidence: {},
        policyVersion: "character-release-policy-v2",
        evaluatedAt: "2026-07-16T12:00:00.000Z",
        expiresAt: null,
        stale: false,
        identityContract: {
          maxReferences: 2,
          acceptedRoles: ["identity_anchor", "source_image"],
          supportsLookReference: false,
          supportsSourceImageWithIdentity: true,
        },
        profileCapabilities: {
          referenceImages: true,
          initImage: false,
        },
        sourceVariationAuthority: {
          routeFingerprint: "route-source-v1",
          ready: false,
          blocker: "profile_init_image_unsupported",
        },
      }],
      identityBootstrap: {
        state: "blocked_existing_authority",
        allowed: false,
        nextIdentityVersion: 2,
        blockers: ["grounded_or_unknown_identity_history_exists"],
        profile: null,
      },
      readiness: {
        ready: true,
        qualificationPolicyVersion: "character-release-policy-v2",
        blockers: [],
        productionDeepLink: "/admin/characters/character-source-v1?tab=assets",
      },
    };
    const blockedData = withCharacterWorkspaceDetail(data, {
      character: { ...data.character, id: "character-source-v1" },
      visual: readyVisual,
    });

    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={blockedData}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.querySelector('[aria-label="View candidate 1"]') !== null);
    const openCandidate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "View candidate 1");
    await act(async () => openCandidate?.click());
    await waitUntil(() => container.textContent?.includes("More like this") === true);

    const blockedButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("More like this"));
    expect(blockedButton?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "active model profile cannot use the selected image as an init image",
    );
    expect(container.textContent).toContain("Review generation route");

    const supportedData = withCharacterWorkspaceDetail(blockedData, {
      visual: {
        ...readyVisual,
        routeQualifications: (readyVisual.routeQualifications ?? []).map((route) => ({
          ...route,
          profileCapabilities: {
            referenceImages: true,
            initImage: true,
          },
          sourceVariationAuthority: {
            routeFingerprint: route.routeFingerprint,
            ready: true,
            blocker: null,
          },
        })),
      },
    });
    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={supportedData}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => {
      const button = [...container.querySelectorAll("button")]
        .find((candidate) => candidate.textContent?.includes("More like this"));
      return button?.disabled === false;
    });
    const supportedButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("More like this"));
    expect(supportedButton?.disabled).toBe(false);
  });

  it("offers one bounded regeneration path for a preserved pack pinned to the previous route", async () => {
    const stalePackData = withCharacterWorkspaceDetail(data, {
      character: { ...data.character, id: "character-stale-pack" },
      project: {
        ...data.project,
        draftImageAssetId: "cover-q1",
        draftAssetPack: {
          character_cover: "cover-q1",
          character_hero: "hero-q1",
          character_chat: "chat-q1",
        },
        draftAssetSelections: {
          character_cover: {
            assetId: "cover-q1",
            runId: "run-cover-q1",
            itemId: "item-cover-q1",
            reviewDecisionId: "review-cover-q1",
            generationJobId: "job-cover-q1",
            bootstrapIdentity: false,
            generationRouteFingerprint: "route-q1",
            routeCurrent: false,
          },
          character_hero: {
            assetId: "hero-q1",
            runId: "run-hero-q1",
            itemId: "item-hero-q1",
            reviewDecisionId: "review-hero-q1",
            generationJobId: "job-hero-q1",
            bootstrapIdentity: false,
            generationRouteFingerprint: "route-q1",
            routeCurrent: false,
          },
          character_chat: {
            assetId: "chat-q1",
            runId: "run-chat-q1",
            itemId: "item-chat-q1",
            reviewDecisionId: "review-chat-q1",
            generationJobId: "job-chat-q1",
            bootstrapIdentity: false,
            generationRouteFingerprint: "route-q1",
            routeCurrent: false,
          },
        },
        draftAssetRouteAuthority: {
          status: "stale",
          currentRouteFingerprint: "route-q2",
          stalePurposes: ["character_cover", "character_hero", "character_chat"],
          recoveryPurpose: "character_cover",
        },
      },
      visual: {
        ...data.visual,
        activeIdentity: {
          id: "identity-1",
          version: 1,
          status: "active",
          style: "realistic",
          identityPrompt: "Mira with a stable recognizable identity",
          negativeIdentityPrompt: "identity drift",
          traits: { face: { identity: "Mira" }, hair: {}, body: {}, signature: {}, style: {} },
          immutableHash: "identity-hash",
          evidenceState: "reviewed_bootstrap",
          defaultSeed: "mira-seed",
          createdFrom: "mounted-test",
          createdAt: "2026-07-16T12:00:00.000Z",
        },
        anchors: [{
          mediaAssetId: "anchor-1",
          role: "identity_anchor",
          available: true,
          url: "/anchor.webp",
          thumbnailUrl: "/anchor-thumb.webp",
          qualityScore: 95,
          identityScore: 0.98,
        }],
        references: [],
        activeReferenceSet: {
          id: "reference-set-1",
          revision: 1,
          status: "active",
          selectorVersion: "mounted-test-v1",
          snapshotHash: "reference-hash",
          createdFrom: "mounted-test",
          createdAt: "2026-07-16T12:00:00.000Z",
          references: [{
            mediaAssetId: "anchor-1",
            role: "identity_anchor",
            available: true,
            url: "/anchor.webp",
            thumbnailUrl: "/anchor-thumb.webp",
            qualityScore: 95,
            identityScore: 0.98,
          }],
        },
        routeQualifications: [{
          id: "qualification-q2",
          routeFingerprint: "route-q2",
          generationProfileKey: "profile-q2",
          generationProfileVersion: 2,
          workflowKey: "qwen-image-edit-img2img",
          workflowVersion: 1,
          style: "realistic",
          matrixKey: "mounted-matrix-q2",
          sampleCount: 40,
          passCount: 40,
          identityMatch: 0.99,
          result: "qualified",
          evidence: {},
          policyVersion: "character-release-policy-v2",
          evaluatedAt: "2026-07-16T13:00:00.000Z",
          expiresAt: null,
          stale: false,
          identityContract: {
            maxReferences: 1,
            acceptedRoles: ["identity_anchor"],
            supportsLookReference: false,
            supportsSourceImageWithIdentity: false,
          },
        }],
        identityBootstrap: {
          state: "blocked_existing_authority",
          allowed: false,
          nextIdentityVersion: 2,
          blockers: ["grounded_or_unknown_identity_history_exists"],
          profile: null,
        },
        readiness: { ...data.visual.readiness, ready: true, blockers: [] },
      },
    });
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        return { batch: { id: "run-cover-q2" }, replayed: false };
      }
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return { items: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === "/api/v2/admin/creative/runs/run-cover-q2") {
        return {
          id: "run-cover-q2",
          purpose: "character_cover",
          executionOutcome: "running",
          reviewState: "pending",
          counts: { total: 6, generated: 0, approved: 0 },
          updatedAt: "2026-07-16T13:00:00.000Z",
          version: 1,
          items: [],
        };
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={stalePackData}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => container.textContent?.includes("Regenerate under current route") === true);
    expect(container.textContent).toContain("remain in history but cannot authorize QA");
    expect(container.textContent).toContain("New image");

    const regenerate = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Regenerate under current route"));
    await act(async () => {
      regenerate?.click();
      await Promise.resolve();
    });
    await waitUntil(() => adminV2Request.mock.calls.some(([path, options]) =>
      path === "/api/v2/admin/creative/runs" && options?.method === "POST"
    ));
    const createCall = adminV2Request.mock.calls.find(([path, options]) =>
      path === "/api/v2/admin/creative/runs" && options?.method === "POST"
    );
    expect(createCall?.[1]).toMatchObject({
      body: {
        count: 1,
        purpose: "character_cover",
        profileId: "profile-q2",
        targetId: "character-stale-pack",
      },
    });
    expect(stalePackData.project.draftAssetPack).toEqual({
      character_cover: "cover-q1",
      character_hero: "hero-q1",
      character_chat: "chat-q1",
    });
  });

  it("keeps a committed refresh usable when polling supersedes its projection requests", async () => {
    vi.useFakeTimers();
    const runningRun = {
      id: "running-run",
      purpose: "character_cover",
      executionOutcome: "running",
      reviewState: "pending",
      counts: { total: 1, generated: 0, approved: 0 },
      updatedAt: "2026-07-16T12:00:00.000Z",
    };
    const runningDetail = { ...runningRun, version: 1, items: [] };
    const listRefresh = deferred<unknown>();
    const detailRefresh = deferred<unknown>();
    let listReads = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        return { batch: { id: "new-run" }, replayed: false };
      }
      if (path.includes("/api/v2/admin/creative/runs?")) {
        listReads += 1;
        if (listReads === 2) return listRefresh.promise;
        return { items: [runningRun], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === "/api/v2/admin/creative/runs/new-run") return detailRefresh.promise;
      if (path === "/api/v2/admin/creative/runs/running-run") return runningDetail;
      throw new Error(`Unexpected Admin request: ${path}`);
    });
    const normalData = withCharacterWorkspaceDetail(data, {
      character: { ...data.character, id: "character-ready" },
      visual: {
        ...data.visual,
        activeIdentity: {
          id: "identity-1",
          version: 1,
          status: "active",
          style: "realistic",
          identityPrompt: "Mira with a stable recognizable identity",
          negativeIdentityPrompt: "identity drift",
          traits: { face: { identity: "Mira" }, hair: {}, body: {}, signature: {}, style: {} },
          immutableHash: "identity-hash",
          evidenceState: "reviewed_bootstrap",
          defaultSeed: "mira-seed",
          createdFrom: "mounted-test",
          createdAt: "2026-07-16T12:00:00.000Z",
        },
        anchors: [{
          mediaAssetId: "anchor-1",
          role: "identity_anchor",
          available: true,
          url: "/anchor.webp",
          thumbnailUrl: "/anchor-thumb.webp",
          qualityScore: 95,
          identityScore: 0.98,
        }],
        references: [],
        activeReferenceSet: {
          id: "reference-set-1",
          revision: 1,
          status: "active",
          selectorVersion: "mounted-test-v1",
          snapshotHash: "reference-hash",
          createdFrom: "mounted-test",
          createdAt: "2026-07-16T12:00:00.000Z",
          references: [{
            mediaAssetId: "anchor-1",
            role: "identity_anchor",
            available: true,
            url: "/anchor.webp",
            thumbnailUrl: "/anchor-thumb.webp",
            qualityScore: 95,
            identityScore: 0.98,
          }],
        },
        routeQualifications: [{
          id: "qualification-1",
          routeFingerprint: "route-fingerprint",
          generationProfileKey: "profile-reference-v1",
          generationProfileVersion: 1,
          workflowKey: "qwen-image-edit-img2img",
          workflowVersion: 1,
          style: "realistic",
          matrixKey: "mounted-matrix",
          sampleCount: 40,
          passCount: 40,
          identityMatch: 0.97,
          result: "qualified",
          evidence: {},
          policyVersion: "character-release-policy-v2",
          evaluatedAt: "2026-07-16T12:00:00.000Z",
          expiresAt: null,
          stale: false,
          identityContract: {
            maxReferences: 1,
            acceptedRoles: ["identity_anchor"],
            supportsLookReference: false,
            supportsSourceImageWithIdentity: false,
          },
        }],
        identityBootstrap: {
          state: "blocked_existing_authority",
          allowed: false,
          nextIdentityVersion: 2,
          blockers: ["grounded_or_unknown_identity_history_exists"],
          profile: null,
        },
        readiness: { ...data.visual.readiness, ready: true, blockers: [] },
      },
    });

    await act(async () => {
      root.render(<CharacterAssetStudio
        commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
        data={normalData}
        onContinue={() => undefined}
        onProjectReload={async () => undefined}
        permissions={{ read: true, create: true, review: true, selectDraft: true }}
      />);
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const generate = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Generate 1 portrait"));
    expect(generate?.disabled).toBe(false);

    await act(async () => {
      generate?.click();
      await Promise.resolve();
    });
    expect(listReads).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    await act(async () => {
      listRefresh.resolve({ items: [runningRun], pageInfo: { endCursor: null, hasNextPage: false } });
      detailRefresh.resolve({
        ...runningDetail,
        id: "new-run",
        target: {
          type: "character",
          id: "character-ready",
        },
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(container.textContent).not.toContain("latest projection could not be refreshed");
    expect(container.textContent).not.toContain("Automatic refresh was delayed");
    expect(container.textContent).not.toContain("Created Run receipt");
    expect(readActiveDurableMutationIntent({
      scope: "character-asset:create:anonymous:character-ready",
    })).toBeNull();
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label*="creative brief"]',
      )?.disabled,
    ).toBe(false);
  });

  it("direct-loads the exact draft-pinned Run after it falls outside the recent 20", async () => {
    const pinnedRunId = "draft-pinned-run-older-than-page";
    const recentRuns = Array.from({ length: 20 }, (_, index) => ({
      id: `recent-run-${index}`,
      purpose: "character_cover",
      executionOutcome: "succeeded",
      reviewState: "approved",
      counts: { total: 1, generated: 1, reviewed: 1, approved: 1, placed: 0, failed: 0 },
      updatedAt: `2026-07-${String(16 - Math.floor(index / 2)).padStart(2, "0")}T12:00:00.000Z`,
    }));
    const pinnedDetail = {
      id: pinnedRunId,
      purpose: "character_cover",
      executionOutcome: "succeeded",
      reviewState: "approved",
      counts: { total: 1, generated: 1, reviewed: 1, approved: 1, placed: 0, failed: 0 },
      updatedAt: "2026-06-01T12:00:00.000Z",
      items: [],
    };
    adminV2Request.mockImplementation(async (path) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return { items: recentRuns, pageInfo: { endCursor: "next-page", hasNextPage: true } };
      }
      if (path === `/api/v2/admin/creative/runs/${pinnedRunId}`) return pinnedDetail;
      throw new Error(`Unexpected Admin request: ${path}`);
    });
    const pinnedData = withCharacterWorkspaceDetail(data, {
      project: {
        ...data.project,
        draftImageAssetId: "pinned-asset",
        draftAssetPack: { character_cover: "pinned-asset" },
        draftAssetSelections: {
          character_cover: {
            assetId: "pinned-asset",
            runId: pinnedRunId,
            itemId: "pinned-item",
            reviewDecisionId: "pinned-review",
            generationJobId: "pinned-job",
          },
        },
      },
    });

    await act(async () => root.render(<CharacterAssetStudio
      commitProjectMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
      data={pinnedData}
      onContinue={() => undefined}
      onProjectReload={async () => undefined}
      permissions={{ read: true, create: true, review: true, selectDraft: true }}
    />));
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) =>
      path === `/api/v2/admin/creative/runs/${pinnedRunId}`
    ));
    await waitUntil(() => container.textContent?.includes("Selected in draft") === true);

    expect(adminV2Request).toHaveBeenCalledWith(
      `/api/v2/admin/creative/runs/${pinnedRunId}`,
      expect.objectContaining({ schema: expect.anything() }),
    );
    expect(container.textContent).toContain(pinnedRunId);
  });

  it("recovers lost first-portrait creation with the exact actor-scoped request and verifies by GET only", async () => {
    const bootstrapData = withCharacterWorkspaceDetail(data, {
      character: {
        ...data.character,
        id: "character-create-recovery",
      },
      visual: {
        ...data.visual,
        identityBootstrap: {
          ...data.visual.identityBootstrap,
          profile: {
            profileKey: "bootstrap-profile-v1",
            profileVersion: 1,
            label: "First portrait profile",
            workflowKey: "bootstrap-workflow",
            workflowVersion: 1,
            orientation: "4:5",
          },
        },
      },
    });
    const createKeys: string[] = [];
    const createBodies: unknown[] = [];
    let createPosts = 0;
    let projectionReads = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (
        path === "/api/v2/admin/creative/runs" &&
        options?.method === "POST"
      ) {
        createPosts += 1;
        createKeys.push(options.idempotencyKey ?? "");
        createBodies.push(options.body);
        if (createPosts === 1) {
          throw new TypeError("Response ended after server commit");
        }
        return {
          batch: { id: "recovered-first-portrait-run" },
          replayed: true,
        };
      }
      if (
        path ===
        "/api/v2/admin/creative/runs/recovered-first-portrait-run"
      ) {
        projectionReads += 1;
        throw new Error("projection replica unavailable");
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });
    const renderForActor = async (actorId: string) => {
      await act(async () => {
        root.render(
          <CharacterAssetStudio
            actorId={actorId}
            commitProjectMutation={async ({ commit }) => ({
              result: await commit(),
              refreshed: true,
            })}
            data={bootstrapData}
            onContinue={() => undefined}
            onProjectReload={async () => undefined}
            permissions={{
              read: true,
              create: true,
              review: true,
              selectDraft: true,
            }}
          />,
        );
      });
      await waitUntil(() =>
        container.textContent?.includes("Loading character assets") ===
          false
      );
    };
    const findButton = (label: string) =>
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes(label)
      );

    await renderForActor("operator-a");
    expect(findButton("Generate 1 portrait")?.disabled).toBe(false);
    await act(async () => {
      findButton("Generate 1 portrait")?.click();
      await Promise.resolve();
    });
    expect(createPosts).toBe(1);
    expect(createKeys[0]).toBeTruthy();
    expect(container.textContent).toContain(
      "Generation outcome is unknown",
    );
    expect(findButton("Resume generation")).toBeDefined();

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderForActor("operator-a");
    expect(findButton("Resume generation")).toBeDefined();
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label*="creative brief"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      findButton("Resume generation")?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      container.textContent?.includes("Created Run receipt") === true
    );
    expect(createPosts).toBe(2);
    expect(createKeys[1]).toBe(createKeys[0]);
    expect(createBodies[1]).toEqual(createBodies[0]);
    expect(projectionReads).toBe(1);
    expect(findButton("Verify created Run")).toBeDefined();

    await act(async () => {
      findButton("Verify created Run")?.click();
      await Promise.resolve();
    });
    await waitUntil(() => projectionReads === 2);
    expect(createPosts).toBe(2);
    expect(container.textContent).toContain(
      "Verification can be retried without another create request",
    );

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderForActor("operator-b");
    expect(findButton("Resume generation")).toBeUndefined();
    expect(findButton("Verify created Run")).toBeUndefined();
    expect(findButton("Generate 1 portrait")).toBeDefined();
    expect(createPosts).toBe(2);
  });

  it("keeps a recovered selection locked until the exact Character projection arrives", async () => {
    const characterId = data.character.id;
    const selectionScope =
      `character-asset:selection:operator-a:${characterId}`;
    const selectedAssetId = "recovered-selection-asset";
    const trustedVerification = {
      kind: "character_draft_image_selection" as const,
      characterId,
      selectedPurpose: "character_hero" as const,
      selectedAssetId,
    };
    beginDurableMutationIntent({
      scope: selectionScope,
      signature: "legacy-selection-without-kind",
      createIdempotencyKey: () =>
        "recovered-selection-idempotency-key",
      requestSnapshot: { legacy: true },
    });
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (
        path === "/api/v2/admin/mutation-receipts/reconcile" &&
        options?.method === "POST"
      ) {
        if (
          (
            options.body as {
              readonly commandType?: string;
            } | undefined
          )?.commandType === "character.identity.bootstrap"
        ) {
          throw new AdminV2RequestError(
            "Idempotency key belongs to another mutation type",
            409,
            "conflict",
            {
              expectedCommandType:
                "character.identity.bootstrap",
              existingCommandType:
                "character.project.draft_image.select",
            },
          );
        }
        return {
          state: "committed",
          commandType:
            "character.project.draft_image.select",
          commandId: "recovered-selection-command",
          status: "succeeded",
          committedTargetId: "recovered-selection-asset",
          verification: {
            ...trustedVerification,
          },
        };
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    const render = async (nextData: CharacterWorkspaceDetail) => {
      await act(async () => {
        root.render(
        <CharacterAssetStudio
          actorId="operator-a"
          commitProjectMutation={async ({ commit }) => ({
            result: await commit(),
            refreshed: true,
          })}
          data={nextData}
          onContinue={() => undefined}
          onProjectReload={async () => undefined}
          permissions={{
            read: true,
            create: true,
            review: true,
            selectDraft: true,
          }}
        />,
        );
      });
    };

    await render(data);
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reconcile selection")
      )
    );
    const reconcile = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Reconcile selection"),
    );
    await act(async () => {
      reconcile?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      readActiveDurableMutationIntent({
        scope: selectionScope,
      })?.status === "committed_projection_pending"
    );

    expect(readActiveDurableMutationIntent({
      scope: selectionScope,
    })).toMatchObject({
      idempotencyKey: "recovered-selection-idempotency-key",
      status: "committed_projection_pending",
      committedTargetId: "recovered-selection-asset",
      requestSnapshot: trustedVerification,
    });
    expect(container.textContent).toContain(
      "remains locked until the exact Character authority is visible",
    );
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path.includes("/draft-image") &&
      options?.method === "PATCH"
    )).toBe(false);
    expect(adminV2Request.mock.calls.filter(([path]) =>
      path === "/api/v2/admin/mutation-receipts/reconcile"
    ).map(([, options]) => options?.body)).toEqual([
      {
        commandType: "character.identity.bootstrap",
        expectedCharacterId: characterId,
      },
      {
        commandType:
          "character.project.draft_image.select",
        expectedCharacterId: characterId,
      },
    ]);

    const wrongSlotProjection = withCharacterWorkspaceDetail(data, {
      project: {
        ...data.project,
        draftImageAssetId: selectedAssetId,
        draftAssetPack: {
          character_cover: selectedAssetId,
        },
        draftAssetSelections: {
          character_cover: {
            assetId: selectedAssetId,
            runId: null,
            itemId: null,
            reviewDecisionId: null,
            generationJobId: null,
            bootstrapIdentity: false,
            generationRouteFingerprint: null,
            routeCurrent: true,
          },
        },
      },
    });
    await render(wrongSlotProjection);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(readActiveDurableMutationIntent({
      scope: selectionScope,
    })).toMatchObject({
      status: "committed_projection_pending",
      committedTargetId: selectedAssetId,
    });
    expect(container.textContent).toContain("Verify selection");

    const exactProjection = withCharacterWorkspaceDetail(wrongSlotProjection, {
      project: {
        ...wrongSlotProjection.project,
        draftAssetPack: {
          ...wrongSlotProjection.project.draftAssetPack,
          character_hero: selectedAssetId,
        },
        draftAssetSelections: {
          ...wrongSlotProjection.project.draftAssetSelections,
          character_hero: {
            assetId: selectedAssetId,
            runId: null,
            itemId: null,
            reviewDecisionId: null,
            generationJobId: null,
            bootstrapIdentity: false,
            generationRouteFingerprint: null,
            routeCurrent: true,
          },
        },
      },
    });
    await render(exactProjection);
    await waitUntil(() =>
      readActiveDurableMutationIntent({
        scope: selectionScope,
      }) === null
    );
    expect(container.textContent).toContain(
      "exact draft asset selection is verified",
    );
  });

  it("unlocks a legacy unbound selection after typed fallback proves it was cancelled", async () => {
    const characterId = data.character.id;
    const selectionScope =
      `character-asset:selection:operator-a:${characterId}`;
    beginDurableMutationIntent({
      scope: selectionScope,
      signature: "legacy-unbound-selection-receipt",
      createIdempotencyKey: () =>
        "cancelled-selection-idempotency-key",
      requestSnapshot: { legacySelectionAsset: "removed-field" },
    });
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (
        path === "/api/v2/admin/mutation-receipts/reconcile" &&
        options?.method === "POST"
      ) {
        const commandType = (
          options.body as {
            readonly commandType?: string;
          } | undefined
        )?.commandType;
        if (commandType === "character.identity.bootstrap") {
          throw new AdminV2RequestError(
            "Idempotency key belongs to another mutation type",
            409,
            "conflict",
            {
              expectedCommandType:
                "character.identity.bootstrap",
              existingCommandType:
                "character.project.draft_image.select",
            },
          );
        }
        return {
          state: "cancelled",
          commandType:
            "character.project.draft_image.select",
          commandId: "cancelled-selection-command",
          status: "cancelled",
          committedTargetId: null,
          verification: null,
        };
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CharacterAssetStudio
          actorId="operator-a"
          commitProjectMutation={async ({ commit }) => ({
            result: await commit(),
            refreshed: true,
          })}
          data={data}
          onContinue={() => undefined}
          onProjectReload={async () => undefined}
          permissions={{
            read: true,
            create: true,
            review: true,
            selectDraft: true,
          }}
        />,
      );
    });
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reconcile selection")
      )
    );
    const reconcile = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Reconcile selection"),
    );
    await act(async () => {
      reconcile?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      readActiveDurableMutationIntent({
        scope: selectionScope,
      }) === null
    );

    expect(adminV2Request.mock.calls.filter(([path]) =>
      path === "/api/v2/admin/mutation-receipts/reconcile"
    ).map(([, options]) => options?.body)).toEqual([
      {
        commandType: "character.identity.bootstrap",
        expectedCharacterId: characterId,
      },
      {
        commandType:
          "character.project.draft_image.select",
        expectedCharacterId: characterId,
      },
    ]);
    expect(container.textContent).toContain(
      "old selection request had no committed effect",
    );
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reconcile selection")
      ),
    ).toBe(false);
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path.includes("/draft-image") &&
      options?.method === "PATCH"
    )).toBe(false);
  });

  it("clears an old bootstrap receipt only after its trusted identity authority is visible", async () => {
    const characterId = data.character.id;
    const selectionScope =
      `character-asset:selection:operator-a:${characterId}`;
    const trustedVerification = {
      kind: "character_identity_bootstrap" as const,
      characterId,
      referenceSetRevisionId: "recovered-reference-revision",
      anchorAssetId: "recovered-identity-anchor",
      draftImageAssetId: "recovered-draft-cover",
    };
    beginDurableMutationIntent({
      scope: selectionScope,
      signature: "legacy-bootstrap-signature",
      createIdempotencyKey: () =>
        "recovered-bootstrap-idempotency-key",
      requestSnapshot: {
        kind: "bootstrap",
        body: { legacyAssetIdentifier: "recovered-identity-anchor" },
      },
    });
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (
        path === "/api/v2/admin/mutation-receipts/reconcile" &&
        options?.method === "POST"
      ) {
        return {
          state: "committed",
          commandType: "character.identity.bootstrap",
          commandId: "recovered-bootstrap-command",
          status: "succeeded",
          committedTargetId:
            trustedVerification.referenceSetRevisionId,
          verification: trustedVerification,
        };
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });
    const render = async (nextData: CharacterWorkspaceDetail) => {
      await act(async () => {
        root.render(
          <CharacterAssetStudio
            actorId="operator-a"
            commitProjectMutation={async ({ commit }) => ({
              result: await commit(),
              refreshed: true,
            })}
            data={nextData}
            onContinue={() => undefined}
            onProjectReload={async () => undefined}
            permissions={{
              read: true,
              create: true,
              review: true,
              selectDraft: true,
            }}
          />,
        );
      });
    };

    await render(data);
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reconcile selection")
      )
    );
    const reconcile = [...container.querySelectorAll("button")].find(
      (button) =>
        button.textContent?.includes("Reconcile selection"),
    );
    await act(async () => {
      reconcile?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      readActiveDurableMutationIntent({
        scope: selectionScope,
      })?.status === "committed_projection_pending"
    );

    expect(adminV2Request.mock.calls.find(([path]) =>
      path === "/api/v2/admin/mutation-receipts/reconcile"
    )?.[1]?.body).toEqual({
      commandType: "character.identity.bootstrap",
      expectedCharacterId: characterId,
    });
    expect(readActiveDurableMutationIntent({
      scope: selectionScope,
    })).toMatchObject({
      committedTargetId: trustedVerification.referenceSetRevisionId,
      requestSnapshot: trustedVerification,
    });

    const exactProjection = withCharacterWorkspaceDetail(data, {
      project: {
        ...data.project,
        draftImageAssetId: trustedVerification.draftImageAssetId,
        draftAssetPack: {
          character_cover: trustedVerification.draftImageAssetId,
        },
      },
      visual: {
        ...data.visual,
        activeIdentity: {
          id: "recovered-identity",
          version: 1,
          status: "active",
          style: "realistic",
          identityPrompt: "Recovered stable identity",
          negativeIdentityPrompt: null,
          traits: {
            face: {},
            hair: {},
            body: {},
            signature: {},
            style: {},
          },
          immutableHash: "recovered-identity-hash",
          evidenceState: "reviewed_bootstrap",
          defaultSeed: null,
          createdFrom: "receipt-recovery",
          createdAt: "2026-07-17T12:00:00.000Z",
        },
        activeReferenceSet: {
          id: trustedVerification.referenceSetRevisionId,
          revision: 1,
          status: "active",
          selectorVersion: "receipt-recovery-v1",
          snapshotHash: "receipt-recovery-reference-hash",
          createdFrom: "receipt-recovery",
          createdAt: "2026-07-17T12:00:00.000Z",
          references: [{
            mediaAssetId: trustedVerification.anchorAssetId,
            role: "identity_anchor",
            available: true,
            url: "/recovered-anchor.webp",
            thumbnailUrl: null,
            qualityScore: 96,
            identityScore: 0.98,
          }],
        },
        identityBootstrap: {
          state: "blocked_existing_authority",
          allowed: false,
          nextIdentityVersion: 2,
          blockers: ["grounded_or_unknown_identity_history_exists"],
          profile: null,
        },
      },
    });
    await render(exactProjection);
    await waitUntil(() =>
      readActiveDurableMutationIntent({
        scope: selectionScope,
      }) === null
    );
    expect(container.textContent).toContain(
      "Identity bootstrap authority is verified",
    );
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path.includes("/identity-bootstrap") &&
      options?.method === "POST"
    )).toBe(false);
  });

  it("clears a recovered review only after the exact decision is visible on its Run item", async () => {
    const characterId = data.character.id;
    const reviewScope =
      `character-asset:review:operator-a:${characterId}`;
    const runId = "recovered-review-run";
    const itemId = "recovered-review-item";
    const decisionId = "recovered-review-decision";
    const canonicalSnapshot = {
      runId,
      itemId,
      body: {
        entityVersion: 2,
        decision: "approved",
        identityConsistency: "unscored",
        score: 94,
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "Exact recovered candidate evidence passed",
      },
    };
    beginDurableMutationIntent({
      scope: reviewScope,
      signature: "legacy-review-without-replay-body",
      createIdempotencyKey: () =>
        "recovered-review-idempotency-key",
      requestSnapshot: { legacy: true },
    });
    const runSummary = {
      id: runId,
      purpose: "character_cover",
      executionOutcome: "succeeded",
      reviewState: "approved",
      counts: {
        total: 1,
        generated: 1,
        reviewed: 1,
        approved: 1,
        placed: 0,
        failed: 0,
      },
      updatedAt: "2026-07-17T12:00:00.000Z",
    };
    const runDetail = {
      ...runSummary,
      version: 2,
      items: [{
        id: itemId,
        ordinal: 0,
        status: "approved",
        version: 2,
        asset: {
          id: "recovered-review-asset",
          url: "/recovered-review.webp",
          thumbnailUrl: "/recovered-review-thumb.webp",
        },
        review: {
          id: decisionId,
          supersedesDecisionId: null,
          decision: "approved",
          identityConsistency: "unscored",
          score: 94,
          quality: canonicalSnapshot.body.quality,
          reason: canonicalSnapshot.body.reason,
        },
        lineage: {
          generationProfileKey: "bootstrap-profile-v1",
          workflowKey: "bootstrap-workflow",
          requestId: "recovered-review-request",
          providerRequestId: "recovered-review-provider",
        },
      }],
    };
    let detailReads = 0;
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [runSummary],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${runId}`) {
        detailReads += 1;
        return runDetail;
      }
      if (
        path === "/api/v2/admin/mutation-receipts/reconcile" &&
        options?.method === "POST"
      ) {
        return {
          state: "committed",
          commandType: "creative.review.decision",
          commandId: "recovered-review-command",
          status: "succeeded",
          committedTargetId: decisionId,
          verification: {
            kind: "creative_review_decision",
            runId,
            itemId,
            decisionId,
            requestSnapshot: canonicalSnapshot,
          },
        };
      }
      throw new Error(`Unexpected Admin request: ${path}`);
    });

    await act(async () => {
      root.render(
        <CharacterAssetStudio
          actorId="operator-a"
          commitProjectMutation={async ({ commit }) => ({
            result: await commit(),
            refreshed: true,
          })}
          data={data}
          onContinue={() => undefined}
          onProjectReload={async () => undefined}
          permissions={{
            read: true,
            create: true,
            review: true,
            selectDraft: true,
          }}
        />,
      );
    });
    await waitUntil(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Reconcile review")
      )
    );
    const reconcile = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Reconcile review"),
    );
    await act(async () => {
      reconcile?.click();
      await Promise.resolve();
    });
    await waitUntil(() =>
      readActiveDurableMutationIntent({
        scope: reviewScope,
      }) === null
    );

    expect(detailReads).toBeGreaterThan(0);
    expect(container.textContent).toContain(
      "verified against its exact Run item",
    );
    expect(adminV2Request.mock.calls.some(([path, options]) =>
      path.includes("/decisions") &&
      options?.method === "POST"
    )).toBe(false);
  });
});
