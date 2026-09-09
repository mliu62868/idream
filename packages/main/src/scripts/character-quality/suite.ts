import { createHash } from "node:crypto";
import { hasUnexecutedMemorySearchPayload } from "@idream/shared/chat/companion-runtime";

export const QUALITY_SUITE_VERSION = "core-experience-20260906";
// Version the measured scenario independently of its report/cleanup schema.
// Reports made with the old marker must remain failed historical samples.
export const QUALITY_PROMPT_VERSION = 2;
export const QUALITY_ACTOR = "seed-chat-probe-user";
export const QUALITY_CASES = [
  { key: "navigator", characterId: "cmsozhlsn0023i2l7m71veczu", actorId: QUALITY_ACTOR, focus: "沉稳的成年航海向导；保留用户选择与旅程连续性", opening: "We are planning an afternoon sail. I am an adult, 27. The weather is changing; help me choose one practical next step without deciding my actions for me.", advance: "I choose the sheltered harbor, not the open sea. I place a blue notebook beside the window. Let the scene move forward from that choice." },
  { key: "photographer", characterId: "682d1e44-7e6b-4139-ac05-c2c108d68be2", actorId: QUALITY_ACTOR, focus: "温暖机智的成年城市摄影师；具体观察与共同创作", opening: "I am an adult, 27. We have twenty minutes for a photo walk. Show me one ordinary street detail worth noticing, and leave me room to respond.", advance: "I choose the quiet side street, not the busy square. I place a blue notebook beside the window. Continue our walk with one new detail." },
  { key: "social", characterId: "alexa-reeves", actorId: QUALITY_ACTOR, focus: "自信的成年社交角色；鲜明声音与用户边界", opening: "I am an adult, 27. We are on the yacht deck before sunset. I prefer a relaxed conversation today. What catches your attention?", advance: "I choose a quiet seat on deck, not the party below. I place a blue notebook beside the window. Continue the scene while respecting that choice." },
  { key: "gardener", characterId: "cmtk80uim008bxnl7vpt0fx08", actorId: "cmtk2vdam000cxol77dffco0u", focus: "成年男性园艺伙伴；好奇、轻松和可执行的小行动", opening: "I am an adult, 27. I have a small balcony and have never grown anything. Introduce one small gardening activity we can try together.", advance: "I choose growing basil, not roses. I place a blue notebook beside the window. Show what happens next without claiming I already completed the work." },
  { key: "creative", characterId: "cmtoe3x170030w6l7hw3p2oxk", actorId: "cmtocz5pw0006w6l7zrxxmlsh", focus: "成年水彩老师；务实教学、鼓励与共同创作", opening: "I am an adult, 27. I am new to watercolor and want to paint outdoors. Suggest one small exercise we can try together, and leave space for my choices.", advance: "I choose a rainy bookshop scene, not a sunny beach. I place a blue notebook beside the window. Build on that choice and leave my actions to me." },
] as const;

export type QualityCase = typeof QUALITY_CASES[number];
export type QualityStage = "opening" | "advance" | "recall" | "image" | "edit";
export function qualityPrompts(scenario: QualityCase, runId: string) {
  const sentinel = `idreamrecall_${createHash("sha256").update(`${runId}:${scenario.key}`).digest("hex").slice(0, 32)}`;
  return {
    sentinel,
    opening: `${scenario.opening} Reply in English, in at most four sentences.`,
    advance: `${scenario.advance} The exact label on my notebook is ${sentinel}. Remember the label for our next conversation. Reply in English, in at most four sentences.`,
    recall: "In our previous conversation, what was the exact label on my notebook, what color was it, and where did I put it? Recall the earlier facts; do not invent a replacement. Reply in English, in at most four sentences.",
    image: "Please generate one non-explicit picture of yourself as an adult in our current scene, fully clothed, waist-up, with the blue notebook visible beside the window. Keep your established face and hairstyle. Make the picture now.",
    edit: "Edit the picture you just sent: change only the notebook from blue to green. Preserve the same face, hairstyle, clothes, pose, background and camera framing. Make the edited picture now.",
  };
}

export function qualityTurnCheckNames(stage: QualityStage) {
  return ["stream", "mainTerminal", "soulPin", "visualPin", "dshAuthority", "memoryProjection", "nonempty", "memoryToolPayloadNotLeaked", ...(stage === "recall" ? ["exactPriorLabel", "priorColor", "priorLocation", "memorySource"] : [])].map((key) => `${stage}.${key}`);
}

export function requireQualityChecks(checks: Record<string, boolean>, names: readonly string[]) {
  const failed = names.filter((name) => checks[name] !== true);
  if (failed.length) throw new Error(`Quality evidence is incomplete or failed: ${failed.join(", ")}`);
}

