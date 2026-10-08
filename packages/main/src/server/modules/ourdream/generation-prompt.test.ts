import { describe, expect, it } from "vitest";
import {
  buildGenerationPrompt,
  compileChatImagePrompt,
  defaultImageNegativePrompt,
  imageNegativePrompt,
  sanitizeChatImageDirection,
} from "./generation-prompt";
import type { GenerationPromptCharacter, GenerationVisualProfile } from "./generation-character-authority";
import { CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT } from "@idream/shared/admin";
import { characterVisualProfileSnapshotHash } from "../admin-v2/characters/release-snapshot";
import { assembleIdentityPrompt, IDENTITY_ASSEMBLER_VERSION, toTraitRecord } from "./identity-assembler";
import { generationJobSchema } from "./generation-request-schema";

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
  it.each([
    { label: "Character portrait", mode: "image" as const, subject: character },
    { label: "Freeplay still", mode: "image" as const, subject: null },
    { label: "source edit", mode: "image" as const, subject: character, sourceImageAssetId: "accepted-source" },
    { label: "video", mode: "video" as const, subject: character },
  ])("keeps the public 2000-character direction complete for $label", ({ mode, subject, sourceImageAssetId }) => {
    const tail = " The only green notebook stays closed to the left of the white cup.";
    const direction = "Keep every visible library detail unchanged. ".repeat(60).slice(0, 2_000 - tail.length) + tail;
    const body = generationJobSchema.parse({ mode, characterId: subject?.id, freeplay: !subject, prompt: direction });
    expect(body.prompt).toHaveLength(2_000);
    const text = buildGenerationPrompt({ mode, character: subject, visualProfile: null, consistencyMode: "strict",
      userPrompt: body.prompt, presetFragment: "", lookFragment: "", sourceImageAssetId });
    expect(text).toContain(direction);
    expect(text).toContain(tail.trim());
  });

  it("keeps full sealed identity, anchor and all schema-valid stable traits before the complete scene", () => {
    const identity = "Stable adult facial identity. ".repeat(80).slice(0, 1_960) + " FINAL_SEALED_IDENTITY_MARK";
    const anchor = "Stable face geometry. ".repeat(100).slice(0, 1_960) + " FINAL_ANCHOR_MARK";
    const traits = Array.from({ length: 24 }, (_, index) => `${index}: ${"Stable distinct facial feature. ".repeat(17).slice(0, 450)} FINAL_TRAIT_${index}`);
    const scene = "In a quiet glass conservatory at dawn holding one closed green notebook.";
    const profile = { identityPrompt: identity } as GenerationVisualProfile;
    const text = buildGenerationPrompt({ mode: "image", character: { ...character, appearance: { identityAnchor: anchor, stableTraits: traits } },
      visualProfile: profile, consistencyMode: "strict", userPrompt: scene, lookFragment: "", presetFragment: "" });
    expect(text).toContain(`Locked identity: ${identity}`);
    expect(text).toContain(`Visual identity anchor: ${anchor}`);
    for (const trait of traits) expect(text).toContain(trait);
    expect(text).toContain(`Requested scene: ${scene}`);
    expect(profile.identityPrompt).toBe(identity);
  });

  // SPEC: after "change look" the operator-written identity is the only description;
  // the frozen creation-time appearance text may describe the previous look.
  it("drops frozen appearance text when an operator authored the locked identity", () => {
    const appearance = { identityAnchor: "OLD_ANCHOR dark brown hair", stableTraits: ["OLD_TRAIT brown eyes"] };
    const build = (createdFrom: string) => buildGenerationPrompt({ mode: "image", character: { ...character, appearance },
      visualProfile: { identityPrompt: "Long red hair, green eyes", createdFrom } as GenerationVisualProfile,
      consistencyMode: "strict", userPrompt: "reading in a cafe", lookFragment: "", presetFragment: "" });
    for (const createdFrom of ["identity_calibration:job-1", "admin_passport_edit"]) {
      const text = build(createdFrom);
      expect(text).toContain("Locked identity: Long red hair, green eyes");
      expect(text).not.toContain("OLD_ANCHOR");
      expect(text).not.toContain("OLD_TRAIT");
    }
    // A derived identity only says "match the portrait"; the appearance text stays.
    const derived = build("editorial_live_portrait:release-1");
    expect(derived).toContain("Visual identity anchor: OLD_ANCHOR dark brown hair");
    expect(derived).toContain("OLD_TRAIT brown eyes");
  });

  it("keeps public direction, saved Look and selected preset facts beyond Chat budgets", () => {
    const scene = "Keep every visible library detail unchanged. ".repeat(60).slice(0, 1_950) + " FINAL_SCENE_KEEP_THE_NOTEBOOK_CLOSED";
    const look = JSON.stringify({ description: "Keep the navy coat detail. ".repeat(24) + " FINAL_LOOK_LEFT_BROOCH" });
    const preset = "Keep the glass conservatory detail. ".repeat(18) + " FINAL_PRESET_ONE_CLOSED_NOTEBOOK";
    const text = buildGenerationPrompt({ mode: "image", character, visualProfile: null, consistencyMode: "strict",
      userPrompt: scene, lookFragment: look, presetFragment: preset });
    expect(text).toContain(`Requested scene: ${scene}`);
    expect(text).toContain(`Active look: ${look.replace(/\s+/g, " ")}`);
    expect(text).toContain(`Scene details: ${preset.replace(/\s+/g, " ")}`);
    expect(text.length).toBeGreaterThan(2_000);
    expect(text).not.toContain("clean photographic composition");
  });

  it("retains complete user, sealed identity and template exclusions while deduplicating", () => {
    const user = "avoid blur, ".repeat(80) + "FINAL_USER_NO_SECOND_FACE";
    const identity = "avoid eye drift, ".repeat(115) + "FINAL_IDENTITY_NO_CHANGED_SCAR";
    const template = "avoid poor detail, ".repeat(60) + "FINAL_TEMPLATE_NO_WATERMARK";
    const base = `${defaultImageNegativePrompt(template)}, ${user}`;
    const negative = imageNegativePrompt(base, { negativeIdentityPrompt: identity });
    expect(user.length).toBeLessThanOrEqual(1_000);
    expect(identity.length).toBeLessThanOrEqual(2_000);
    for (const constraint of ["FINAL_USER_NO_SECOND_FACE", "FINAL_IDENTITY_NO_CHANGED_SCAR", "FINAL_TEMPLATE_NO_WATERMARK"]) expect(negative).toContain(constraint);
    expect(negative?.split(", ").filter(term => term === "avoid blur")).toHaveLength(1);
  });

  it("keeps Chat's complete-facts rejection when long sealed identity exhausts the assembled budget", () => {
    expect(() => buildGenerationPrompt({ mode: "image", character,
      visualProfile: { identityPrompt: "Stable adult facial identity. ".repeat(70) } as GenerationVisualProfile,
      consistencyMode: "strict", userPrompt: "One closed notebook at dawn", lookFragment: "", presetFragment: "", sourceType: "chat_image" }))
      .toThrow(/2000-character generation budget/);
  });

  it.each([undefined, "chat_image", "chat_handoff"])("keeps biography scenes out of image identity on %s", sourceType => {
    const scene = "One adult in a quiet conservatory at dawn, holding one closed green notebook.";
    const text = buildGenerationPrompt({
      mode: "image", character: { ...character, description: "Three guests on a sunny yacht." },
      visualProfile: null, consistencyMode: "strict", userPrompt: scene,
      presetFragment: "", lookFragment: "", sourceType,
    });
    expect(text).toContain(scene);
    expect(text).toContain("Raya Reyes");
    expect(text).toContain("dark brown");
    expect(text).toContain("warm olive");
    expect(text).not.toContain("yacht");
    expect(text).not.toContain("Three guests");
  });
  it("preserves a freeplay still life without injecting a human subject", () => {
    const scene = "A red ceramic cup on a plain wooden table, natural daylight, still life photography";
    const text = buildGenerationPrompt({
      mode: "image", character: null, visualProfile: null, consistencyMode: "balanced",
      userPrompt: scene, presetFragment: "", lookFragment: "",
    });
    expect(text).toContain(scene);
    expect(text).not.toMatch(/portrait|face|eyes|skin|human|person/i);
  });

  it("edits a scene-only source without adding companion facial constraints", () => {
    const text = buildGenerationPrompt({ mode: "image", character: null, visualProfile: null, consistencyMode: "strict",
      userPrompt: "Change only the basil pot to blue.", presetFragment: "", lookFragment: "", sourceImageAssetId: "scene-source", sourceType: "chat_image" });
    expect(text).toContain("Change only the basil pot to blue.");
    expect(text).toContain("do not add a person");
    expect(text).not.toMatch(/same adult person|subject's face|body proportions/iu);
  });

  it("deduplicates composed image exclusions without dropping identity constraints", () => {
    expect(imageNegativePrompt("blur, duplicate person, BLUR", { negativeIdentityPrompt: "different face, duplicate person" }))
      .toBe("blur, duplicate person, different face");
  });

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

  it("treats reference clothes as baseline when a saved Look and requested scene change them", () => {
    const identity = "Raya Reyes, 27 years old, with an olive face, dark brown eyes and shoulder-length black hair, wearing a green sweater on a balcony";
    const look = JSON.stringify({ description: "A navy wool coat with a silver brooch" });
    const scene = "In a sunlit library beside a closed red notebook";
    const text = buildGenerationPrompt({
      mode: "image", character,
      visualProfile: { identityPrompt: identity } as GenerationVisualProfile,
      consistencyMode: "strict", userPrompt: scene, lookFragment: look,
      presetFragment: "a leafy garden path, standing",
    });
    expect(text).toContain(`Locked identity: ${identity}`);
    expect(text).toContain(`Active look: ${look}`);
    expect(text).toContain(`Requested scene: ${scene}`);
    expect(text).toContain("Active look and Requested scene override baseline clothing, pose and background in identity descriptions and reference images");
    expect(text).toContain("Preserve the same adult face, age, hair, eye color, skin and body proportions");
    expect(text).toContain("Scene details apply only where they do not conflict with the Active look or Requested scene");
    expect(text.indexOf("override baseline")).toBeLessThan(text.indexOf("Locked identity:"));
  });

  it("keeps a saved Look beyond Chat's budget with its final required detail", () => {
    const look = JSON.stringify({ description: "Keep the coat detail. ".repeat(27) + "The silver brooch stays on the left lapel." });
    const text = buildGenerationPrompt({
      mode: "image", character, visualProfile: null, consistencyMode: "strict",
      userPrompt: "In a sunlit library", lookFragment: look, presetFragment: "",
    });
    expect(text).toContain(`Active look: ${look}`);
    expect(text).toContain("The silver brooch stays on the left lapel.");
  });

  it("keeps a requested scene beyond Chat's budget with its final constraint", () => {
    const scene = "Keep the library detail. ".repeat(40) + "The red notebook remains closed.";
    const text = buildGenerationPrompt({
      mode: "image", character, visualProfile: null, consistencyMode: "strict",
      userPrompt: scene, lookFragment: JSON.stringify({ description: "A navy wool coat" }), presetFragment: "",
    });
    expect(text).toContain(`Requested scene: ${scene}`);
    expect(text).toContain('Active look: {"description":"A navy wool coat"}');
  });

  it("keeps the full saved Look and scene when optional photo polish would exhaust their budget", () => {
    const identity = "Adult identity face and hair traits. ".repeat(23).trim();
    const look = JSON.stringify({ description: "Navy coat and silver details. ".repeat(7) + "The brooch stays on the left lapel." });
    const scene = "In a sunlit library beside a closed red notebook. Keep only one notebook.";
    const text = buildGenerationPrompt({
      mode: "image", character,
      visualProfile: { identityPrompt: identity } as GenerationVisualProfile,
      consistencyMode: "strict", userPrompt: scene, lookFragment: look, presetFragment: "",
    });
    expect(text).toContain(`Locked identity: ${identity}`);
    expect(text).toContain(`Active look: ${look}`);
    expect(text).toContain(`Requested scene: ${scene}`);
    expect(text.length).toBeLessThanOrEqual(2_000);
  });

  it("keeps combined Look, identity and scene facts beyond Chat's assembled budget", () => {
    const identity = "Adult identity face and hair traits. ".repeat(23).trim();
    const scene = "Keep the library detail. ".repeat(28).trim();
    const look = JSON.stringify({ description: "Keep the coat detail. ".repeat(18) + "The brooch stays on the left lapel." });
    const text = buildGenerationPrompt({
      mode: "image", character,
      visualProfile: { identityPrompt: identity } as GenerationVisualProfile,
      consistencyMode: "strict", userPrompt: scene, lookFragment: look, presetFragment: "",
    });
    expect(text).toContain(`Locked identity: ${identity}`);
    expect(text).toContain(`Requested scene: ${scene}`);
    expect(text).toContain(`Active look: ${look}`);
    expect(text.length).toBeGreaterThan(2_000);
  });

  it("keeps the final selected scene preset instead of spending its budget on photo polish", () => {
    const identity = "Adult identity face and hair traits. ".repeat(18).trim();
    const look = JSON.stringify({ description: "Navy coat and silver details. ".repeat(6) + "The brooch stays on the left lapel." });
    const preset = "Library scene detail. ".repeat(20) + "Only one closed notebook is on the left.";
    const text = buildGenerationPrompt({
      mode: "image", character,
      visualProfile: { identityPrompt: identity } as GenerationVisualProfile,
      consistencyMode: "strict", userPrompt: "In a sunlit library", lookFragment: look, presetFragment: preset,
    });
    expect(text).toContain(`Locked identity: ${identity}`);
    expect(text).toContain(`Active look: ${look}`);
    expect(text).toContain(`Scene details: ${preset}`);
    expect(text.length).toBeLessThanOrEqual(2_000);
  });

  it("keeps selected scene details beyond Chat's budget with a Look", () => {
    const preset = "Keep the library detail. ".repeat(25) + "Only one closed notebook is on the left.";
    const text = buildGenerationPrompt({
      mode: "image", character, visualProfile: null, consistencyMode: "strict",
      userPrompt: "In a sunlit library", lookFragment: JSON.stringify({ description: "A navy wool coat" }),
      presetFragment: preset,
    });
    expect(text).toContain(`Scene details: ${preset}`);
    expect(text).toContain('Active look: {"description":"A navy wool coat"}');
  });
});

