import { describe, expect, it } from "vitest";
import { characterVisualWorkspaceSchema } from "./characters";

describe("Character Visual workspace contract", () => {
  it("keeps selection, published references, qualification evidence and readiness distinct", () => {
    const result = characterVisualWorkspaceSchema.parse({
      activeIdentity: {
        id: "identity-1", version: 2, status: "active", style: "realistic",
        identityPrompt: "same adult character", negativeIdentityPrompt: null,
        traits: { face: {}, hair: {}, body: {}, signature: {}, style: {} },
        immutableHash: "identity-hash", evidenceState: "candidate", defaultSeed: null,
        createdFrom: "admin_passport_edit", createdAt: "2026-07-12T12:00:00.000Z",
      },
      anchors: [{ mediaAssetId: "asset-anchor", role: "identity_anchor", available: true, url: "/anchor.webp", thumbnailUrl: null, qualityScore: null, identityScore: null }],
      references: [],
      activeReferenceSet: null,
      routeQualifications: [],
      readiness: {
        ready: false,
        qualificationPolicyVersion: "character-release-policy-v2",
        blockers: [{ code: "reference_set_not_active", message: "No active Reference Set revision is pinned.", deepLink: "/admin/characters/character-1?tab=visual" }],
        productionDeepLink: "/admin/content/production?characterId=character-1",
      },
    });
    expect(result.activeIdentity?.version).toBe(2);
    expect(result.readiness.ready).toBe(false);
  });

  it("rejects a readiness claim without explicit evidence collections", () => {
    expect(characterVisualWorkspaceSchema.safeParse({ readiness: { ready: true, qualificationPolicyVersion: "v2", blockers: [], productionDeepLink: "/admin/content/production" } }).success).toBe(false);
  });
});
