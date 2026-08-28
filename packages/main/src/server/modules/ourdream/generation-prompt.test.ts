import { describe, expect, it } from "vitest";
import { buildGenerationPrompt } from "./generation-prompt";
import type { GenerationPromptCharacter, GenerationVisualProfile } from "./generation-character-authority";

const character: GenerationPromptCharacter = {
  id: "raya-reyes",
  imageAssetId: "asset-1",
  name: "Raya Reyes",
  age: 27,
  description: "A wry bartender who closes up alone.",
  style: "realistic",
  gender: "female",
  appearance: {
    face: { eyes: "dark brown", skin: "warm olive" },
    hair: { color: "black", length: "shoulder length" },
    body: { build: "athletic" },
  },
  advancedDetails: { signature: { detail: "a chipped silver ring" } },
};

function prompt(
  consistencyMode: "balanced" | "strict" | "creative",
  visualProfile: GenerationVisualProfile | null = null,
) {
  return buildGenerationPrompt({
    mode: "image",
    character,
    visualProfile,
    consistencyMode,
    userPrompt: "sitting on a rooftop at dusk",
    presetFragment: "",
    lookFragment: "",
  });
}

describe("image generation prompt", () => {
  it("honours Identity variation for a character with no pinned Visual Profile", () => {
    // 这个控件在 Advanced settings 里对所有角色都点得到。此前只有 pin 了 Visual Profile
    // 的角色才会真的把它写进提示词 —— 16 个公开角色里的 15 个点了等于没点。
    const strict = prompt("strict");
    const creative = prompt("creative");
    const balanced = prompt("balanced");
    expect(strict).not.toBe(creative);
    expect(strict).not.toBe(balanced);
    expect(strict).toContain("Identity consistency: strict");
    expect(creative).toContain("Identity consistency: creative");
    expect(balanced).toContain("Identity consistency: balanced");
  });

  it("describes an unpinned character with the assembled identity, not a bare key dump", () => {
    const text = prompt("balanced");
    expect(text).toContain("Character identity:");
    expect(text).toContain("Raya Reyes, adult female companion");
    expect(text).toContain("27 years old");
    expect(text).toContain("realistic visual style");
    expect(text).toContain("dark brown");
    expect(text).toContain("chipped silver ring");
  });

  it("keeps chat persona and internal provenance out of the image prompt", () => {
    // 图片提示词只有 2000 字预算，此前整包 advancedDetails 被摊平塞了进去：
    // tone / backstory / personality / firstMessage，连内部种子文件路径都发给了图像供应商，
    // 真正的外貌描述反而被截断挤掉。
    const text = buildGenerationPrompt({
      mode: "image",
      character: {
        ...character,
        advancedDetails: {
          signature: { detail: "a chipped silver ring" },
          tone: "Defensive, dryly sarcastic.",
          backstory: "She opposed her mother's remarriage.",
          personality: "Protective, skeptical, sharp-witted.",
          firstMessage: "Can we agree not to pretend this is easy?",
          provenance: {
            ownership: "platform_official",
            seedSource: "src/lib/official-cold-start-content.ts",
            originalCreator: "@some1cool",
          },
        },
      },
      visualProfile: null,
      consistencyMode: "balanced",
      userPrompt: "sitting on a rooftop at dusk",
      presetFragment: "",
      lookFragment: "",
    });
    expect(text).toContain("a chipped silver ring");
    for (const leak of [
      "dryly sarcastic",
      "remarriage",
      "sharp-witted",
      "pretend this is easy",
      "platform_official",
      "official-cold-start-content",
      "@some1cool",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("never sends the card image path to the image model", () => {
    const text = buildGenerationPrompt({
      mode: "image",
      character: { ...character, appearance: { sourceImage: "/images/ourdream/card-raya-reyes.webp" } },
      visualProfile: null,
      consistencyMode: "balanced",
      userPrompt: "sitting on a rooftop at dusk",
      presetFragment: "",
      lookFragment: "",
    });
    expect(text).not.toContain("card-raya-reyes");
    expect(text).not.toContain("sourceImage");
  });

  it("uses the canonical visual anchor and stable traits stored on the character", () => {
    const text = buildGenerationPrompt({
      mode: "image",
      character: {
        ...character,
        appearance: {
          identityAnchor: "Raya Reyes with an angular olive-toned face",
          stableTraits: ["shoulder-length black hair", "dark brown eyes", "chipped silver ring"],
          sourceImage: "/images/ourdream/card-raya-reyes.webp",
        },
      },
      visualProfile: null,
      consistencyMode: "strict",
      userPrompt: "sitting on a rooftop at dusk",
      presetFragment: "",
      lookFragment: "",
    });

    expect(text).toContain("Visual identity anchor: Raya Reyes with an angular olive-toned face");
    expect(text).toContain("Stable visual traits: shoulder-length black hair, dark brown eyes, chipped silver ring");
    expect(text).not.toContain("card-raya-reyes");
  });

  it("does not call an unpinned character's identity locked", () => {
    // 界面已按 quote 的 identityLocked 说实话；没 pin 身份时提示词也不该自称 locked。
    expect(prompt("strict")).toContain("Character identity:");
    expect(prompt("strict")).not.toContain("Locked identity");
  });

  it("still prefers the pinned Visual Profile identity when the Release pins one", () => {
    const profile = {
      identityPrompt: "Pinned identity sentence from the sealed Visual Profile",
    } as GenerationVisualProfile;
    const text = prompt("strict", profile);
    expect(text).toContain("Locked identity: Pinned identity sentence from the sealed Visual Profile");
    expect(text).not.toContain("Raya Reyes, adult female companion");
    expect(text).toContain("Identity consistency: strict");
  });
});
