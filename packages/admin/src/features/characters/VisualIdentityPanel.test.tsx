import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  referenceIdsRemovedFromPublishedSet,
  requiresReviewedIdentityBootstrap,
  uniqueAvailableVisualAssets,
  VisualIdentityPanel,
  type VisualIdentityPanelData,
} from "./CharacterWorkspace";

const data = {
  character: {
    id: "character-1",
    name: "Mira",
    style: "realistic",
    imageUrl: null,
  },
  visual: {
    activeIdentity: {
      id: "identity-2",
      version: 2,
      status: "active",
      style: "realistic",
      identityPrompt: "same adult character",
      negativeIdentityPrompt: null,
      traits: { face: {}, hair: {}, body: {}, signature: {}, style: {} },
      immutableHash: "identity-hash",
      evidenceState: "candidate",
      defaultSeed: "42",
      anchorAssetIds: ["anchor-1"],
      createdFrom: "admin_passport_edit",
      createdAt: "2026-07-12T12:00:00.000Z",
    },
    anchors: [
      {
        mediaAssetId: "anchor-1",
        role: "identity_anchor",
        available: true,
        url: "/anchor.webp",
        thumbnailUrl: null,
        qualityScore: null,
        identityScore: null,
      },
    ],
    references: [],
    videoSources: [],
    activeReferenceSet: null,
    looks: [
      {
        id: "look-1",
        ownerId: "owner-1",
        label: "Evening Look",
        status: "active",
        visualProfileId: "identity-2",
        referenceAssetId: "anchor-1",
        rebasedFromLookId: null,
        updatedAt: "2026-07-12T12:00:00.000Z",
      },
    ],
    routeQualifications: [
      {
        id: "qualification-1",
        routeFingerprint: "fingerprint",
        generationProfileKey: "portrait",
        generationProfileVersion: 3,
        workflowKey: "identity",
        workflowVersion: 2,
        style: "realistic",
        matrixKey: "realistic-default-v1",
        sampleCount: 40,
        passCount: 38,
        identityMatch: 0.94,
        result: "qualified",
        evidence: { batchIds: ["batch-1"] },
        policyVersion: "character-release-policy-v2",
        evaluatedAt: "2026-07-12T12:00:00.000Z",
        expiresAt: null,
        stale: false,
      },
    ],
    routeEvaluation: {
      ready: true,
      blocker: null,
      sampleMinimum: 40,
      evaluatorVersion: "identity-match-v1",
      profiles: [
        {
          profileKey: "portrait",
          profileVersion: 3,
          label: "Portrait identity route",
          workflowKey: "identity",
          workflowVersion: 2,
          orientation: "4:5",
          recommended: true,
        },
      ],
    },
    identityCalibration: {
      blocker: null,
      profiles: [
        {
          profileKey: "portrait",
          profileVersion: 3,
          label: "Portrait calibration route",
          modelId: "redcraft-krea2-redmix3-fp8",
          workflowKey: "identity",
          workflowVersion: 2,
          orientation: "4:5",
          allowedOrientations: ["1:1", "4:5"],
          modes: ["text_to_image", "image_to_image"],
          recommended: true,
        },
      ],
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
      blockers: [
        {
          code: "reference_set_not_active",
          message: "No active Reference Set revision is pinned.",
          // 服务端 workspace 投影下发的是带页内锚点的完整 deepLink（visualBlockerDeepLink）。
          deepLink: "/admin/characters/character-1?tab=visual#visual-reference-set",
        },
      ],
      productionDeepLink: "/admin/characters/character-1?tab=assets",
    },
  },
} satisfies VisualIdentityPanelData;

const runCommittedMutation = async <T,>(input: {
  action: string;
  commit: () => Promise<T>;
  afterRefresh?: () => void;
}) => {
  const result = await input.commit();
  input.afterRefresh?.();
  return { result, refreshed: true };
};