describe("saved Look with a sealed derived portrait identity", () => {
  function sealedProfile(overrides: Partial<GenerationVisualProfile> = {}): GenerationVisualProfile {
    const profile = {
      id: "sealed-visual-1", characterId: character.id, version: 1, style: "realistic",
      faceTraits: { eyes: "dark brown", skinTone: "warm olive", faceShape: "oval",
        prompt: "A bartender wearing a green sweater on an old balcony", scar: "small left cheek scar" },
      hairTraits: { prompt: "shoulder-length black hair", parting: "center part" },
      bodyTraits: { build: "athletic", hands: "long fingers" },
      signatureTraits: { age: 27, birthmark: "crescent birthmark behind the left ear",
        description: "A bartender on the old balcony", firstMessage: "Welcome to the old balcony",
        detailsMarkdown: "## Premise\nThe old balcony is her story setting" },
      styleTraits: { name: "Sealed Raya", age: "27", gender: "female", style: "realistic", description: "The old balcony biography" },
      negativeIdentityPrompt: "identity drift", anchorAssetIds: ["sealed-canonical-portrait"],
      ...overrides,
    } as GenerationVisualProfile;
    const assembled = assembleIdentityPrompt({ face: toTraitRecord(profile.faceTraits), hair: toTraitRecord(profile.hairTraits),
      body: toTraitRecord(profile.bodyTraits), signature: toTraitRecord(profile.signatureTraits), style: toTraitRecord(profile.styleTraits) });
    profile.identityPrompt = assembled.identityPrompt;
    profile.adapterRefs = { identity: { source: "derived", assemblerVersion: IDENTITY_ASSEMBLER_VERSION, traitsHash: assembled.traitsHash } };
    profile.immutableHash = characterVisualProfileSnapshotHash(profile);
    return profile;
  }

  function lookPortrait(profile: GenerationVisualProfile, subject = character, overrides: { lookFragment?: string; sourceImageAssetId?: string; mode?: "image" | "video" } = {}) {
    return buildGenerationPrompt({ mode: "image", character: subject, visualProfile: profile, consistencyMode: "strict",
      userPrompt: "In a sunlit library beside one closed red notebook", presetFragment: "standing beside a bookshelf",
      lookFragment: JSON.stringify({ description: "A navy coat with a silver brooch" }), ...overrides });
  }

  it("uses sealed stable facts and the canonical portrait without carrying the original clothing or premise into a Look", () => {
    const profile = sealedProfile();
    const original = structuredClone(profile);
    const text = lookPortrait(profile);
    expect(text).toContain(`Locked identity: Sealed Raya, adult female companion; 27 years old; realistic visual style`);
    expect(text).toContain(CHARACTER_CANONICAL_PORTRAIT_IDENTITY_PROMPT);
    for (const fact of ["dark brown", "warm olive", "oval", "small left cheek scar", "shoulder-length black hair", "center part", "athletic", "long fingers", "crescent birthmark behind the left ear"]) {
      expect(text).toContain(fact);
    }
    expect(text).toContain('Active look: {"description":"A navy coat with a silver brooch"}');
    expect(text).toContain("Requested scene: In a sunlit library beside one closed red notebook");
    expect(text).not.toContain("green sweater");
    expect(text).not.toContain("old balcony");
    expect(text).not.toContain("bartender");
    expect(profile).toEqual(original);
  });

  it("does not mix current mutable name, presentation, anchor or stable traits into the pinned Look identity", () => {
    const profile = sealedProfile();
    const mutable = { ...character, name: "Mutable Nova", age: 55, gender: "male", style: "anime",
      appearance: { identityAnchor: "Mutable silver-haired face", stableTraits: ["violet eyes", "a new facial tattoo"] },
      advancedDetails: { signature: { age: 55, marks: "new scar" } } };
    const text = lookPortrait(profile, mutable);
    expect(text).toBe(lookPortrait(profile));
    expect(text).toContain("portrait photo of Sealed Raya");
    expect(text).toContain("Subject: adult, female, realistic");
    for (const leak of ["Mutable Nova", "55", "anime", "silver-haired", "violet eyes", "new facial tattoo", "new scar"]) expect(text).not.toContain(leak);
  });

  it("recognizes the derived cache by canonical traits hash when JSONB reorders keys and changes the capped prompt bytes", () => {
    const profile = sealedProfile({ signatureTraits: { description: "Original premise. ".repeat(18),
      detailsMarkdown: "Original old balcony story. ".repeat(15), firstMessage: "Welcome to the old balcony", birthmark: "crescent birthmark" } });
    const oldPrompt = profile.identityPrompt;
    profile.signatureTraits = { firstMessage: "Welcome to the old balcony", birthmark: "crescent birthmark",
      detailsMarkdown: "Original old balcony story. ".repeat(15), description: "Original premise. ".repeat(18) };
    const reassembled = assembleIdentityPrompt({ face: toTraitRecord(profile.faceTraits), hair: toTraitRecord(profile.hairTraits), body: toTraitRecord(profile.bodyTraits),
      signature: toTraitRecord(profile.signatureTraits), style: toTraitRecord(profile.styleTraits) });
    expect(reassembled.identityPrompt).not.toBe(oldPrompt);
    expect(profile.adapterRefs).toMatchObject({ identity: { traitsHash: reassembled.traitsHash } });
    // JSONB key order does not change the sealed content hash, either.
    expect(characterVisualProfileSnapshotHash(profile)).toBe(profile.immutableHash);
    const text = lookPortrait(profile);
    expect(text).not.toContain("green sweater");
    expect(text).not.toContain("Original premise");
    expect(text).toContain("crescent birthmark");
  });

  it("retains unknown non-premise traits beyond the legacy eight-line cap", () => {
    const signatureTraits = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`mark${index}`, `sealed mark ${index}`]));
    const text = lookPortrait(sealedProfile({ signatureTraits }));
    for (let index = 0; index < 10; index++) expect(text).toContain(`sealed mark ${index}`);
  });

  it("keeps full hair and body facts instead of truncating their stable tail", () => {
    const hair = "Natural hair detail. ".repeat(10) + "A single white streak at the left temple";
    const body = "Stable body detail. ".repeat(10) + "A small tattoo on the right wrist";
    const text = lookPortrait(sealedProfile({ hairTraits: { prompt: hair }, bodyTraits: { detail: body } }));
    expect(text).toContain(hair.trim());
    expect(text).toContain(body.trim());
  });

  it("keeps complete projected stable facts beyond Chat's assembled budget", () => {
    const body = "Stable body fact. ".repeat(130) + "Required wrist mark";
    const text = lookPortrait(sealedProfile({ bodyTraits: { detail: body } }));
    expect(text).toContain(body);
    expect(text).toContain('Active look: {"description":"A navy coat with a silver brooch"}');
    expect(text).toContain("Requested scene: In a sunlit library beside one closed red notebook");
    expect(text.length).toBeGreaterThan(2_000);
  });

  it("rejects complete projected stable facts beyond Chat's explicit assembled budget", () => {
    expect(() => buildGenerationPrompt({ mode: "image", character,
      visualProfile: sealedProfile({ bodyTraits: { detail: "Stable body fact. ".repeat(130) + "Required wrist mark" } }),
      consistencyMode: "strict", userPrompt: "In a sunlit library beside one closed red notebook",
      presetFragment: "standing beside a bookshelf", lookFragment: JSON.stringify({ description: "A navy coat with a silver brooch" }),
      sourceType: "chat_image" })).toThrow(/2000-character generation budget/);
  });

  it.each([
    ["manual override", (profile: GenerationVisualProfile) => { profile.adapterRefs = { identity: { source: "manual", assemblerVersion: 1 } }; }],
    ["missing adapter provenance", (profile: GenerationVisualProfile) => { profile.adapterRefs = {}; }],
    ["unknown assembler", (profile: GenerationVisualProfile) => { profile.adapterRefs = { identity: { source: "derived", assemblerVersion: 2, traitsHash: "unknown" } }; }],
    ["stale traits hash", (profile: GenerationVisualProfile) => { profile.adapterRefs = { identity: { source: "derived", assemblerVersion: 1, traitsHash: "mismatch" } }; }],
    ["unsealed identity", (profile: GenerationVisualProfile) => { profile.immutableHash = "mismatch"; }],
    ["no canonical anchor candidate", (profile: GenerationVisualProfile) => { profile.anchorAssetIds = []; }],
    ["different character", (profile: GenerationVisualProfile) => { profile.characterId = "different-character"; }],
    ["only free-text face", (profile: GenerationVisualProfile) => { Object.assign(profile, sealedProfile({ faceTraits: { prompt: "Keep the green sweater identity and unique face" } })); }],
  ] as const)("keeps the original raw identity path for %s", (_label, change) => {
    const profile = sealedProfile();
    change(profile);
    const legacyProfile = { identityPrompt: profile.identityPrompt } as GenerationVisualProfile;
    expect(lookPortrait(profile)).toBe(lookPortrait(legacyProfile));
    expect(lookPortrait(profile)).toContain(`Locked identity: ${profile.identityPrompt}`);
  });

  it.each([
    ["no Look", { lookFragment: "" }],
    ["source edit", { sourceImageAssetId: "owned-edit-source" }],
    ["video", { mode: "video" as const }],
  ])("keeps %s byte-compatible with the original portrait path", (_label, overrides) => {
    const profile = sealedProfile();
    expect(lookPortrait(profile, character, overrides)).toBe(lookPortrait({ identityPrompt: profile.identityPrompt } as GenerationVisualProfile, character, overrides));
  });
});
