import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CharacterCreateWizard,
  characterAssetsDeepLink,
  isCharacterCreateStepComplete,
} from "./CharacterCreateWizard";
import type { AdminPermissionKey } from "@idream/shared/admin";
import { CharacterWorkspace } from "./CharacterWorkspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Character create wizard", () => {
  it("renders the five-step mobile-first server draft workflow", () => {
    const html = renderToStaticMarkup(createElement(CharacterCreateWizard, { canCreate: true }));
    expect(html).toContain("data-testid=\"character-create-wizard\"");
    expect(html).toContain("Positioning");
    expect(html).toContain("Persona");
    expect(html).toContain("Visual direction");
    expect(html).toContain("Commercial intent");
    expect(html).toContain("Review");
    expect(html).toContain("Recoverable draft");
    expect(html).toContain("Continue to persona");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain(
      'aria-describedby="character-create-step-requirements"',
    );
    expect(html).toContain('id="character-create-step-requirements"');
    expect(html).toContain('placeholder="Adults winding down after high-pressure work"');
    expect(html).not.toContain('value="Define the adult audience for this companion"');
    expect(html).not.toContain('value="Untitled companion"');
    expect(html).toMatch(/disabled=""[^>]*>Continue to persona/);
  });

  it("requires meaningful operator input at each step instead of accepting instructional copy", () => {
    const blank = {
      positioning: {
        audience: "",
        companionNeed: "",
        hypothesis: "",
        differentiation: "",
      },
      persona: {
        name: "",
        age: 18,
        gender: "female" as const,
        relationshipArchetype: "",
        characterPromise: "",
        personality: "",
        tone: "",
        backstory: "",
        firstMessage: "",
        exampleDialogue: [],
      },
      visualDirection: {
        identityAnchor: "",
        stableTraits: [],
        style: "realistic" as const,
        referenceDirection: "",
      },
      commercialIntent: {
        ownerId: null,
        plannedLaunchAt: null,
        targetPlacementKeys: [],
        successCriteria: [],
        productionPackage: "",
        qaPlan: "",
      },
    };
    expect(isCharacterCreateStepComplete(blank, 0)).toBe(false);
    expect(isCharacterCreateStepComplete({
      ...blank,
      positioning: {
        audience: "Adults winding down after work",
        companionNeed: "A dependable evening ritual",
        hypothesis: "Specific rituals improve qualified conversations",
        differentiation: "Calm direction without generic affirmation",
      },
    }, 0)).toBe(true);
    expect(isCharacterCreateStepComplete(blank, 4)).toBe(false);
  });

  it("lets an old instructional draft resume but blocks it from final creation", () => {
    const instructional = {
      positioning: {
        audience: "Define the adult audience for this companion",
        companionNeed: "Define the recurring companionship need",
        hypothesis: "State the behavior and outcome hypothesis",
        differentiation: "Explain why users will choose this character",
      },
      persona: {
        name: "Untitled companion",
        age: 18,
        gender: "female" as const,
        relationshipArchetype: "trusted companion",
        characterPromise: "A specific, dependable companionship promise",
        personality: "Warm, observant, and consistent",
        tone: "Natural, concise, and emotionally present",
        backstory:
          "Draft the experiences that shape this character's point of view.",
        firstMessage: "I'm here. Where should we begin?",
        exampleDialogue: ["Tell me what matters most about that."],
      },
      visualDirection: {
        identityAnchor: "A recognizable adult companion identity",
        stableTraits: ["consistent face", "recognizable silhouette"],
        style: "realistic" as const,
        referenceDirection:
          "Describe lighting, framing, wardrobe, and reference direction.",
      },
      commercialIntent: {
        ownerId: null,
        plannedLaunchAt: null,
        targetPlacementKeys: [],
        successCriteria: ["Define one measurable success criterion"],
        productionPackage:
          "Define the required identity, placement, and chat asset package.",
        qaPlan: "Define mobile, desktop, and conversation QA evidence.",
      },
    };

    expect(isCharacterCreateStepComplete(instructional, 0)).toBe(true);
    expect(isCharacterCreateStepComplete(instructional, 4)).toBe(false);
  });

  it("hands a completed Character directly to role-image production", () => {
    expect(characterAssetsDeepLink("/admin/characters/character-1")).toBe(
      "/admin/characters/character-1?tab=assets",
    );
    expect(characterAssetsDeepLink(
      "/admin/characters/character-1?tab=overview",
    )).toBe("/admin/characters/character-1?tab=assets");
  });

  it("fails closed without Character Project write permission", () => {
    const html = renderToStaticMarkup(createElement(CharacterCreateWizard, { canCreate: false }));
    expect(html).toContain("No permission");
    expect(html).toContain("character.project.write");
    expect(html).not.toContain("Continue to persona");
  });

  it("dispatches the canonical new subview to the wizard instead of Portfolio", () => {
    const html = renderToStaticMarkup(createElement(CharacterWorkspace, {
      actorId: "test-admin",
      view: { kind: "new" },
      permissions: new Set<AdminPermissionKey>(["character.project.write"]),
    }));
    expect(html).toContain("data-testid=\"character-create-wizard\"");
    expect(html).not.toContain("Portfolio &amp; Projects");
  });
});