describe("Visual Identity operator workbench", () => {
  it("offers each available asset once when an anchor is also a published reference", () => {
    expect(
      uniqueAvailableVisualAssets([
        { mediaAssetId: "asset-1", available: true, role: "identity_anchor" },
        { mediaAssetId: "asset-1", available: true, role: "primary_face" },
        { mediaAssetId: "asset-2", available: false, role: "secondary" },
      ]),
    ).toEqual([
      { mediaAssetId: "asset-1", available: true, role: "identity_anchor" },
    ]);
  });

  it("makes the exact references removed by the next published revision explicit", () => {
    expect(
      referenceIdsRemovedFromPublishedSet(
        ["anchor-1", "reference-2", "reference-3"],
        ["anchor-1", "reference-3"],
      ),
    ).toEqual(["reference-2"]);
  });

  it("renders identity, references, and a single-image production route with actionable blockers", () => {
    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        data={data}
        permissions={{ writeVisual: true, evaluateRoute: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    expect(html).toContain("Visual Identity authority");
    expect(html).toContain("视觉身份");
    expect(html).toContain("想让 Mira 变成什么样");
    expect(html).toContain("高级设置");
    expect(html).toContain("负向提示词");
    expect(html).toContain("锁定种子");
    expect(html).toContain("历史创作");
    expect(html).toContain("打开任意图片");
    expect(html).toContain("正式身份与生产设置");
    expect(html).toContain("Publish the approved identity references");
    // 服务端下发的 deepLink 原样透传，前端不再自建 code→锚点映射。
    expect(html).toContain(
      'href="/admin/characters/character-1?tab=visual#visual-reference-set"',
    );
    expect(html).toContain("reference_set_not_active");
    expect(html.match(/>Resolve</g)).toHaveLength(1);
    expect(html).not.toContain("Resolve blocker");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Open role image production");
    expect(html).toContain("Publish Reference Set");
    expect(html).toContain("Character Looks using role images");
    expect(html).toContain("Evening Look");
    expect(html).toContain("Archive Look");
    expect(html).toContain("Unchecked images leave runtime authority");
    expect(html).toContain("One image at a time");
    expect(html).toContain("Every generation creates one candidate");
    expect(html).toContain("Advanced identity controls");
    expect(html).toContain("Image generation route");
    expect(html).toContain("portrait");
    expect(html).toContain("Operators create and review one image at a time");
    expect(html).not.toContain("Generate 40 route test images");
    expect(html).not.toContain("Batch IDs");
    expect(html.indexOf("视觉身份")).toBeLessThan(
      html.indexOf("正式身份与生产设置"),
    );
  });

  it("opens formal production settings for every blocked image-production state", () => {
    const blockedHtml = renderToStaticMarkup(
      <VisualIdentityPanel
        data={data}
        permissions={{ writeVisual: true, evaluateRoute: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    const blockedSummary = blockedHtml.indexOf("正式身份与生产设置");
    expect(
      blockedHtml.slice(Math.max(0, blockedSummary - 260), blockedSummary),
    ).toContain('open=""');

    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        data={{
          ...data,
          visual: {
            ...data.visual,
            imageReadiness: {
              state: "route_pending",
              fingerprint: "a".repeat(64),
              steps: {
                identity: "complete",
                references: "complete",
                route: "platform_pending",
              },
              repair: null,
              nextDeepLink:
                "/admin/characters/character-1?tab=visual#route-qualification-workbench",
            },
          },
        }}
        permissions={{ writeVisual: true, evaluateRoute: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    const productionSettingsSummary = html.indexOf("正式身份与生产设置");

    expect(productionSettingsSummary).toBeGreaterThan(0);
    expect(
      html.slice(
        Math.max(0, productionSettingsSummary - 220),
        productionSettingsSummary,
      ),
    ).toContain('open=""');
  });

  it("fails writes closed when the matching effective grants are absent", () => {
    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        data={data}
        permissions={{ writeVisual: false, evaluateRoute: false }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    expect(html).toContain("content.official.write is not granted");
    expect(html).toMatch(/disabled=""[^>]*>Create &amp; activate version/);
    expect(html).toMatch(/disabled=""[^>]*>Publish Reference Set/);
  });

  it("routes an unanchored legacy identity back to reviewed Asset bootstrap", () => {
    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        data={{
          ...data,
          visual: {
            ...data.visual,
            anchors: [],
            references: [],
            identityBootstrap: {
              state: "recoverable_empty_history",
              allowed: true,
              nextIdentityVersion: 3,
              blockers: [],
              profile: {
                profileKey: "bootstrap-profile",
                profileVersion: 1,
                label: "Bootstrap portrait",
                workflowKey: "bootstrap-workflow",
                workflowVersion: 1,
                orientation: "4:5",
              },
            },
          },
        }}
        navigateToTab={() => undefined}
        permissions={{ writeVisual: true, evaluateRoute: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );

    expect(html).toContain(
      "Establish a reviewed portrait anchor in Character Assets",
    );
    expect(html).toContain("Open Character Assets");
    expect(html).toMatch(/disabled=""[^>]*>Create &amp; activate version/);
  });

  it("lets an existing Character image repair an unanchored legacy profile", () => {
    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        data={{
          ...data,
          character: { ...data.character, imageUrl: "/legacy-character.webp" },
          visual: {
            ...data.visual,
            anchors: [],
            references: [],
            identityBootstrap: {
              state: "blocked_existing_authority",
              allowed: false,
              nextIdentityVersion: 2,
              blockers: ["character_image_already_selected"],
              profile: null,
            },
          },
        }}
        permissions={{ writeVisual: true, evaluateRoute: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );

    expect(html).toContain("current Character image is available");
    expect(html).not.toContain(
      "Establish a reviewed portrait anchor in Character Assets",
    );
    expect(
      requiresReviewedIdentityBootstrap({
        hasActiveIdentity: true,
        hasCurrentCharacterImage: true,
        availableReferenceCount: 0,
        hasActiveReferenceSet: false,
      }),
    ).toBe(false);
    expect(
      requiresReviewedIdentityBootstrap({
        hasActiveIdentity: true,
        hasCurrentCharacterImage: false,
        availableReferenceCount: 0,
        hasActiveReferenceSet: false,
      }),
    ).toBe(true);
  });
});
