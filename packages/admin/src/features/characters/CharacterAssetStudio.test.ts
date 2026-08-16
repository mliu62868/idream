import { readFileSync } from "node:fs";
import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import {
  canChooseCharacterAssetPurpose,
  canOfferCharacterAssetTerminalRejection,
  characterAssetBootstrapRequestKey,
  characterAssetDraftSelectionRequestKey,
  characterAssetReviewRequestKey,
  characterAssetRunRequestKey,
  characterAssetPurposes,
  characterAssetStudioLayoutClass,
  characterSourceVariationBlockerMessage,
  characterAssetReadinessSummary,
  isCharacterAssetApprovalActionable,
  isCharacterIdentityAuthorityReady,
  nextIncompleteCharacterAssetPurpose,
  preferredCharacterAssetRunId,
  resolveCharacterCandidateVisualState,
  resolveCharacterCustomerPreviewAssets,
  resolveCharacterAssetReviewEvidence,
  resolveCharacterAssetSubject,
} from "./character-asset-studio-authority";

// 只给 journey 投影里前端真正读的那部分；其余字段与本用例无关。
function journey(
  missingPurposes: readonly string[],
): CharacterWorkspaceDetail["journey"] {
  return {
    assetPack: {
      draft: {
        availablePurposes: characterAssetPurposes.filter(
          (purpose) => !missingPurposes.includes(purpose),
        ),
        missingPurposes,
        completed: 3 - missingPurposes.length,
        total: 3,
      },
    },
  } as unknown as CharacterWorkspaceDetail["journey"];
}