export function requireQualityPromptVersion(version: number | undefined) {
  if (version !== QUALITY_PROMPT_VERSION) throw new Error("Quality prompt version changed; preserve the old sample, pin a new manifest and use a new report");
}

export function qualityVoiceContinuation(status: string | null) {
  if (status === null) return "submit";
  if (status === "running") return "observe";
  if (status === "succeeded") return "reuse";
  throw new Error(`The original Voice request is ${status}; resume must not create another provider attempt`);
}

export function qualityVoiceUsageFacts(mediaAssetId: string, facts: readonly { mediaAssetId: string | null; costDreamcoins: number }[]) {
  // A failed/skipped provider attempt may retain a non-delivery usage fact.
  // That history must not excuse duplicate delivery or positive charges.
  return {
    voiceSingleDelivery: facts.filter((fact) => fact.mediaAssetId === mediaAssetId).length === 1,
    voiceSingleCharge: facts.filter((fact) => fact.costDreamcoins > 0).length <= 1,
  };
}

export function qualityTextFacts(input: { stage: QualityStage; text: string; sentinel: string }) {
  const recall = input.stage === "recall";
  return {
    nonempty: input.text.trim().length > 0,
    memoryToolPayloadNotLeaked: !hasUnexecutedMemorySearchPayload(input.text),
    ...(recall ? {
      exactPriorLabel: input.text.includes(input.sentinel),
      priorColor: /\bblue\b/i.test(input.text),
      priorLocation: /\bwindow\b/i.test(input.text),
    } : {}),
  };
}

export function qualitySummary(input: {
  checks: Record<string, boolean>;
  requestedMedia: boolean;
  finishedText: boolean;
  finishedMedia: boolean;
  sourceRevisions?: readonly string[];
  error?: string;
}) {
  const automaticFactsPassed = Object.values(input.checks).length > 0 && Object.values(input.checks).every(Boolean);
  const sourceRevisionConsistent = Boolean(input.sourceRevisions?.length) && new Set(input.sourceRevisions).size === 1;
  return {
    automaticFactsPassed,
    execution: input.error || !automaticFactsPassed ? "failed" : input.finishedText && (!input.requestedMedia || input.finishedMedia) ? "completed" : "incomplete",
    scope: input.requestedMedia ? "text-image-edit-voice" : "text-only",
    fullExperienceComplete: input.finishedText && input.finishedMedia && automaticFactsPassed && sourceRevisionConsistent && !input.error,
    sourceRevisionConsistent,
    subjectiveReview: "pending",
    productQualityApproved: false,
  };
}

export const QUALITY_REVIEW = [
  { dimension: "角色区分度", question: "仅看回复能否辨认这个角色？引用具体措辞或行为，与另外四个角色比较。", evidence: "opening/advance transcripts" },
  { dimension: "事实与用户自主权", question: "是否保持用户选择、物品、位置与边界？是否代替用户行动或虚构共同过去？", evidence: "advance/recall transcripts" },
  { dimension: "自然度与推进", question: "是否具体、生动并提供可回应的新进展？是否重复总结、说教或机械提问？", evidence: "all transcripts" },
  { dimension: "视觉身份与局部编辑", question: "对照固定参考图、生成图、编辑图：脸和发型是否稳定？是否仅改变笔记本颜色？构图是否保留？", evidence: "pinned visual references + image/edit assets" },
  { dimension: "声音匹配", question: "实际听完整音频：是否符合角色年龄、气质与表达？是否有错读、截断和不自然停顿？", evidence: "voice asset + exact spoken text + authority version" },
  { dimension: "等待与回访价值", question: "等待是否值得？回到历史后是否能自然继续？记录愿意继续或放弃的具体原因。", evidence: "elapsed timings + browser history revisit" },
].map((item) => ({ ...item, verdict: "pending", reviewer: null, reviewedAt: null, notes: null }));

export function requireFiveBindings(ids: readonly string[]) {
  if (ids.length !== 5 || ids.some((id) => !id.trim()) || new Set(ids).size !== 5) {
    throw new Error("Bind exactly five distinct Character IDs in navigator,photographer,social,gardener,creative order");
  }
  return ids.map((characterId, index) => ({ ...QUALITY_CASES[index]!, characterId }));
}

export function assertQualityActor(actor: { id: string; role: string; status: string; dataClass: string; deletedAt: Date | null } | null, actorId: string) {
  if (!actor || actor.id !== actorId || actor.role !== "user" || actor.status !== "active" || actor.dataClass !== "audit" || actor.deletedAt !== null) throw new Error("Character quality requires an existing active audit user");
}
