import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BuiltContext } from "./context.js";
import { compilePreparedTurn, projectPreparedBody } from "./prepared-turn.js";
import { resolvePolicy } from "./policy.js";
import {
  canSkipMediaExtractionForPureMedia,
  describeRequestedReplyConstraints,
  describeUserLanguage,
  needsFactualSampling,
  replyCues,
  shouldBufferMediaLeadText,
  shouldPreRecall,
} from "./reply-cues.js";

const NOW = new Date("2026-11-26T08:00:00.000Z");

function context(userText: string): BuiltContext {
  const policy = {
    ...resolvePolicy({ modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true }),
    imageToolEnabled: true,
  };
  return {
    userLocale: "en",
    hasRecentImageContext: false,
    imageActionMode: "chat",
    persona: {
      characterId: "character-1", creatorId: null, name: "Mara", age: 31,
      description: "A precise adult companion.", systemPrompt: "Stay specific and grounded.",
      visibility: "public", status: "approved", deletedAt: null, voiceId: null, visualProfileId: null,
      visualProfileVersion: null, identityPrompt: null, imageToolEnabled: true, contentVersion: null, release: null,
      characterContentVersionId: "content-1", characterReleaseId: "release-1",
      soulFingerprint: "a".repeat(64), compilerVersion: "character-soul-3",
    },
    policy,
    recentMessages: [
      { id: "message-0", role: "user", content: "We met at the library yesterday." },
      { id: "message-1", role: "assistant", content: "I remember the rain on the windows." },
      { id: "message-2", role: "user", content: userText },
    ],
    scene: { schemaVersion: 1, version: 1, location: "the library", time: "tonight", participants: ["Mara"],
      emotionalBeat: "calm", unresolvedThreads: [] },
    sceneVersion: 1,
    lastExchangeAt: null,
    dropped: [],
    contextRevision: 0n,
  };
}

// Each sample triggers at least one cue: language line, sentence/action
// counts, companionship scope, preference scope, or none at all.
const SAMPLES = [
  "hi",
  "我们上次在图书馆聊了什么？",
  "Answer in exactly two sentences: what is your favorite book?",
  "Describe three actions of your own while we wait.",
  "Don't analyze it. Just sit with me quietly and say one sentence.",
  "Why do you like rainy evenings?",
  "用一句话回答：你喜欢下雨吗？",
  "Send me a selfie from the library.",
  "今日は何をしていたの？",
] as const;

function compiledDigest(userText: string, options?: { replyCues?: boolean }): string {
  const { context: _context, ...wire } = options
    ? compilePreparedTurn(context(userText), "message-2", NOW, options)
    : compilePreparedTurn(context(userText), "message-2", NOW);
  // Tool schemas and the budget estimate derived from them are not cue
  // output; digest the prompt bytes the cues can affect.
  return createHash("sha256").update(JSON.stringify({ messages: wire.messages, replyPrompt: wire.replyPrompt, trace: wire.trace })).digest("hex");
}