describe("Character Asset Studio flow", () => {
  it("opens a newer active Run instead of mistaking the draft-pinned Run for the review target", () => {
    const counts = {
      total: 1,
      generated: 1,
      reviewed: 0,
      approved: 0,
      placed: 0,
      failed: 0,
    };
    expect(preferredCharacterAssetRunId({
      purpose: "character_cover",
      pinnedRunId: "draft-run",
      runs: [
        {
          id: "new-review-run",
          purpose: "character_cover",
          lifecycleState: "active",
          executionOutcome: "succeeded",
          reviewState: "pending",
          counts,
        },
        {
          id: "draft-run",
          purpose: "character_cover",
          lifecycleState: "active",
          executionOutcome: "succeeded",
          reviewState: "complete",
          counts: { ...counts, reviewed: 1, approved: 1 },
        },
      ],
    })).toBe("new-review-run");
  });

  it("keeps the draft-pinned Run as the default when newer history has no remaining action", () => {
    expect(preferredCharacterAssetRunId({
      purpose: "character_cover",
      pinnedRunId: "draft-run",
      runs: [{
        id: "closed-rejected-run",
        purpose: "character_cover",
        lifecycleState: "closed",
        executionOutcome: "succeeded",
        reviewState: "complete",
        counts: {
          total: 1,
          generated: 1,
          reviewed: 1,
          approved: 0,
          placed: 0,
          failed: 0,
        },
      }],
    })).toBe("draft-run");
  });

  it("summarizes authority blockers as operator actions without leaking raw codes", () => {
    expect(characterAssetReadinessSummary([
      "visual_anchor_missing",
      "reference_set_not_active",
      "generation_route_unqualified",
    ])).toEqual({
      title: "Finish visual setup before generating",
      steps: [
        "Attach or create the portrait that defines this character",
        "Publish the approved identity references",
        "Activate a compatible platform image route",
      ],
    });
  });

  it("keeps the operator on the minimum customer-facing asset sequence", () => {
    expect(characterAssetPurposes).toEqual([
      "character_cover",
      "character_hero",
      "character_chat",
    ]);
  });

  it("never presents a partially unavailable Reference Set as locked identity authority", () => {
    expect(isCharacterIdentityAuthorityReady({
      hasIdentity: true,
      blockerCodes: ["reference_assets_unavailable"],
    })).toBe(false);
    expect(isCharacterIdentityAuthorityReady({
      hasIdentity: true,
      blockerCodes: ["generation_route_unqualified"],
    })).toBe(true);
  });

  it("keeps a low-score identity-preserving approval out of draft authority", () => {
    expect(isCharacterAssetApprovalActionable({
      bootstrapIdentity: false,
      decision: "approved",
      identityConsistency: "passed",
      score: 89,
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
    })).toBe(false);
    expect(isCharacterAssetApprovalActionable({
      bootstrapIdentity: false,
      decision: "approved",
      identityConsistency: "passed",
      score: 90,
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
    })).toBe(true);
  });

  it("explains the exact source-variation runtime blocker instead of guessing from workflow shape", () => {
    expect(characterSourceVariationBlockerMessage(
      "profile_init_image_unsupported",
    )).toContain("model profile cannot use the selected image as an init image");
    expect(characterSourceVariationBlockerMessage(
      "reference_capacity_insufficient",
    )).toContain("no remaining reference capacity");
    expect(characterSourceVariationBlockerMessage(
      "reference_slot_assignment_unsupported",
    )).toContain("distinct semantic slots");
  });

  it("offers a terminal rejection only for a reviewed approval that is no longer draft authority", () => {
    expect(canOfferCharacterAssetTerminalRejection({
      lifecycleState: "closed",
      decision: "approved",
      hasCompleteEvidence: true,
      isDraftAuthority: false,
    })).toBe(true);
    expect(canOfferCharacterAssetTerminalRejection({
      lifecycleState: "closed",
      decision: "approved",
      hasCompleteEvidence: true,
      isDraftAuthority: true,
    })).toBe(false);
    expect(canOfferCharacterAssetTerminalRejection({
      lifecycleState: "active",
      decision: "approved",
      hasCompleteEvidence: false,
      isDraftAuthority: false,
    })).toBe(false);
  });

  it("preserves the immutable approval evidence when recording its terminal rejection", () => {
    const approvedQuality = {
      artifactFree: true,
      singleSubject: true,
      intentMatch: true,
      noVisibleText: true,
    };
    expect(resolveCharacterAssetReviewEvidence({
      decision: "rejected",
      draft: {
        identityConsistency: "failed",
        score: undefined,
        quality: {
          artifactFree: false,
          singleSubject: false,
          intentMatch: false,
          noVisibleText: false,
        },
      },
      previous: {
        decision: "approved",
        identityConsistency: "passed",
        score: 96,
        quality: approvedQuality,
      },
    })).toEqual({
      identityConsistency: "passed",
      score: 96,
      quality: approvedQuality,
    });
  });

  it("keeps current, comparison, review, and draft states semantically distinct", () => {
    expect(resolveCharacterCandidateVisualState({
      active: true,
      comparison: true,
      draft: true,
      decision: "approved",
    })).toBe("active");
    expect(resolveCharacterCandidateVisualState({
      active: false,
      comparison: true,
      draft: true,
      decision: "approved",
    })).toBe("comparison");
    expect(resolveCharacterCandidateVisualState({
      active: false,
      comparison: false,
      draft: true,
      decision: "approved",
    })).toBe("draft");
    expect(resolveCharacterCandidateVisualState({
      active: false,
      comparison: false,
      draft: false,
      decision: "approved",
    })).toBe("approved");
    expect(resolveCharacterCandidateVisualState({
      active: false,
      comparison: false,
      draft: false,
      decision: "rejected",
    })).toBe("rejected");
  });

  // 失败候选此前落进 "ready" 兜底：缩略图跟成功的候选一模一样，只是没图。
  it("distinguishes a failed candidate from one that is merely undecided", () => {
    expect(resolveCharacterCandidateVisualState({
      active: false,
      comparison: false,
      draft: false,
      decision: null,
      failed: true,
    })).toBe("failed");
    expect(resolveCharacterCandidateVisualState({
      active: false,
      comparison: false,
      draft: false,
      decision: null,
      failed: false,
    })).toBe("ready");
    // 已经有人工判定的候选，判定优先于执行态。
    expect(resolveCharacterCandidateVisualState({
      active: false,
      comparison: false,
      draft: false,
      decision: "rejected",
      failed: true,
    })).toBe("rejected");
  });

  // SPEC: 「下一张该做的图」只读服务端 journey 投影，前端不再自己数 draftAssetPack。
  // INTENT: 前端那版只过滤 routeCurrent、不过滤资产可用性（软删/归属），资产被软删时
  // 服务端说缺 cover、前端却把运营带去 hero。这里盯住「读服务端答案」本身。
  it("takes the next asset from the server journey projection", () => {
    expect(nextIncompleteCharacterAssetPurpose(
      journey(["character_cover", "character_hero", "character_chat"]),
    )).toBe("character_cover");
    expect(nextIncompleteCharacterAssetPurpose(
      journey(["character_hero", "character_chat"]),
    )).toBe("character_hero");
    expect(nextIncompleteCharacterAssetPurpose(journey(["character_chat"])))
      .toBe("character_chat");
  });

  // SPEC: 图池齐了就没有「下一张图」，下一步是 Launch preview。
  // INTENT: 旧实现在图池已满时兜底返回 character_chat，于是按钮文案在封面页写「下一个资产」
  // 却什么都不缺；null 让文案与点击行为都能落到 preview。
  it("reports no next asset once the server says the pack is complete", () => {
    expect(nextIncompleteCharacterAssetPurpose(journey([]))).toBeNull();
  });

  // SPEC: 路线过期的历史选择由服务端判定为「缺」，前端不重算。
  // INTENT: 服务端 projectCurrentDraftAssetPack 已经把 routeCurrent=false 的选择排除掉，
  // 前端只要照读 —— 历史指针仍在 project.draftAssetPack 里，不因此被抹掉。
  it("treats stale route selections as recovery work because the server says so", () => {
    expect(nextIncompleteCharacterAssetPurpose(
      journey(["character_cover", "character_hero", "character_chat"]),
    )).toBe("character_cover");
  });

  it("never fills a missing hero or chat slot with the primary portrait", () => {
    expect(resolveCharacterCustomerPreviewAssets({
      activePurpose: "character_hero",
      candidateImageUrl: null,
      draftAssets: {
        character_cover: "/cover.webp",
        character_hero: null,
        character_chat: null,
      },
    })).toEqual({
      character_cover: "/cover.webp",
      character_hero: null,
      character_chat: null,
    });

    expect(resolveCharacterCustomerPreviewAssets({
      activePurpose: "character_hero",
      candidateImageUrl: "/hero-candidate.webp",
      draftAssets: {
        character_cover: "/cover.webp",
        character_hero: null,
        character_chat: "/chat.webp",
      },
    })).toEqual({
      character_cover: "/cover.webp",
      character_hero: "/hero-candidate.webp",
      character_chat: "/chat.webp",
    });
  });

  it("keeps one generation idempotency identity until the normalized request changes", () => {
    const request = {
      characterId: "character-1",
      title: "  Mira · Primary portrait  ",
      purpose: "character_cover" as const,
      profileId: "profile-1",
      referenceAssetIds: ["reference-1", "reference-2"],
      bootstrapIdentity: true,
      orientation: "4:5",
      count: 4,
      brief: "  Definitive portrait  ",
    };
    expect(characterAssetRunRequestKey(request)).toBe(
      characterAssetRunRequestKey({
        ...request,
        title: "Mira · Primary portrait",
        brief: "Definitive portrait",
      }),
    );
    const changedRequests: Parameters<typeof characterAssetRunRequestKey>[0][] = [
      { ...request, title: "Mira · Alternate portrait" },
      { ...request, purpose: "character_hero" },
      { ...request, profileId: "profile-2" },
      { ...request, referenceAssetIds: ["reference-2", "reference-1"] },
      { ...request, bootstrapIdentity: false },
      { ...request, orientation: "16:9" },
      { ...request, count: 6 },
      { ...request, brief: "Different portrait" },
    ];
    for (const changed of changedRequests) {
      expect(characterAssetRunRequestKey(changed)).not.toBe(
        characterAssetRunRequestKey(request),
      );
    }
  });

  it("pins review replay identity to the complete review authority tuple", () => {
    const request: Parameters<typeof characterAssetReviewRequestKey>[0] = {
      runId: "run-1",
      itemId: "item-1",
      body: {
        entityVersion: 3,
        supersedesDecisionId: "decision-0",
        decision: "approved",
        identityConsistency: "passed",
        score: 92,
        quality: {
          artifactFree: true,
          singleSubject: true,
          intentMatch: true,
          noVisibleText: true,
        },
        reason: "  Concrete visible evidence  ",
      },
    };
    expect(characterAssetReviewRequestKey(request)).toBe(
      characterAssetReviewRequestKey({
        ...request,
        body: {
          ...request.body,
          reason: "Concrete visible evidence",
        },
      }),
    );
    const changedRequests: Parameters<typeof characterAssetReviewRequestKey>[0][] = [
      { ...request, runId: "run-2" },
      { ...request, itemId: "item-2" },
      { ...request, body: { ...request.body, entityVersion: 4 } },
      { ...request, body: { ...request.body, supersedesDecisionId: "decision-1" } },
      { ...request, body: { ...request.body, decision: "rejected" } },
      { ...request, body: { ...request.body, identityConsistency: "failed" } },
      { ...request, body: { ...request.body, score: 91 } },
      {
        ...request,
        body: {
          ...request.body,
          quality: { ...request.body.quality, artifactFree: false },
        },
      },
      {
        ...request,
        body: {
          ...request.body,
          quality: { ...request.body.quality, singleSubject: false },
        },
      },
      {
        ...request,
        body: {
          ...request.body,
          quality: { ...request.body.quality, intentMatch: false },
        },
      },
      {
        ...request,
        body: {
          ...request.body,
          quality: { ...request.body.quality, noVisibleText: false },
        },
      },
      { ...request, body: { ...request.body, reason: "Different evidence" } },
    ];
    for (const changed of changedRequests) {
      expect(characterAssetReviewRequestKey(changed)).not.toBe(
        characterAssetReviewRequestKey(request),
      );
    }
  });

  it("pins bootstrap replay identity to Project, Run, Item, Asset, and Review authority", () => {
    const request: Parameters<typeof characterAssetBootstrapRequestKey>[0] = {
      characterId: "character-1",
      entityVersion: 7,
      runId: "run-1",
      itemId: "item-1",
      assetId: "asset-1",
      reviewDecisionId: "decision-1",
      reason: "  Establish identity version 1  ",
    };
    expect(characterAssetBootstrapRequestKey(request)).toBe(
      characterAssetBootstrapRequestKey({
        ...request,
        reason: "Establish identity version 1",
      }),
    );
    const changedRequests: Parameters<typeof characterAssetBootstrapRequestKey>[0][] = [
      { ...request, characterId: "character-2" },
      { ...request, entityVersion: 8 },
      { ...request, runId: "run-2" },
      { ...request, itemId: "item-2" },
      { ...request, assetId: "asset-2" },
      { ...request, reviewDecisionId: "decision-2" },
      { ...request, reason: "Replace the identity anchor" },
    ];
    for (const changed of changedRequests) {
      expect(characterAssetBootstrapRequestKey(changed)).not.toBe(
        characterAssetBootstrapRequestKey(request),
      );
    }
  });

  it("pins draft selection replay identity to purpose and complete selection lineage", () => {
    const request: Parameters<typeof characterAssetDraftSelectionRequestKey>[0] = {
      characterId: "character-1",
      body: {
        entityVersion: 7,
        purpose: "character_hero",
        runId: "run-1",
        itemId: "item-1",
        assetId: "asset-1",
        reviewDecisionId: "decision-1",
        reason: "  Select the reviewed hero  ",
      },
    };
    expect(characterAssetDraftSelectionRequestKey(request)).toBe(
      characterAssetDraftSelectionRequestKey({
        ...request,
        body: {
          ...request.body,
          reason: "Select the reviewed hero",
        },
      }),
    );
    const changedRequests: Parameters<typeof characterAssetDraftSelectionRequestKey>[0][] = [
      { ...request, characterId: "character-2" },
      { ...request, body: { ...request.body, entityVersion: 8 } },
      { ...request, body: { ...request.body, purpose: "character_chat" } },
      { ...request, body: { ...request.body, runId: "run-2" } },
      { ...request, body: { ...request.body, itemId: "item-2" } },
      { ...request, body: { ...request.body, assetId: "asset-2" } },
      { ...request, body: { ...request.body, reviewDecisionId: "decision-2" } },
      { ...request, body: { ...request.body, reason: "Select another hero" } },
    ];
    for (const changed of changedRequests) {
      expect(characterAssetDraftSelectionRequestKey(changed)).not.toBe(
        characterAssetDraftSelectionRequestKey(request),
      );
    }
  });

  it("allows the committed bootstrap action to advance directly to the hero step", () => {
    expect(canChooseCharacterAssetPurpose("character_hero", true)).toBe(false);
    expect(canChooseCharacterAssetPurpose("character_hero", true, true)).toBe(true);
    expect(canChooseCharacterAssetPurpose("character_chat", false)).toBe(true);
  });

  it("uses the current Project draft as the generation subject before a Release changes live fields", () => {
    expect(resolveCharacterAssetSubject({
      liveName: "Untitled companion",
      liveDescription: "Legacy live description",
      draftName: "Mira Vale",
      draftDescription: "Current reviewed Project promise",
    })).toEqual({
      name: "Mira Vale",
      description: "Current reviewed Project promise",
    });
    expect(resolveCharacterAssetSubject({
      liveName: "Published Mira",
      liveDescription: "Published description",
      draftName: " ",
      draftDescription: null,
    })).toEqual({
      name: "Published Mira",
      description: "Published description",
    });
  });

  it("keeps the batch dominant and adds a sticky decision inspector only on wide screens", () => {
    expect(characterAssetStudioLayoutClass).toContain(
      "xl:grid-cols-[minmax(0,1fr)_380px]",
    );
    expect(characterAssetStudioLayoutClass).not.toContain("250px");
  });

  it("does not invent an opening message when the draft has none", () => {
    const source = readFileSync(new URL("./CharacterAssetStudio.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("I was hoping you would stop by.");
  });

  it("keeps a committed selection locked in the shared Project mutation coordinator", () => {
    const source = readFileSync(new URL("./CharacterAssetStudio.tsx", import.meta.url), "utf8");
    const selectionStart = source.indexOf("const approveAndContinue");
    const selectionFlow = source.slice(
      selectionStart,
      source.indexOf("if (!permissions.read)", selectionStart),
    );
    const coordinatorIndex = selectionFlow.indexOf("await commitProjectMutation({");
    const afterRefreshIndex = selectionFlow.indexOf("afterRefresh:");
    const committedIntentCount = selectionFlow.match(
      /committedIntent = updateDurableMutationIntent\(intent, \{/g,
    )?.length ?? 0;

    expect(coordinatorIndex).toBeGreaterThan(-1);
    expect(selectionFlow).toContain("commit: async () =>");
    expect(afterRefreshIndex).toBeGreaterThan(coordinatorIndex);
    expect(committedIntentCount).toBe(2);
    expect(source).toContain(
      "clearDurableMutationIntent(selectionMutationIntent)",
    );
    expect(source).toContain(
      "selection.reviewDecisionId ===",
    );
    const afterRefreshFlow = selectionFlow.slice(
      afterRefreshIndex,
      selectionFlow.indexOf("      });", afterRefreshIndex),
    );
    expect(afterRefreshFlow).not.toContain(
      "clearDurableMutationIntent",
    );
    expect(selectionFlow).not.toContain("await onProjectReload()");
  });

  it("keeps generation and review commands replayable until their projections refresh", () => {
    const source = readFileSync(new URL("./CharacterAssetStudio.tsx", import.meta.url), "utf8");
    const createFlow = source.slice(
      source.indexOf("const createRun = async"),
      source.indexOf("const refreshWorkspace"),
    );
    const reviewFlow = source.slice(
      source.indexOf("const verifyReviewIntentProjection"),
      source.indexOf("const approveAndContinue"),
    );
    const createCommitIndex = createFlow.indexOf(
      "updateRunCreationIntentState(committed)",
    );
    const createSelectionIndex = createFlow.indexOf(
      "selectRunId(result.batch.id)",
      createCommitIndex,
    );
    const createListReloadIndex = createFlow.indexOf(
      "preserveSelectedRunId: result.batch.id",
      createSelectionIndex,
    );
    const reviewReloadIndex = reviewFlow.indexOf(
      "const detail = await loadRun(snapshot.runId)",
    );
    const reviewListReloadIndex = reviewFlow.indexOf(
      "await loadRuns({",
      reviewReloadIndex,
    );
    const reviewKeyReleaseIndex = reviewFlow.indexOf(
      "clearDurableMutationIntent(intent)",
    );

    expect(createCommitIndex).toBeGreaterThan(-1);
    expect(createSelectionIndex).toBeGreaterThan(createCommitIndex);
    expect(createListReloadIndex).toBeGreaterThan(createSelectionIndex);
    expect(createFlow).not.toContain(
      "clearDurableMutationIntent(committed)",
    );
    expect(reviewReloadIndex).toBeGreaterThan(-1);
    expect(reviewListReloadIndex).toBeGreaterThan(reviewReloadIndex);
    expect(reviewKeyReleaseIndex).toBeGreaterThan(reviewListReloadIndex);
    expect(createFlow).toContain("Choose Verify created Run to retry safely");
    expect(reviewFlow).toContain(
      "item.review?.id === intent.committedTargetId",
    );
  });

  it("binds review and selection replay identities to the canonical request body", () => {
    const source = readFileSync(new URL("./CharacterAssetStudio.tsx", import.meta.url), "utf8");

    expect(source).toContain("characterAssetReviewRequestKey({");
    expect(source).toContain("characterAssetBootstrapRequestKey({");
    expect(source).toContain("characterAssetDraftSelectionRequestKey({");
  });

  // INTENT: "取代即取消" 与 "投影确认之后才释放幂等键" 原本靠断言 loadRun 里的源码文本
  //         与语句先后来守，那锁的是实现文本不是行为。这段协议现在有名字了
  //         （lib/committed-projection），两条不变量由 committed-projection.test.ts
  //         驱动在途去重表与两道闸门真正验证，故此处只留组件自己仍然负责的部分。
  it("aborts in-flight projection reads and keeps the run list gated", () => {
    const source = readFileSync(new URL("./CharacterAssetStudio.tsx", import.meta.url), "utf8");

    expect(source).toContain("createLatestRequestGate");
    expect(source).toContain("new AbortController()");
    expect(source).toContain("controller.abort()");
  });

  // INTENT: "被取代的轮询不得留下粘滞告警"原本靠断言源码里两行文本的先后顺序来守，
  //         那锁的是实现文本不是行为。同一条不变量已由 CharacterAssetStudio.mounted
  //         .test.tsx 的 "keeps a committed refresh usable when polling supersedes its
  //         projection requests" 真正驱动 4s 轮询定时器验证，故此处不再重复。
});
