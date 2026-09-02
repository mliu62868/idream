import { compileCharacterSoul } from "@idream/shared";
import { describe, expect, it, vi } from "vitest";
import {
  productionNegativePrompt,
  productionPrompt,
  resolveProductionBootstrapAuthority,
} from "./run-create-authority";

describe("Creative Run prompt authority", () => {
  it("uses the pinned first-portrait visual direction without synopsis or nonvisual Soul details", () => {
    const prompt = productionPrompt({
      purpose: "character_cover",
      bootstrapIdentity: true,
      target: {
        type: "character", id: "mira", label: "Pinned Mira",
        detail: "PRIVATE_CANON: her former partner waits on a crowded street",
        contentVersionId: "content-7", contentVersion: 7,
        visualIdentity: {
          age: 28, gender: "female", style: "realistic",
          traits: ["Brown eyes", "Dark brown shoulder-length hair", "Light freckles", "Teal cardigan"],
          artDirection: "Soft daylight, plain background",
        },
      },
      recipeBody: "Character image recipe",
      presetFragment: "",
      brief: "Create her first definitive portrait",
      visualProfile: null,
      consistencyMode: "strict",
    });
    for (const fact of ["28-year-old female", "Brown eyes", "Dark brown shoulder-length hair", "Light freckles", "Teal cardigan", "Soft daylight, plain background"]) {
      expect(prompt).toContain(fact);
    }
    expect(prompt).not.toContain("PRIVATE_CANON");
    expect(prompt).not.toContain("crowded street");
  });

  it("pins bootstrap demographics and appearance to the same immutable content without reading Character compatibility fields", async () => {
    const compiled = compileCharacterSoul({ name: "Pinned Mira", age: 28, gender: "female", characterPromise: "PRIVATE_PROMISE", detailsMarkdown: "PRIVATE_MEMO and REPLY_STYLE" });
    if (!compiled.ok) throw new Error("Soul fixture must compile");
    const mutableCharacterRead = vi.fn();
    const db = {
      character: { findUnique: mutableCharacterRead },
      characterProject: { findFirst: vi.fn().mockResolvedValue({ id: "project", version: 4 }) },
      characterContentVersion: { findFirst: vi.fn().mockResolvedValue({
        id: "content-7", version: 7, personaSnapshot: compiled.snapshot,
        appearanceSnapshot: {
          style: "realistic", identityAnchor: "One woman with freckles", stableTraits: ["Brown eyes", "Teal cardigan"],
          referenceDirection: "Plain background", privateMemo: "NEVER_PROMPT_THIS",
        },
      }) },
    };
    const authority = await resolveProductionBootstrapAuthority(db as unknown as Parameters<typeof resolveProductionBootstrapAuthority>[0], "mira", "First portrait");
    expect(authority).toMatchObject({
      characterContentVersionId: "content-7",
      target: {
        label: "Pinned Mira", contentVersionId: "content-7", contentVersion: 7,
        visualIdentity: { age: 28, gender: "female", style: "realistic", traits: ["One woman with freckles", "Brown eyes", "Teal cardigan"], artDirection: "Plain background" },
      },
    });
    expect(JSON.stringify(authority?.target)).not.toMatch(/PRIVATE_PROMISE|PRIVATE_MEMO|REPLY_STYLE|NEVER_PROMPT_THIS/);
    expect(mutableCharacterRead).not.toHaveBeenCalled();
  });

  it("keeps operator exclusions in the effective negative prompt", () => {
    expect(
      productionNegativePrompt(
        "low quality",
        "different person",
        "character_cover",
        "cropped hands, visible text",
      ),
    ).toContain("cropped hands, visible text");
  });

  it("keeps video identity and operator exclusions with the stability guard", () => {
    const negative = productionNegativePrompt(
      "low quality",
      "different person",
      "character_video",
      "cropped hands, visible text",
    );

    expect(negative).toContain("different person");
    expect(negative).toContain("cropped hands, visible text");
    expect(negative).toContain("identity drift");
  });
});
