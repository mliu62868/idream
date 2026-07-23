import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";
import {
  characterWorkspaceTabLabel,
  resolveCharacterProductionEntry,
} from "./CharacterWorkspace";

function workspace(overrides: {
  bootstrap?: boolean;
  repairable?: boolean;
  ready?: boolean;
  missingPurposes?: string[];
  servingState?: string | null;
}): CharacterWorkspaceDetail {
  return {
    character: {
      id: "alexa-reeves",
      name: "Alexa Reeves",
      imageUrl: overrides.repairable ? "/alexa.webp" : null,
    },
    project: {
      draftAssetRouteAuthority: {
        missingPurposes: overrides.missingPurposes ?? [],
      },
    },
    visual: {
      identityBootstrap: { allowed: overrides.bootstrap ?? false },
      readiness: { ready: overrides.ready ?? true },
      imageReadiness: overrides.repairable
        ? { state: "repairable", repair: { kind: "adopt_live_portrait" } }
        : null,
    },
    serving: overrides.servingState
      ? { state: overrides.servingState }
      : null,
    releases: [],
  } as unknown as CharacterWorkspaceDetail;
}

describe("Character production entry", () => {
  it("routes first-time setup to the identity portrait flow", () => {
    expect(resolveCharacterProductionEntry(workspace({ bootstrap: true }))).toMatchObject({
      activeStep: 1,
      status: "First-time setup",
      tab: "assets",
    });
  });

  it("routes a ready live character directly to recurring image creation", () => {
    expect(resolveCharacterProductionEntry(workspace({
      ready: true,
      servingState: "live",
    }))).toMatchObject({
      activeStep: 2,
      status: "Ready for ongoing image production",
      action: "Create more images",
      tab: "assets",
    });
  });

  it("routes a live portrait that needs one-time adoption to image production enablement", () => {
    expect(resolveCharacterProductionEntry(workspace({
      ready: false,
      repairable: true,
      servingState: "live",
    }))).toMatchObject({
      activeStep: 1,
      status: "Enable image production",
      action: "Use current portrait",
      tab: "assets",
    });
  });

  it("uses operator-facing tab labels instead of raw route keys", () => {
    expect(characterWorkspaceTabLabel("project")).toBe("Overview");
    expect(characterWorkspaceTabLabel("assets")).toBe("Image assets");
    expect(characterWorkspaceTabLabel("voice")).toBe("Voice");
    expect(characterWorkspaceTabLabel("preview")).toBe("Launch preview");
  });
});
