import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VisualIdentityPanel, type VisualIdentityPanelData } from "./CharacterWorkspace";

const data = {
  character: { id: "character-1", style: "realistic" },
  visual: {
    activeIdentity: {
      id: "identity-2", version: 2, status: "active", style: "realistic",
      identityPrompt: "same adult character", negativeIdentityPrompt: null,
      traits: { face: {}, hair: {}, body: {}, signature: {}, style: {} },
      immutableHash: "identity-hash", evidenceState: "candidate", defaultSeed: "42",
      createdFrom: "admin_passport_edit", createdAt: "2026-07-12T12:00:00.000Z",
    },
    anchors: [{ mediaAssetId: "anchor-1", role: "identity_anchor", available: true, url: "/anchor.webp", thumbnailUrl: null, qualityScore: null, identityScore: null }],
    references: [],
    activeReferenceSet: null,
    routeQualifications: [{
      id: "qualification-1", routeFingerprint: "fingerprint", generationProfileKey: "portrait", generationProfileVersion: 3,
      workflowKey: "identity", workflowVersion: 2, style: "realistic", matrixKey: "realistic-default-v1",
      sampleCount: 40, passCount: 38, identityMatch: 0.94, result: "qualified", evidence: { batchIds: ["batch-1"] },
      policyVersion: "character-release-policy-v2", evaluatedAt: "2026-07-12T12:00:00.000Z", expiresAt: null, stale: false,
    }],
    readiness: {
      ready: false,
      qualificationPolicyVersion: "character-release-policy-v2",
      blockers: [{ code: "reference_set_not_active", message: "No active Reference Set revision is pinned.", deepLink: "/admin/characters/character-1?tab=visual" }],
      productionDeepLink: "/admin/content/production?characterId=character-1",
    },
  },
} satisfies VisualIdentityPanelData;

describe("Visual Identity operator workbench", () => {
  it("renders distinct identity, reference and qualification evidence with actionable blockers", () => {
    const html = renderToStaticMarkup(<VisualIdentityPanel data={data} permissions={{ writeVisual: true, evaluateRoute: true }} reload={async () => undefined} />);
    expect(html).toContain("Visual Identity authority");
    expect(html).toContain("reference set not active");
    expect(html).toContain("Open role image production");
    expect(html).toContain("38/40 passed");
    expect(html).toContain("Submit route evaluation");
  });

  it("fails writes closed when the matching effective grants are absent", () => {
    const html = renderToStaticMarkup(<VisualIdentityPanel data={data} permissions={{ writeVisual: false, evaluateRoute: false }} reload={async () => undefined} />);
    expect(html).toContain("content.official.write is not granted");
    expect(html).toContain("content.production.write is not granted");
    expect(html).toMatch(/disabled=""[^>]*>Create &amp; activate version/);
  });
});
