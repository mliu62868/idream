import { describe, expect, it } from "vitest";
import {
  buildGenerationPrompt,
  compileChatImagePrompt,
  sanitizeChatImageDirection,
} from "./generation-prompt";
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
  it("keeps the complete Chat moment when optional character notes would exhaust the final budget", () => {
    const required = `A closed blue notebook rests flat on the wooden windowsill to the left of a white cup. ${"Rain falls in the dark night. ".repeat(18)}`.trim();
    const text = buildGenerationPrompt({
      mode: "image", character: { ...character, description: "Optional biography. ".repeat(40) },
      visualProfile: { identityPrompt: "Sealed adult visual identity. ".repeat(22) } as GenerationVisualProfile,
      consistencyMode: "strict", userPrompt: required,
      presetFragment: "", lookFragment: "", sourceType: "chat_image",
    });
    expect(text).toContain(required);
    expect(text.length).toBeLessThanOrEqual(2_000);
  });

  it("rejects an oversized Chat direction before the final assembler can discard the required tail", () => {
    const direction = "Small detail. ".repeat(72) + "The only notebook stays to the left of the cup.";
    expect(() => buildGenerationPrompt({
      mode: "image", character, visualProfile: null, consistencyMode: "strict",
      userPrompt: direction, presetFragment: "", lookFragment: "", sourceType: "chat_image",
    })).toThrow(/budget/);
  });

  it("preserves the final constraint of a supported multi-part edit after normalization", () => {
    const instruction = "Edit this image: move the notebook to the left,\n change its cover to green, and brighten the window.  Preserve all faces and the writing on every page.";
    const compiled = compileChatImagePrompt(instruction, "unspecified", { rejectTruncation: true });
    expect(compiled).toBe(instruction.replace(/\s+/g, " ").trim());
    expect(compileChatImagePrompt("编辑这张图片：把笔记本改为绿色、窗帘改为黄色，保留脸、衣服、姿势和最后一页的文字。", "unspecified", { rejectTruncation: true })).toBe("编辑这张图片：把笔记本改为绿色、窗帘改为黄色，保留脸、衣服、姿势和最后一页的文字。");
  });

  it.each([950, 1_250])("rejects an edit with a final constraint beyond the %s-character input instead of dropping it", length => {
    const instruction = `Edit this image: ${"retain detail; ".repeat(100)}`.slice(0, length) + " Preserve the final page exactly.";
    expect(() => compileChatImagePrompt(instruction, "unspecified", { rejectTruncation: true })).toThrow(/Shorten the request/);
    expect(() => compileChatImagePrompt(instruction, "unspecified")).toThrow(/Shorten the request/);
  });

  it.each(["none", "full"] as const)("includes the %s wardrobe prefix in the edit budget", nudity => {
    const instruction = `Edit this image: ${"retain detail; ".repeat(100)}`.slice(0, 850);
    expect(instruction.length).toBeLessThan(900);
    expect(() => compileChatImagePrompt(instruction, nudity, { rejectTruncation: true })).toThrow(/900-character/);
  });

  it("compiles a source-image edit without replacing its composition with a new portrait", () => {
    const text = buildGenerationPrompt({
      mode: "image", character, visualProfile: null, consistencyMode: "strict",
      sourceImageAssetId: "delivered-chat-image",
      userPrompt: "Add a small red scarf. Keep the same face and framing.",
      presetFragment: "", lookFragment: "", sourceType: "chat_image",
    });
    expect(text).toMatch(/^Edit the supplied source image/);
    expect(text).toContain("Add a small red scarf. Keep the same face and framing.");
    expect(text).toContain("composition, framing, camera angle, pose, background and lighting");
    expect(text).toContain("identity reference");
    expect(text).not.toContain("High quality in-character portrait");
    expect(text).not.toContain("bartender");
  });

  it("removes Agent-authored identity claims while preserving the concrete scene", () => {
    const direction = sanitizeChatImageDirection(
      "Full nude selfie of a young woman around 20 years old at a rainy bedroom window, 4:5 close-up, warm bedside light, dark hair loose around her face, direct gaze, wet porcelain skin.",
    );

    expect(direction).toContain("Full nude selfie");
    expect(direction).toContain("rainy bedroom window");
    expect(direction).toContain("4:5 close-up");
    expect(direction).toContain("warm bedside light");
    expect(direction).toContain("hair loose around her face");
    expect(direction).toContain("direct gaze");
    expect(direction).not.toContain("around 20 years old");
    expect(direction).not.toContain("young woman");
    expect(direction).not.toContain("dark hair");
    expect(direction).not.toContain("porcelain skin");
  });

  it("removes remaining Agent-authored hair, face, age, and body identity claims", () => {
    const direction = sanitizeChatImageDirection(
      "Full nude selfie, long curly black hair, blue eyes, angular face, petite hourglass body, mature-looking woman with a different nose and full lips, beside a rainy window.",
    );

    expect(direction).toContain("Full nude selfie");
    expect(direction).toContain("beside a rainy window");
    for (const identityClaim of [
      "long curly",
      "black hair",
      "blue eyes",
      "angular face",
      "petite",
      "hourglass",
      "mature-looking",
      "different nose",
      "full lips",
    ]) {
      expect(direction).not.toContain(identityClaim);
    }
    expect(direction).not.toContain("with a and");
  });

  it("compiles structural nudity constraints ahead of the complete Agent scene", () => {
    const longScene = `At the bedroom window, ${"soft rain and warm light, ".repeat(28)}fully clothed in a silk robe`;
    const compiled = compileChatImagePrompt(longScene, "full");

    expect(compiled).toMatch(/^Adult scene requirement: depict the adult character fully nude/);
    expect(compiled).toContain("At the bedroom window");
    expect(compiled).not.toContain("silk robe");
    expect(compiled.length).toBeLessThanOrEqual(900);
  });

  it("rejects long new-image directions when structural nudity requirements exceed the complete budget", () => {
    const direction = (repetitions: number) => [
      "sitting beside a rain-streaked window, soft evening light",
      "soft rain reflections and warm practical light, ".repeat(repetitions),
      "fully clothed in a silk robe",
    ].join(" ");
    expect(() => compileChatImagePrompt(direction(18), "full")).toThrow(/900-character/);
    const accepted = compileChatImagePrompt(direction(15), "full");
    expect(accepted).toContain("Adult scene requirement: depict the adult character fully nude");
    expect(accepted).toContain("rain-streaked window");
    expect(accepted).not.toContain("silk robe");
    expect(accepted.length).toBeLessThanOrEqual(900);
  });

  it("compiles an explicit no-nudity constraint without trusting Agent wording", () => {
    const compiled = compileChatImagePrompt(
      "Fully nude selfie at the observatory in blue light",
      "none",
    );

    expect(compiled).toMatch(/^Wardrobe requirement: keep the adult character clothed/);
    expect(compiled.toLowerCase()).not.toContain("fully nude selfie");
    expect(compiled).toContain("observatory in blue light");
  });

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

  it("keeps identity traits but drops mutable clothing that conflicts with the requested scene", () => {
    const text = buildGenerationPrompt({
      mode: "image",
      character: {
        ...character,
        appearance: {
          identityAnchor: "Tamsin Jacobs with a soft round face and hazel-brown eyes",
          stableTraits: [
            "shoulder-length wavy golden-blonde hair",
            "hazel-brown eyes",
            "dusty-rose satin robe",
          ],
        },
      },
      visualProfile: {
        identityPrompt: "Preserve the exact same adult person shown in the canonical identity portrait",
      } as GenerationVisualProfile,
      consistencyMode: "balanced",
      userPrompt: [
        "Create a new in-character photo of Tamsin Jacobs.",
        "Adult scene requirement: depict the adult character fully nude, with no clothing or robe, while preserving the same identity.",
        "Original user request: 给我一个你的裸照",
      ].join(" "),
      presetFragment: "",
      lookFragment: "",
      sourceType: "chat_image",
    });

    expect(text).toContain("shoulder-length wavy golden-blonde hair");
    expect(text).toContain("hazel-brown eyes");
    expect(text).toContain("depict the adult character fully nude");
    expect(text).not.toContain("dusty-rose satin robe");
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
