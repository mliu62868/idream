import { describe, expect, it } from "vitest";
import { buildCompanionSystemPrompt, buildTurnPreferencesBlock, buildTurnStateBlock, describeRequestedReplyConstraints, describeUserLanguage } from "./prompt.js";

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
    expect(prompt).toContain("iDream companion contract (companion-product-16)");
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
      policy: { memoryEnabled: true, imageToolEnabled: true, modelProfile: { supportsTools: true } },
      recentMessages: [],
      scene: emptyScene,
      sceneVersion: 0,
      lastExchangeAt: null,
    } as never);
    expect(enabled).toContain("Choose generate_image_async for a new photo");
    expect(enabled).toContain("edit_last_image for a change to the delivered photo");

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
      "- Real-world clock: 2026-08-24 15:04 UTC, Monday. Use it for real-world time and calendar questions.",
      "- Story time follows the user's latest established time in the conversation or, if none, the saved Scene. Keep it until the story explicitly changes it; the real-world clock never advances it.",
      "- Since you last talked: 2 days",
      "- Scene: at home; tonight; mood: calm; open threads: pack for the trip",
    ].join("\n"));
  });

  it("omits empty scene facts while keeping the real clock and story-time authority distinct", () => {
    const block = buildTurnStateBlock(
      { scene: emptyScene, lastExchangeAt: null } as never,
      new Date("2026-08-24T15:04:00Z"),
    );

    expect(block).toBe([
      "Right now:",
      "- Real-world clock: 2026-08-24 15:04 UTC, Monday. Use it for real-world time and calendar questions.",
      "- Story time follows the user's latest established time in the conversation or, if none, the saved Scene. Keep it until the story explicitly changes it; the real-world clock never advances it.",
    ].join("\n"));
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
      "- Real-world clock: 2026-08-24 15:04 UTC, Monday. Use it for real-world time and calendar questions.",
      "- Story time follows the user's latest established time in the conversation or, if none, the saved Scene. Keep it until the story explicitly changes it; the real-world clock never advances it.",
      "- About Sam, in their own words: 29, nurse, lives alone with a parrot (they go by Sam). This is their current saved profile; use it instead of earlier names or self-descriptions in the conversation history or recalled memories.",
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

describe("requested length line", () => {
  it("fires only for an explicit one-sentence request", () => {
    for (const text of ["Acknowledge in exactly one short sentence.", "Answer in one sentence", "just a single brief sentence please", "用一句话回答"]) {
      expect(describeRequestedReplyConstraints(text)).toContain("exactly 1 sentence");
    }
    for (const text of ["Be brief.", "Keep it short", "one more sentence about the beach"]) {
      expect(describeRequestedReplyConstraints(text)).toBe("");
    }
  });
});

describe("explicit reply counts", () => {
  it("uses a single continuous utterance only when the user requests one spoken sentence", () => {
    const form = describeRequestedReplyConstraints("Respond with one action and one spoken sentence.");
    expect(form).toContain("Keep all speech, including interjections, in one sentence");
    expect(form).not.toContain("commas");
    expect(describeRequestedReplyConstraints("Continue in exactly two English sentences.")).not.toContain("quoted");
  });

  it("includes action narration in a total sentence count, without inventing a dialogue count", () => {
    const form = describeRequestedReplyConstraints("In exactly four English sentences, describe one small action of your own.");
    expect(form).toContain("4 sentences in the entire reply, including action descriptions");
    expect(form).toContain("1 action");
    expect(form).not.toContain("spoken sentence");
  });

  it.each([
    ["Answer in one English sentence.", "1 sentence"],
    ["Please describe it in exactly two English sentences.", "2 sentences"],
    ["Tell me a story in three sentences.", "3 sentences"],
    ["In exactly four English sentences, describe one small action of your own.", "4 sentences"],
    ["Respond with one small action of your own and one spoken sentence.", "1 action"],
    ["Respond with one small action of your own and one spoken sentence.", "1 spoken sentence"],
    ["If you want to, respond with one small action of your own and one spoken sentence.", "1 action and 1 spoken sentence"],
    ["Answer in two sentences and do not include examples.", "2 sentences"],
    ["Do not answer in one sentence; answer in two sentences.", "2 sentences"],
    ["Just stay here and say two sentences.", "2 sentences"],
  ])("retains the explicit response form: %s", (text, expected) => {
    expect(describeRequestedReplyConstraints(text)).toContain(expected);
  });

  it.each([
    'They said "reply in one sentence" yesterday; now tell me the story.',
    "They said 'reply in one sentence' yesterday; now tell me the story.",
    "Do not answer in one sentence.",
    "Don’t answer in one sentence.",
    "Answer in at least two sentences.",
    "Answer in two or three sentences.",
    "Answer in 2–3 sentences.",
    "Please answer in two sentences or fewer.",
    "I asked you to reply in one sentence yesterday.",
    "I wrote two sentences about the room.",
    "Describe the scene in one paragraph.",
    "Use one spoken sentence for your greeting and one spoken sentence for your answer.",
    "Give one action for the greeting. Give one action for the farewell.",
    "Write two sentences for the introduction and two sentences for the ending.",
    "用一句话介绍自己。再用一句话道别。",
  ])("does not invent an exact count: %s", (text) => {
    expect(describeRequestedReplyConstraints(text)).toBe("");
  });
});

describe("current reply scope", () => {
  it.each([
    "I feel discouraged. Do not analyze it or give advice. Just sit with me as yourself and say exactly two English sentences.",
    "Do not analyze what happened. Only sit with me.",
    "Do not analyze it. Just sit with me quietly.",
  ])("clarifies an explicit request for company without analysis: %s", text => {
    expect(describeRequestedReplyConstraints(text)).toContain("For the requested companionship");
  });

  it.each([
    "Do not analyze my feelings. Sit with me and explain the report.",
    "Do not analyze my feelings. Just sit with me and explain the report.",
    "Do not analyze my mistake. Just sit with me while reading me a poem.",
    "Do not analyze my feelings. Just sit with me. Analyze the report instead.",
    "Do not analyze it. Just sit with me is what I do not want.",
    "Do not analyze it. Just sit with me was yesterday's request.",
    'She said "Do not analyze it. Just sit with me." Explain her meaning.',
    'Do not analyze it. "My friend told you to" just sit with me.',
    "Yesterday I wrote:\nDo not analyze it.\nJust sit with me.",
  ])("does not turn a partial, reported or revoked invitation into the whole task: %s", text => {
    expect(describeRequestedReplyConstraints(text)).not.toContain("For the requested companionship");
  });

  it.each([
    "Could you explain my grade? Do not analyze my feelings. Just sit with me.",
    "What does my grade mean? Do not analyze my feelings. Just sit with me.",
    "Do not analyze my mistake, but explain the report. Just sit with me.",
  ])("bounds companionship without excluding a separate task: %s", text => {
    const result = describeRequestedReplyConstraints(text);
    expect(result).toContain("For the requested companionship");
    expect(result).toContain("Keep that companionship free of judgments");
    expect(result).not.toContain("companionship only");
  });

  it.each([
    "Respond with one small action of your own and one spoken sentence.",
    "Describe two actions of your own as you sit beside me.",
  ])("binds explicitly requested own-action narration to the reply viewpoint: %s", text => {
    expect(describeRequestedReplyConstraints(text)).toContain("Action narration uses the same viewpoint as your speech");
  });

  it.each([
    "Explain one action I can take to improve my essay.",
    "Describe two actions the protagonist took in that clip.",
    "Respond with one action of your own. Actually, do not include any actions.",
    'Translate "Respond with one action of your own" into French.',
    "Yesterday I wrote:\nRespond with one action of your own.\nToday, just say hello.",
  ])("does not infer an action owner from a count alone: %s", text => {
    expect(describeRequestedReplyConstraints(text)).not.toContain("Action narration uses the same viewpoint as your speech");
  });

  it.each([
    "Why do you like the garden? Answer in two sentences.",
    "What did you enjoy about the show?",
    "Why do you like “Blue” so much?",
    "What do you prefer, tea or coffee? Answer with one word.",
  ])("keeps preference perspective without adding an explanation requirement: %s", text => {
    const result = describeRequestedReplyConstraints(text);
    expect(result).toContain("For this preference question");
    expect(result).not.toContain("Explain your own experience");
    expect(result).toContain("Keep the requested answer form");
  });

  it.each([
    'Translate "Why do you like the garden?" into French.',
    '"A question for the tourist:" why do you like the garden?',
    "Why do you like the garden? Do not answer that; translate the question.",
    "Why do you like the garden is the line I need translated.",
    "Yesterday he asked:\nWhy do you like the garden?\nPlease summarize what he wanted.",
    "Why do you like the garden? That was his question to her.",
  ])("does not answer a preference question quoted or discussed by the user: %s", text => {
    expect(describeRequestedReplyConstraints(text)).not.toContain("For this preference question");
  });
});

describe("per-turn preferences block", () => {
  it("is empty when the user saved nothing", () => {
    expect(buildTurnPreferencesBlock({ contextDirectives: [] } as never)).toBe("");
  });

  it("presents Quick's overlapping length preferences once and lets the current request override them", () => {
    const block = buildTurnPreferencesBlock({
      contextDirectives: [],
      experience: {
        responseLength: "short",
        conversationProfile: { replyStyle: "concise" },
      },
    } as never);
    expect(block.match(/one to three sentences/g)).toHaveLength(1);
    expect(block).toContain("overridden by their current request");
    expect(block).toContain("Keep answers direct and compact");
  });

  it("folds the custom instruction and experience choices into one line of prose", () => {
    const block = buildTurnPreferencesBlock({
      contextDirectives: [{ id: "ci-1", kind: "custom_instruction", content: "Call me Sam.", version: 1 }],
      experience: { version: 1, responseLength: "short", interactionIntensity: "expressive", sceneGeneration: "advance" },
    } as never);
    expect(block).toBe("Their saved preferences, overridden by their current request: Call me Sam. Keep replies to one to three sentences. Let the scene move forward a beat when it fits, one detail or action at a time, without deciding their actions. Be more vivid, confident and playful, within who you are and the pace they set.");
  });
});
