import { describe, expect, it } from "vitest";
import {
  characterIdentityCalibrationProfileSchema,
  characterIdentityBootstrapRequestSchema,
  characterIdentityBootstrapResponseSchema,
  characterPreviewSnapshotSchema,
  characterReferenceSetPublishRequestSchema,
  characterRouteQualificationEvidenceSchema,
  characterVisualProfileCreateRequestSchema,
  characterVisualWorkspaceSchema,
  characterWorkspaceProjectSchema,
} from "./characters";

describe("Character Visual workspace contract", () => {
  it("exposes the concrete model behind an identity calibration profile", () => {
    const profile = characterIdentityCalibrationProfileSchema.parse({
      profileKey: "profile_image_default_v1",
      profileVersion: 1,
      label: "Default image",
      modelId: "redcraft-krea2-redmix3-fp8",
      workflowKey: "redcraft-krea2-redmix3-txt2img",
      workflowVersion: 1,
      orientation: "4:5",
      allowedOrientations: ["1:1", "4:5"],
      modes: ["text_to_image"],
      recommended: true,
    });

    expect(profile.modelId).toBe("redcraft-krea2-redmix3-fp8");
  });

  it("requires an explicit identity prompt when activating a reviewed candidate", () => {
    const candidateAuthority = {
      runId: "run-1",
      itemId: "item-1",
      assetId: "asset-1",
      reviewDecisionId: "decision-1",
    };
    expect(characterVisualProfileCreateRequestSchema.safeParse({
      candidateAuthority,
      reason: "Activate reviewed candidate",
      confirmation: "character-1:visual-profile",
    }).success).toBe(false);
    expect(characterVisualProfileCreateRequestSchema.safeParse({
      identityPrompt: "Preserve the exact person shown in the canonical portrait.",
      faceTraits: {
        canonicalPortraitAuthority: true,
        stableTraits: ["oval face", "blue eyes"],
      },
      hairTraits: { stableTraits: ["dark wavy hair"] },
      bodyTraits: { stableTraits: ["balanced adult proportions"] },
      candidateAuthority,
      reason: "Activate reviewed candidate",
      confirmation: "character-1:visual-profile",
    }).success).toBe(true);
  });

  it("keeps selection, published references, qualification evidence and readiness distinct", () => {
    const result = characterVisualWorkspaceSchema.parse({
      activeIdentity: {
        id: "identity-1", version: 2, status: "active", style: "realistic",
        identityPrompt: "same adult character", negativeIdentityPrompt: null,
        traits: { face: {}, hair: {}, body: {}, signature: {}, style: {} },
        immutableHash: "identity-hash", evidenceState: "candidate", defaultSeed: null,
        anchorAssetIds: ["asset-anchor"],
        createdFrom: "admin_passport_edit", createdAt: "2026-07-12T12:00:00.000Z",
      },
      anchors: [{ mediaAssetId: "asset-anchor", role: "identity_anchor", available: true, url: "/anchor.webp", thumbnailUrl: null, qualityScore: null, identityScore: null }],
      references: [],
      videoSources: [],
      activeReferenceSet: null,
      routeQualifications: [],
      routeEvaluation: {
        ready: false,
        blocker: "Publish a sealed Reference Set before evaluating an image route.",
        sampleMinimum: 40,
        evaluatorVersion: "identity-match-v1",
        profiles: [],
      },
      identityBootstrap: {
        state: "blocked_existing_authority",
        allowed: false,
        nextIdentityVersion: 3,
        blockers: ["grounded_or_unknown_identity_history_exists"],
        profile: null,
      },
      readiness: {
        ready: false,
        qualificationPolicyVersion: "character-release-policy-v2",
        blockers: [{ code: "reference_set_not_active", message: "No active Reference Set revision is pinned.", deepLink: "/admin/characters/character-1?tab=visual" }],
        productionDeepLink: "/admin/characters/character-1?tab=assets",
      },
    });
    expect(result.activeIdentity?.version).toBe(2);
    expect(result.readiness.ready).toBe(false);
  });

  it("rejects a readiness claim without explicit evidence collections", () => {
    expect(characterVisualWorkspaceSchema.safeParse({ readiness: { ready: true, qualificationPolicyVersion: "v2", blockers: [], productionDeepLink: "/admin/content/production" } }).success).toBe(false);
  });

  it("requires an explicit immutable Reference Set publication command", () => {
    expect(characterReferenceSetPublishRequestSchema.parse({
      visualProfileId: "identity-1",
      expectedActiveReferenceSetRevisionId: null,
      expectedActiveReferenceSetRevision: 0,
      selectorVersion: "admin-visual-workbench-v1",
      references: [{ mediaAssetId: "asset-anchor", role: "identity_anchor", weight: 1 }],
      reason: { code: "reference_snapshot_publish", summary: "Seal reviewed identity references" },
      confirmation: "PUBLISH REFERENCES character-1",
    }).references).toHaveLength(1);
  });

  it("rejects contradictory active Reference Set compare-and-swap authority", () => {
    const command = {
      visualProfileId: "identity-1",
      selectorVersion: "admin-visual-workbench-v1",
      references: [{
        mediaAssetId: "asset-anchor",
        role: "identity_anchor",
        weight: 1,
      }],
      reason: {
        code: "reference_snapshot_publish",
        summary: "Seal reviewed identity references",
      },
      confirmation: "PUBLISH REFERENCES character-1",
    };
    expect(characterReferenceSetPublishRequestSchema.safeParse({
      ...command,
      expectedActiveReferenceSetRevisionId: null,
      expectedActiveReferenceSetRevision: 2,
    }).success).toBe(false);
    expect(characterReferenceSetPublishRequestSchema.safeParse({
      ...command,
      expectedActiveReferenceSetRevisionId: "reference-set-1",
      expectedActiveReferenceSetRevision: 0,
    }).success).toBe(false);
    expect(characterReferenceSetPublishRequestSchema.safeParse({
      ...command,
      expectedActiveReferenceSetRevisionId: "reference-set-1",
      expectedActiveReferenceSetRevision: 2,
    }).success).toBe(true);
  });

  it("defines one atomic command for turning an approved first portrait into identity authority", () => {
    expect(characterIdentityBootstrapRequestSchema.parse({
      entityVersion: 1,
      runId: "run-1",
      itemId: "item-1",
      assetId: "asset-anchor",
      reviewDecisionId: "decision-1",
      reason: "Establish the first reviewed portrait as the Character identity anchor",
      confirmation: "BOOTSTRAP IDENTITY character-1",
    })).toMatchObject({
      entityVersion: 1,
      assetId: "asset-anchor",
    });
    expect(characterIdentityBootstrapResponseSchema.parse({
      characterId: "character-1",
      projectVersion: 2,
      visualProfileId: "visual-profile-1",
      visualProfileVersion: 1,
      referenceSetRevisionId: "reference-set-1",
      referenceSetRevision: 1,
      anchorAssetId: "asset-anchor",
      draftImageAssetId: "asset-anchor",
      deepLink: "/admin/characters/character-1?tab=assets",
      replayed: false,
    }).referenceSetRevision).toBe(1);
  });

  it("exposes the exact text-to-image profile used before identity exists", () => {
    const result = characterVisualWorkspaceSchema.parse({
      activeIdentity: null,
      anchors: [],
      references: [],
      videoSources: [],
      activeReferenceSet: null,
      routeQualifications: [],
      routeEvaluation: {
        ready: false,
        blocker: "Create and seal a Visual Identity before evaluating an image route.",
        sampleMinimum: 40,
        evaluatorVersion: "identity-match-v1",
        profiles: [],
      },
      identityBootstrap: {
        state: "new",
        allowed: true,
        nextIdentityVersion: 1,
        blockers: [],
        profile: {
          profileKey: "redcraft-krea2",
          profileVersion: 1,
          label: "RedCraft Krea 2",
          workflowKey: "redcraft-krea2-redmix3-txt2img",
          workflowVersion: 1,
          orientation: "4:5",
        },
      },
      readiness: {
        ready: false,
        qualificationPolicyVersion: "character-release-policy-v2",
        blockers: [{
          code: "visual_identity_missing",
          message: "No active Visual Identity version exists.",
          deepLink: "/admin/characters/character-1?tab=visual",
        }],
        productionDeepLink: "/admin/characters/character-1?tab=assets",
      },
    });
    expect(result.identityBootstrap.profile?.workflowKey).toBe("redcraft-krea2-redmix3-txt2img");
  });

  it("keeps bootstrap authority visible when no compatible profile is configured", () => {
    const result = characterVisualWorkspaceSchema.parse({
      activeIdentity: null,
      anchors: [],
      references: [],
      videoSources: [],
      activeReferenceSet: null,
      routeQualifications: [],
      routeEvaluation: {
        ready: false,
        blocker: "Create and seal a Visual Identity before evaluating an image route.",
        sampleMinimum: 40,
        evaluatorVersion: "identity-match-v1",
        profiles: [],
      },
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
        blockers: [{
          code: "visual_identity_missing",
          message: "No active Visual Identity version exists.",
          deepLink: "/admin/characters/character-1?tab=visual",
        }],
        productionDeepLink: "/admin/characters/character-1?tab=assets",
      },
    });
    expect(result.identityBootstrap).toMatchObject({
      state: "new",
      allowed: true,
      profile: null,
    });
  });

  it("keeps profile and source-variation runtime truth attached to the exact qualified route", () => {
    const route = characterRouteQualificationEvidenceSchema.parse({
      id: "qualification-1",
      routeFingerprint: "route-fingerprint-1",
      generationProfileKey: "profile-1",
      generationProfileVersion: 1,
      workflowKey: "source-identity-workflow",
      workflowVersion: 1,
      style: "realistic",
      matrixKey: "matrix-1",
      sampleCount: 40,
      passCount: 40,
      identityMatch: 0.96,
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
        routeFingerprint: "route-fingerprint-1",
        ready: false,
        blocker: "profile_init_image_unsupported",
      },
    });
    expect(route.sourceVariationAuthority).toEqual({
      routeFingerprint: "route-fingerprint-1",
      ready: false,
      blocker: "profile_init_image_unsupported",
    });
  });

  it("rejects source-variation readiness claimed for another route fingerprint", () => {
    expect(characterRouteQualificationEvidenceSchema.safeParse({
      id: "qualification-1",
      routeFingerprint: "route-fingerprint-1",
      generationProfileKey: "profile-1",
      generationProfileVersion: 1,
      workflowKey: "source-identity-workflow",
      workflowVersion: 1,
      style: "realistic",
      matrixKey: "matrix-1",
      sampleCount: 40,
      passCount: 40,
      identityMatch: 0.96,
      result: "qualified",
      evidence: {},
      policyVersion: "character-release-policy-v2",
      evaluatedAt: "2026-07-16T12:00:00.000Z",
      expiresAt: null,
      stale: false,
      sourceVariationAuthority: {
        routeFingerprint: "route-fingerprint-2",
        ready: true,
        blocker: null,
      },
    }).success).toBe(false);
  });

  it("projects exact draft-pack route authority without erasing historical selections", () => {
    const result = characterWorkspaceProjectSchema.parse({
      id: "project-1",
      characterId: "character-1",
      ownerId: "operator-1",
      phase: "producing",
      audience: "",
      companionNeed: "",
      hypothesis: "",
      differentiation: "",
      targetPlacementKeys: [],
      successCriteria: [],
      productionPackage: "",
      qaPlan: "",
      draftImageAssetId: "cover-q1",
      draftAssetPackHash: "pack-hash",
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
      },
      draftAssetRouteAuthority: {
        status: "stale",
        currentRouteFingerprint: "route-q2",
        stalePurposes: ["character_cover", "character_hero", "character_chat"],
        missingPurposes: [],
        recoveryPurpose: "character_cover",
        qaReady: false,
        qaBlockers: ["draft_asset_generation_route_stale"],
      },
      plannedLaunchAt: null,
      version: 4,
      updatedAt: "2026-07-16T12:00:00.000Z",
    });
    expect(result.draftAssetRouteAuthority).toEqual({
      status: "stale",
      currentRouteFingerprint: "route-q2",
      stalePurposes: ["character_cover", "character_hero", "character_chat"],
      missingPurposes: [],
      recoveryPurpose: "character_cover",
      qaReady: false,
      qaBlockers: ["draft_asset_generation_route_stale"],
    });
    expect(result.draftAssetPack.character_cover).toBe("cover-q1");
  });

  it("keeps all three preview slots explicit instead of aliasing the portrait", () => {
    const result = characterPreviewSnapshotSchema.parse({
      releaseId: null,
      contentVersionId: "content-1",
      label: "Draft Preview",
      name: "Mira",
      description: "A precise evening companion.",
      persona: {},
      opening: {},
      appearance: {},
      imageUrl: "/cover.webp",
      assetPack: {
        character_cover: {
          assetId: "cover-1",
          imageUrl: "/cover.webp",
          status: "available",
        },
        character_hero: {
          assetId: null,
          imageUrl: null,
          status: "missing",
        },
        character_chat: {
          assetId: "chat-1",
          imageUrl: null,
          status: "unavailable",
        },
      },
      assetPackReady: false,
      renderUrl: null,
    });
    expect(result.assetPack.character_hero.status).toBe("missing");
    expect(result.assetPack.character_hero.imageUrl).toBeNull();
    expect(result.assetPackReady).toBe(false);
  });

  it("rejects a ready preview claim backed by one aliased portrait", () => {
    expect(characterPreviewSnapshotSchema.safeParse({
      releaseId: null,
      contentVersionId: "content-1",
      label: "Draft Preview",
      name: "Mira",
      description: "A precise evening companion.",
      persona: {},
      opening: {},
      appearance: {},
      imageUrl: "/portrait.webp",
      assetPack: {
        character_cover: {
          assetId: "portrait-1",
          imageUrl: "/portrait.webp",
          status: "available",
        },
        character_hero: {
          assetId: "portrait-1",
          imageUrl: "/portrait.webp",
          status: "available",
        },
        character_chat: {
          assetId: "portrait-1",
          imageUrl: "/portrait.webp",
          status: "available",
        },
      },
      assetPackReady: true,
      renderUrl: "http://localhost/internal-preview/characters/token",
    }).success).toBe(false);
  });
});
