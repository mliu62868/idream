import { describe, expect, it } from "vitest";
import {
  generationRouteRuntimeCompatibility,
  generationSourceVariationAuthority,
} from "./generation-route-authority";

const workflow = {
  version: 1,
  backendKind: "capability_only",
  capabilities: ["referenceImages"],
  inputs: [],
  identity: {
    mode: "single_reference",
    maxReferences: 2,
    acceptedRoles: ["identity_anchor"] as const,
  },
};

describe("effective Generation Route runtime compatibility", () => {
  it("normalizes Reference Set roles and rejects a role the workflow cannot consume", () => {
    expect(generationRouteRuntimeCompatibility({
      workflow,
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true },
      requiredReferenceCount: 2,
      requiredReferenceRoles: ["primary_face", "identity_reference"],
    })).toBe("generation_route_reference_role_unsupported");
  });

  it("does not let initImage-only capability impersonate canonical identity references", () => {
    expect(generationRouteRuntimeCompatibility({
      workflow,
      qualificationWorkflowVersion: 1,
      profileCapabilities: { initImage: true, referenceImages: false },
      requiredReferenceCount: 1,
      requiredReferenceRoles: ["primary_face"],
    })).toBe("generation_workflow_unavailable");
  });

  it("accepts a canonical anchor only when workflow and profile can both consume it", () => {
    expect(generationRouteRuntimeCompatibility({
      workflow,
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true, initImage: false },
      requiredReferenceCount: 1,
      requiredReferenceRoles: ["primary_face"],
    })).toBeNull();
  });

  it("rejects a ComfyUI route when required references cannot fill its concrete slots", () => {
    expect(generationRouteRuntimeCompatibility({
      workflow: {
        version: 1,
        backendKind: "comfyui",
        capabilities: ["referenceImages"],
        identity: {
          mode: "multi_reference",
          maxReferences: 2,
          acceptedRoles: ["identity_anchor", "identity_reference", "source_image"],
        },
        inputs: [
          {
            key: "identity_image",
            type: "image",
            referenceRoles: ["identity_anchor", "identity_reference"],
          },
          {
            key: "source_image",
            type: "image",
            referenceRoles: ["source_image"],
          },
        ],
      },
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true },
      requiredReferenceCount: 1,
      requiredReferenceRoles: ["primary_face"],
    })).toBe("generation_route_reference_capacity_insufficient");
  });

  it("rejects a ComfyUI route when accepted roles cannot be assigned to required slots", () => {
    expect(generationRouteRuntimeCompatibility({
      workflow: {
        version: 1,
        backendKind: "comfyui",
        capabilities: ["referenceImages"],
        identity: {
          mode: "multi_reference",
          maxReferences: 2,
          acceptedRoles: ["identity_anchor", "identity_reference", "source_image"],
        },
        inputs: [
          {
            key: "identity_image",
            type: "image",
            referenceRoles: ["identity_anchor", "identity_reference"],
          },
          {
            key: "source_image",
            type: "image",
            referenceRoles: ["source_image"],
          },
        ],
      },
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true },
      requiredReferenceCount: 2,
      requiredReferenceRoles: ["primary_face", "identity_reference"],
    })).toBe("generation_route_reference_slot_assignment_unsupported");
  });

  it("requires init-image capability in addition to canonical reference capability for More-like", () => {
    expect(generationSourceVariationAuthority({
      routeFingerprint: "route-source-v1",
      routeQualified: true,
      workflow: {
        ...workflow,
        identity: {
          mode: "multi_reference",
          maxReferences: 2,
          acceptedRoles: ["identity_anchor", "source_image"],
          supportsSourceImageWithIdentity: true,
        },
      },
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true, initImage: false },
      canonicalReferenceRoles: ["primary_face"],
      sourceReferenceCount: 1,
    })).toEqual({
      routeFingerprint: "route-source-v1",
      ready: false,
      blocker: "profile_init_image_unsupported",
    });
  });

  it("accepts a distinct source only when workflow, profile, combination and capacity all agree", () => {
    expect(generationSourceVariationAuthority({
      routeFingerprint: "route-source-v1",
      routeQualified: true,
      workflow: {
        ...workflow,
        identity: {
          mode: "multi_reference",
          maxReferences: 2,
          acceptedRoles: ["identity_anchor", "source_image"],
          supportsSourceImageWithIdentity: true,
        },
      },
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true, initImage: true },
      canonicalReferenceRoles: ["primary_face"],
      sourceReferenceCount: 1,
    })).toEqual({
      routeFingerprint: "route-source-v1",
      ready: true,
      blocker: null,
    });
  });

  it("counts every canonical and distinct source reference against one capacity limit", () => {
    expect(generationSourceVariationAuthority({
      routeFingerprint: "route-source-v1",
      routeQualified: true,
      workflow: {
        ...workflow,
        identity: {
          mode: "multi_reference",
          maxReferences: 2,
          acceptedRoles: ["identity_anchor", "identity_reference", "source_image"],
          supportsSourceImageWithIdentity: true,
        },
      },
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true, initImage: true },
      canonicalReferenceRoles: ["primary_face", "identity_reference"],
      sourceReferenceCount: 1,
    }).blocker).toBe("reference_capacity_insufficient");
  });

  it("does not collapse a source role merely because its asset also occupies a canonical slot", () => {
    expect(generationSourceVariationAuthority({
      routeFingerprint: "route-overlap-v1",
      routeQualified: true,
      workflow: {
        ...workflow,
        identity: {
          mode: "multi_reference",
          maxReferences: 1,
          acceptedRoles: ["identity_anchor", "source_image"],
          supportsSourceImageWithIdentity: true,
        },
      },
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true, initImage: true },
      // The helper receives semantic slot counts. These two slots may point at
      // the same mediaAssetId and must still consume two inputs.
      canonicalReferenceRoles: ["primary_face"],
      sourceReferenceCount: 1,
    }).blocker).toBe("reference_capacity_insufficient");
  });

  it("rejects More-like when roles are globally accepted but cannot fill semantic slots", () => {
    expect(generationSourceVariationAuthority({
      routeFingerprint: "route-semantic-slots-v1",
      routeQualified: true,
      workflow: {
        version: 1,
        backendKind: "comfyui",
        capabilities: ["referenceImages"],
        identity: {
          mode: "multi_reference",
          maxReferences: 3,
          acceptedRoles: ["identity_anchor", "identity_reference", "source_image"],
          supportsSourceImageWithIdentity: true,
        },
        inputs: [
          {
            key: "identity_anchor",
            type: "image",
            referenceRoles: ["identity_anchor"],
          },
          {
            key: "identity_reference",
            type: "image",
            referenceRoles: ["identity_anchor", "identity_reference"],
          },
          {
            key: "source_image",
            type: "image",
            referenceRoles: ["source_image"],
          },
        ],
      },
      qualificationWorkflowVersion: 1,
      profileCapabilities: { referenceImages: true, initImage: true },
      canonicalReferenceRoles: ["identity_reference", "identity_reference"],
      sourceReferenceCount: 1,
    }).blocker).toBe("reference_slot_assignment_unsupported");
  });
});
