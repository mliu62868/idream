import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  referenceIdsRemovedFromPublishedSet,
  requiresReviewedIdentityBootstrap,
  uniqueAvailableVisualAssets,
  VisualIdentityPanel,
  type VisualIdentityPanelData,
} from "./VisualIdentityPanel";

import { characterWorkspaceDetail } from "./character-workspace-fixture";

const data = {
  journey: characterWorkspaceDetail().journey,
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
        permissions={{ writeVisual: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    expect(html).toContain("Visual Identity authority");
    expect(html).toContain("Visual identity");
    expect(html).toContain("What should Mira look like?");
    expect(html).toContain("Advanced settings");
    expect(html).toContain("Negative prompt");
    expect(html).toContain("Locked seed");
    expect(html).toContain("Creation history");
    expect(html).toContain("Open any image");
    expect(html).toContain("Diagnostics and advanced settings");
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
    // 「用户保存的造型」与更换身份的「更换形象」是两个实体，名字不能再撞。
    expect(html).toContain("Customer saved looks using role images");
    expect(html).toContain("Change appearance (new identity)");
    expect(html).not.toContain(">Change look<");
    expect(html).toContain("Evening Look");
    expect(html).toContain("Archive Look");
    expect(html).toContain("Unchecked images leave runtime authority");
    expect(html).toContain("One image at a time");
    expect(html).toContain("Each generation creates one image");
    expect(html).toContain("Advanced identity controls");
    expect(html).toContain("Image generation route");
    expect(html).toContain("portrait");
    expect(html).toContain("Generate one image at a time, compare results, and choose what to use");
    expect(html).not.toContain("Generate 40 route test images");
    expect(html).not.toContain("Batch IDs");
    expect(html.indexOf("Visual identity")).toBeLessThan(
      html.indexOf("Diagnostics and advanced settings"),
    );
  });

  // SPEC: 诊断默认折叠；未就绪时只给一行状态和展开入口，深链 / hash 指向折叠区内锚点时自动展开。
  it("keeps diagnostics folded behind a one-line status unless a deep link targets them", () => {
    const blockedHtml = renderToStaticMarkup(
      <VisualIdentityPanel
        data={data}
        permissions={{ writeVisual: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    const blockedSummary = blockedHtml.indexOf("Diagnostics and advanced settings");
    expect(
      blockedHtml.slice(Math.max(0, blockedSummary - 260), blockedSummary),
    ).not.toContain('open=""');
    expect(blockedHtml).toContain('data-testid="visual-readiness-summary"');
    expect(blockedHtml).toContain(
      "Not ready for image production · Next: Publish the approved identity references",
    );
    expect(blockedHtml).toContain("Show details and fix");

    for (const hash of [
      "#visual-production-readiness",
      "#visual-reference-set",
      "#route-qualification-workbench",
      "#visual-identity-version",
    ]) {
      const html = renderToStaticMarkup(
        <VisualIdentityPanel
          data={data}
          locationHash={hash}
          permissions={{ writeVisual: true }}
          runCommittedMutation={runCommittedMutation}
        />,
      );
      const productionSettingsSummary = html.indexOf("Diagnostics and advanced settings");
      expect(productionSettingsSummary, hash).toBeGreaterThan(0);
      expect(
        html.slice(Math.max(0, productionSettingsSummary - 220), productionSettingsSummary),
        hash,
      ).toContain('open=""');
      expect(html, hash).not.toContain('data-testid="visual-readiness-summary"');
    }

    const ready = renderToStaticMarkup(
      <VisualIdentityPanel
        data={{
          ...data,
          visual: { ...data.visual, readiness: { ...data.visual.readiness, ready: true, blockers: [] } },
        }}
        permissions={{ writeVisual: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    expect(ready).not.toContain('data-testid="visual-readiness-summary"');
  });

  // SPEC: 首次建立身份只有 Images 一个入口；没有身份时不挂「更换形象」工作台。
  it("points a character without an identity to the first portrait in Images", () => {
    const navigated: string[] = [];
    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        data={{ ...data, visual: { ...data.visual, activeIdentity: null } }}
        navigateToTab={(tab) => navigated.push(tab)}
        permissions={{ writeVisual: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );
    expect(html).not.toContain('data-testid="change-look"');
    expect(html).not.toContain("What should Mira look like?");
    expect(html).toContain('data-testid="first-identity-entry"');
    expect(html).toContain("Create first identity portrait");
  });

  it("fails writes closed when the matching effective grants are absent", () => {
    const html = renderToStaticMarkup(
      <VisualIdentityPanel
        data={data}
        permissions={{ writeVisual: false }}
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
        permissions={{ writeVisual: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );

    expect(html).toContain(
      "Choose the first identity portrait in the image library",
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
        permissions={{ writeVisual: true }}
        runCommittedMutation={runCommittedMutation}
      />,
    );

    expect(html).toContain("current Character image is available");
    expect(html).not.toContain(
      "Choose the first identity portrait in the image library",
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