describe("reply cues", () => {
  // INVARIANT: consolidating the cues must not move a single prompt byte.
  // These digests were computed from the pre-consolidation compiler
  // (b559da959) for the same fixture and samples.
  it("keeps default compiled Turns byte-identical to the pre-consolidation compiler", () => {
    expect(SAMPLES.map(sample => compiledDigest(sample))).toEqual(GOLDEN_DIGESTS);
    expect(SAMPLES.map(sample => compiledDigest(sample, { replyCues: true }))).toEqual(GOLDEN_DIGESTS);
  });

  it("compiles the same Turn without wording cues for offline evaluation", () => {
    const enabled = compilePreparedTurn(context("用一句话回答：你喜欢下雨吗？"), "message-2", NOW);
    const disabled = compilePreparedTurn(context("用一句话回答：你喜欢下雨吗？"), "message-2", NOW, { replyCues: false });
    const state = (turn: typeof enabled) => turn.messages.find(message => message.id === "state:message-2")!.content;
    expect(state(enabled)).toContain("They are writing in Chinese; answer in Chinese.");
    expect(state(enabled)).toContain("Their current request specifies exactly 1 sentence");
    expect(state(disabled)).not.toContain("They are writing in");
    expect(state(disabled)).not.toContain("Their current request specifies");
    // Everything that is not a cue stays identical.
    expect(disabled.messages.filter(message => message.id !== "state:message-2"))
      .toEqual(enabled.messages.filter(message => message.id !== "state:message-2"));
    expect(state(disabled).split("\n").every(line => state(enabled).split("\n").includes(line))).toBe(true);
    expect(disabled.tools).toEqual(enabled.tools);
  });

  it("projects a media body without cues while keeping the structural multi-request line", () => {
    const prepared = compilePreparedTurn(context("发张自拍。另外用一句话解释潮汐。"), "message-2", NOW);
    const current = prepared.messages.find(message => message.sourceKind === "current_user");
    if (!current || current.role !== "user") throw new Error("missing current user");
    const withCues = projectPreparedBody(prepared, current, "另外用一句话解释潮汐。", false);
    const withoutCues = projectPreparedBody(prepared, current, "另外用一句话解释潮汐。", false, { replyCues: false });
    const state = (body: typeof withCues) => body.preparedTurn.messages.find(message => message.id === "state:message-2")!.content;
    expect(state(withCues)).toContain("answer in Chinese");
    expect(state(withoutCues)).not.toContain("answer in Chinese");
    const multiple = projectPreparedBody(prepared, current, "A\n\nB", true, { replyCues: false });
    expect(state(multiple)).toContain("Answer each independent request in order.");
  });

  it("exposes neutral behavior through the single switch", () => {
    const on = replyCues();
    const off = replyCues({ replyCues: false });
    expect(on.enabled).toBe(true);
    expect(off.enabled).toBe(false);
    expect(on).toBe(replyCues({ replyCues: true }));
    expect([on.shouldPreRecall("hi"), off.shouldPreRecall("hi"), off.shouldPreRecall("  ")]).toEqual([false, true, false]);
    expect([on.needsFactualSampling("copy it verbatim"), off.needsFactualSampling("copy it verbatim")]).toEqual([true, false]);
    const textOnly = { hasMediaTools: true, currentUserText: "How was your day?" };
    expect([on.shouldBufferMediaLeadText(textOnly), off.shouldBufferMediaLeadText(textOnly)]).toEqual([false, true]);
    expect(off.shouldBufferMediaLeadText({ ...textOnly, hasMediaTools: false })).toBe(false);
    expect([on.canSkipMediaExtractionForPureMedia("Send a selfie.", false), off.canSkipMediaExtractionForPureMedia("Send a selfie.", false)]).toEqual([true, false]);
    expect([on.describeUserLanguage("你好"), off.describeUserLanguage("你好")]).toEqual(["They are writing in Chinese; answer in Chinese.", ""]);
    expect(off.describeRequestedReplyConstraints("Answer in exactly two sentences.")).toBe("");
    expect(off.describeRequestedReplyConstraints("x", true)).toBe(on.describeRequestedReplyConstraints("x", true));
  });

  it("keeps the enabled cue set equal to the exported functions", () => {
    const on = replyCues();
    expect(on.shouldPreRecall).toBe(shouldPreRecall);
    expect(on.needsFactualSampling).toBe(needsFactualSampling);
    expect(on.shouldBufferMediaLeadText).toBe(shouldBufferMediaLeadText);
    expect(on.canSkipMediaExtractionForPureMedia).toBe(canSkipMediaExtractionForPureMedia);
    expect(on.describeUserLanguage).toBe(describeUserLanguage);
    expect(on.describeRequestedReplyConstraints).toBe(describeRequestedReplyConstraints);
  });
});

const GOLDEN_DIGESTS: string[] = [
  "57d2e65e1a1006f966638ac9d95165eeefec9a885007c3c86277cfa9f0a009ac",
  "56acd3f3c0ca91453bd937d820c6287938329fe79787c317791972abd5963048",
  "ed2f469be268881799337b3ed49704e902a0faf417014bf9940f13250b2f3e10",
  "bdce74339f2a3d3300ed0dfac4032107f7fd45b086f8fde29e61097f98a5268f",
  "30e62050447cff2cc1cbeb20b3ace83aab9fa867c15f3ab1425a66670d7914ce",
  "274ab6f57fa94a068bd3f7a0ee50fc1c95fa0cd18a6bb8aba4856b139b37d32d",
  "a825570963c065adcac8877c412362cee079e37870408024ee884f44616d89ca",
  "170e9b47cf8778869aa042f6c3df7f5058e2389d69b36d7a01ac4513c03d3d83",
  "e4af7ac5210676b33d37cd638abb748daaa96d36e55e732ce8a4a273b056bb11",
];
