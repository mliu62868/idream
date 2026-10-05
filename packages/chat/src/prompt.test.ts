import { describe, expect, it } from "vitest";
import { buildCompanionSystemPrompt, buildTurnPreferencesBlock, buildTurnStateBlock, describeUserLanguage } from "./prompt.js";

const persona = {
  name: "Mira",
  description: "Warm and playful.",
  systemPrompt: "Speak softly.",
  identityPrompt: null,
};

const emptyScene = {
  schemaVersion: 1 as const,
  version: 0,
  location: null,
  time: null,
  participants: [],
  emotionalBeat: null,
  unresolvedThreads: [],
};

describe("companion prompt instruction hierarchy", () => {
  it("keeps the system prompt to the stable layers: Soul first, then the contract and this turn's capabilities", () => {
    const prompt = buildCompanionSystemPrompt({
      persona,
      policy: { memoryEnabled: true },
      recentMessages: [],
      scene: { ...emptyScene, version: 2, location: "home" },
      sceneVersion: 2,
      lastExchangeAt: null,
    } as never);

    expect(prompt.startsWith("Speak softly.")).toBe(true);
    expect(prompt).toContain("iDream companion contract (companion-product-7)");
    expect(prompt).toContain("Write in first person as Mira");
    // An ordinary memory-on turn adds no capability section: nothing about
    // photos or memory mode seeds the reply, and the bytes stay cacheable.
    expect(prompt).not.toContain("This turn:");
    expect(prompt).not.toMatch(/photo|selfie/iu);
    expect(prompt).not.toContain("not instructions");
    expect(prompt).not.toContain("subordinate");
    // Per-turn state must not invalidate the cached prompt prefix.
    expect(prompt).not.toContain("home");
    expect(prompt).not.toContain("Scene: at home");
  });

  it("forbids future-recall promises when the turn has no memory authority", () => {
    const prompt = buildCompanionSystemPrompt({
      persona,
      policy: { memoryEnabled: false },
      recentMessages: [],
      scene: emptyScene,
      sceneVersion: 0,
      lastExchangeAt: null,
    } as never);

    expect(prompt).toContain("never say it is saved or will be remembered");
  });

  it("names the image tools only when the turn authorises them", () => {
    const enabled = buildCompanionSystemPrompt({
      persona,
      policy: { memoryEnabled: true, imageToolEnabled: true },
      recentMessages: [],
      scene: emptyScene,
      sceneVersion: 0,
      lastExchangeAt: null,
    } as never);
    expect(enabled).toContain("call generate_image_async");
    expect(enabled).toContain("call edit_last_image");

    const disabled = buildCompanionSystemPrompt({
      persona,
      policy: { memoryEnabled: true, imageToolEnabled: false },
      recentMessages: [],
      scene: emptyScene,
      sceneVersion: 0,
      lastExchangeAt: null,
    } as never);
    expect(disabled).not.toContain("generate_image_async");
    // Offers are not solicited; a non-photo turn must not read as a prompt to sell one.
    expect(disabled).not.toContain("you may offer");
  });

  it("tells a group member to speak only for itself", () => {
    const prompt = buildCompanionSystemPrompt({
      persona,
      policy: { memoryEnabled: true },
      group: { id: "g", ordinal: 1, members: [{ characterId: "a", sessionId: "s", name: "Mira" }, { characterId: "b", sessionId: "t", name: "Briar" }] },
      recentMessages: [],
      scene: emptyScene,
      sceneVersion: 0,
      lastExchangeAt: null,
    } as never);
    expect(prompt).toContain("You are only Mira");
    expect(prompt).toContain("never write their next reply");
  });
});

describe("per-turn state block", () => {
  it("renders time, elapsed gap and scene as plain lines", () => {
    const block = buildTurnStateBlock({
      scene: {
        ...emptyScene,
        location: "home",
        time: "tonight",
        emotionalBeat: "calm",
        unresolvedThreads: ["pack for the trip"],
      },
      lastExchangeAt: new Date("2026-08-22T15:04:00Z"),
    } as never, new Date("2026-08-24T15:04:00Z"));

    expect(block).toBe([
      "Right now:",
      "- Time: 2026-08-24 15:04 UTC, Monday",
      "- Since you last talked: 2 days",
      "- Scene: at home; tonight; mood: calm; open threads: pack for the trip",
    ].join("\n"));
  });

  it("omits every empty fact so a fresh private turn only learns the time", () => {
    const block = buildTurnStateBlock(
      { scene: emptyScene, lastExchangeAt: null } as never,
      new Date("2026-08-24T15:04:00Z"),
    );

    expect(block).toBe("Right now:\n- Time: 2026-08-24 15:04 UTC, Monday");
  });

  it("describes short gaps in minutes and hours", () => {
    const now = new Date("2026-08-24T15:04:00Z");
    const gap = (ms: number) => buildTurnStateBlock(
      { scene: emptyScene, lastExchangeAt: new Date(now.getTime() - ms) } as never,
      now,
    ).split("\n").at(-1);

    expect(gap(30_000)).toBe("- Since you last talked: moments ago");
    expect(gap(25 * 60_000)).toBe("- Since you last talked: 25 minutes");
    expect(gap(60 * 60_000)).toBe("- Since you last talked: 1 hour");
    expect(gap(5 * 3_600_000)).toBe("- Since you last talked: 5 hours");
  });

  it("writes the user's persona and pinned facts as prose, without ids or versions", () => {
    const block = buildTurnStateBlock({
      scene: emptyScene,
      lastExchangeAt: null,
      userPersona: { enabled: true, version: 3, name: "Sam", description: "29,  nurse,\nlives alone with a parrot" },
      contextDirectives: [
        { id: "pin-1", kind: "pinned_memory", content: "I am allergic to cats", version: 2 },
        { id: "ci-1", kind: "custom_instruction", content: "Keep it playful", version: 1 },
      ],
    } as never, new Date("2026-08-24T15:04:00Z"));

    expect(block).toBe([
      "Right now:",
      "- Time: 2026-08-24 15:04 UTC, Monday",
      "- About Sam, in their own words: 29, nurse, lives alone with a parrot (they go by Sam). This is their current saved profile; use it instead of earlier names or self-descriptions in the conversation history.",
      "- Sam asked you to keep in mind: I am allergic to cats",
    ].join("\n"));
    expect(block).not.toContain("pin-1");
    expect(block).not.toContain("Keep it playful");
  });
});

describe("user language line", () => {
  it("names a non-Latin writing system and stays silent for Latin script", () => {
    expect(describeUserLanguage("今天好累，陪我聊会儿。")).toBe("They are writing in Chinese; answer in Chinese.");
    expect(describeUserLanguage("おはよう")).toBe("They are writing in Japanese; answer in Japanese.");
    expect(describeUserLanguage("안녕")).toBe("They are writing in Korean; answer in Korean.");
    expect(describeUserLanguage("come sit with me")).toBe("");
    expect(describeUserLanguage("ça va, mon amour ?")).toBe("");
  });
});

describe("per-turn preferences block", () => {
  it("is empty when the user saved nothing", () => {
    expect(buildTurnPreferencesBlock({ contextDirectives: [] } as never)).toBe("");
  });

  it("folds the custom instruction and experience choices into one line of prose", () => {
    const block = buildTurnPreferencesBlock({
      contextDirectives: [{ id: "ci-1", kind: "custom_instruction", content: "Call me Sam.", version: 1 }],
      experience: { version: 1, responseLength: "short", interactionIntensity: "expressive", sceneGeneration: "advance" },
    } as never);
    expect(block).toBe("Their preferences for this conversation: Call me Sam. Keep replies to one to three sentences. Let the scene move forward a beat when it fits, one detail or action at a time, without deciding their actions. Be more vivid, confident and playful, within who you are and the pace they set.");
  });
});
