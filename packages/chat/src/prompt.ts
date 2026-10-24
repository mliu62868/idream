// Companion prompt assembly is a single deep module: callers provide BuiltContext
// and do not need to know instruction ordering or data encoding.
import {
  composeCompanionSystemPrompt,
} from "@idream/shared";
import { identityPromptLine, type BuiltContext } from "./context.js";
import type { SceneState } from "./scene.js";

/**
 * SPEC: the system prompt carries only what stays constant across a
 * character's turns — the pinned Soul and the product contract, including
 * identity precedence when a saved user persona is enabled. Persona values,
 * Scene and time travel in `buildTurnStateBlock`, in background context
 * before the unchanged current user message.
 * INTENT: the local model server caches prompt prefixes in 2048-token blocks
 * (measured 2026-08-24: an identical prefix cut first-token latency from
 * 2.2 s to 0.45 s). Per-turn data inside the system prompt invalidated that
 * cache on every message; next to the current message it is also where a
 * roleplay model weighs it most.
 */
export function buildCompanionSystemPrompt(context: BuiltContext): string {
  const persona = context.persona;
  const prompt = composeCompanionSystemPrompt({
    memoryEnabled: context.policy.memoryEnabled,
    imageToolEnabled: context.policy.imageToolEnabled && context.policy.modelProfile.supportsTools,
    soulPrompt: persona.systemPrompt ?? persona.description,
    identityPromptLine: identityPromptLine(persona),
    characterName: persona.name,
  });
  const layers = [prompt];
  // INTENT: a real group greeting chose an old remembered name over the
  // enabled profile. Keep the stable authority rule here while both the
  // current profile and historical resident facts remain turn context.
  if (context.userPersona?.enabled) {
    layers.push("When the turn includes a current saved chat persona, use it for the user's identity. It overrides conflicting names or self-descriptions in resident profiles, recalled memories and conversation history. It describes the user, never your Character identity.");
  }
  if (context.group) {
    layers.push(`Group conversation: several Characters share this chat and the user picks who answers each time. You are only ${persona.name}. Speak only for yourself; the other Characters' lines, actions and memories are theirs, and you never write their next reply.`);
  }
  return layers.join("\n\n");
}

/**
 * Per-turn facts as short plain lines: the time, how long it has been, where
 * the scene is, who the user says they are. Empty facts are omitted — a
 * companion is not told "location: null".
 *
 * INTENT: until 2026-10-04 these lines carried JSON.stringify'd objects with
 * ids and version numbers and were labelled "(data, not instructions)" four
 * times over. Ids and versions are evidence for Main, not for the Character;
 * the labels were quoted back verbatim in at least one reply. Plain prose it is.
 */
export function buildTurnStateBlock(context: BuiltContext, now: Date): string {
  const userPersona = context.userPersona?.enabled ? context.userPersona : null;
  const them = userPersona?.name?.trim() || "them";
  // INTENT: an unlabeled runtime clock overrode the user's "midnight" scene
  // in a real follow-up. Keep calendar authority separate from story continuity.
  const lines = [
    `Real-world clock: ${formatUtc(now)}. Use it for real-world time and calendar questions.`,
    "Story time follows the user's latest established time in the conversation or, if none, the saved Scene. Keep it until the story explicitly changes it; the real-world clock never advances it.",
  ];
  if (context.lastExchangeAt) {
    lines.push(`Since you last talked: ${describeGap(now.getTime() - context.lastExchangeAt.getTime())}`);
  }
  const scene = describeScene(context.scene);
  if (scene) lines.push(`Scene: ${scene}`);
  if (context.group) {
    lines.push(`In this chat: ${context.group.members.map(({ name }) => name).join(", ")}`);
    lines.push(`Replying now: ${context.persona.name}`);
  }
  if (userPersona) {
    lines.push(`About ${them}, in their own words: ${oneLine(userPersona.description)}${userPersona.name ? ` (they go by ${userPersona.name})` : ""}. This is their current saved profile; use it instead of earlier names or self-descriptions in the conversation history or recalled memories.`);
  }
  const pins = context.contextDirectives?.filter((item) => item.kind === "pinned_memory") ?? [];
  for (const pin of pins) lines.push(`${them === "them" ? "They" : them} asked you to keep in mind: ${oneLine(pin.content)}`);
  return ["Right now:", ...lines.map((line) => `- ${line}`)].join("\n");
}

/** Saved expression choices are the user's own instructions for how to be talked to. */
export function buildTurnPreferencesBlock(context: BuiltContext): string {
  const instruction = context.contextDirectives?.find((item) => item.kind === "custom_instruction");
  const experience = context.experience;
  const profile = experience?.conversationProfile;
  const lines = [
    ...(instruction ? [sentence(oneLine(instruction.content))] : []),
    ...(profile?.replyStyle === "concise" ? ["Keep answers direct and compact, one to three sentences."] : []),
    ...(profile?.replyStyle === "story" ? ["Use rich but purposeful scene detail and dialogue, developing the moment without choosing their actions."] : []),
    ...(experience?.responseLength === "short" && profile?.replyStyle !== "concise" ? ["Keep replies to one to three sentences."] : []),
    ...(experience?.responseLength === "long" ? ["Replies can run longer, with real detail, dialogue and observation; no filler."] : []),
    ...(experience?.sceneGeneration === "follow" ? ["Follow their lead on the scene; leave the next change of setting or plot to them."] : []),
    ...(experience?.sceneGeneration === "advance" ? ["Let the scene move forward a beat when it fits, one detail or action at a time, without deciding their actions."] : []),
    ...(experience?.interactionIntensity === "gentle" ? ["Stay gentle, unhurried and understated; let them set the pace."] : []),
    ...(experience?.interactionIntensity === "expressive" ? ["Be more vivid, confident and playful, within who you are and the pace they set."] : []),
  ];
  if (lines.length === 0) return "";
  return `Their saved preferences, overridden by their current request: ${lines.join(" ")}`;
}

/**
 * SPEC: one deterministic line naming the writing system of the current user
 * message, for scripts the model otherwise drifts away from. Latin-script
 * messages get nothing: English is the default register of the whole prompt.
 * INTENT: with the prompt and turn context in English, 1 of 4 Chinese
 * samples came back in English and the rest mixed English words in (A/B
 * 2026-10-04, Han ratio 0.66 vs 0.85). The reply language is a fact about
 * the user's message, so it is stated as one, next to the message.
 */
export function describeUserLanguage(userText: string): string {
  const scripts: Array<[RegExp, string]> = [
    [/\p{Script=Hiragana}|\p{Script=Katakana}/u, "Japanese"],
    [/\p{Script=Hangul}/u, "Korean"],
    [/\p{Script=Han}/u, "Chinese"],
    [/\p{Script=Cyrillic}/u, "Russian"],
    [/\p{Script=Arabic}/u, "Arabic"],
    [/\p{Script=Devanagari}/u, "Hindi"],
    [/\p{Script=Thai}/u, "Thai"],
  ];
  const language = scripts.find(([pattern]) => pattern.test(userText))?.[1];
  return language ? `They are writing in ${language}; answer in ${language}.` : "";
}

// INTENT: Keep explicit current-request constraints next to the original text.
// These optional cues abstain on ambiguous/reporting syntax; the unchanged
// message remains authoritative. A quote is a barrier, never deleted into a
// new imperative assembled from words on either side.
export function describeRequestedReplyConstraints(userText: string): string {
  const unquoted = userText.replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”|‘[^’]*’|(?<!\w)'[^'\n]+'(?!\w)/gu, "\uFFFC");
  if (/\b(?:actually|instead|ignore|forget|retract)\b/iu.test(unquoted)
    || /[\r\n]/u.test(userText) && /\b(?:said|asked|wrote)\s*:/iu.test(unquoted)) return "";
  const counts = new Map<string, number>();
  let ownActions = true;
  const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const number = `(?:a single|${words.join("|")}|[1-9]\\d?)`;
  const pattern = new RegExp(`\\b(?:(?:exactly|just|only)\\s+)?(${number})\\s+(?:(?:short|brief|English|small|spoken)\\s+)*(sentences?|actions?)\\b`, "giu");
  const range = new RegExp(`\\b${number}\\s*(?:or|to|[-–])\\s*${number}\\b`, "iu");
  for (const clause of unquoted.split(/[.!?;\n]/u)) {
    if (range.test(clause) || /\b(?:at least|at most|up to|more than|less than|fewer than|between|or fewer|or less)\b/iu.test(clause)) continue;
    const requested = /^\s*(?:(?:please|just|only)\s+)?(?:if\b[^,]*,\s*)?(?:(?:in|with)\b[^,]*,\s*)?(?:answer|reply|respond|say|write|tell|describe|give|continue|acknowledge|summari[sz]e|explain|state|use|keep|limit|check|sit|stay|talk|speak)\b/iu.test(clause);
    for (const match of clause.matchAll(pattern)) {
      const before = clause.slice(0, match.index);
      if (/\b(?:not|never|avoid|don['’]t)\b/iu.test(before)) continue;
      if (!requested && !/^\s*(?:in\s+)?$/iu.test(before)) continue;
      const raw = match[1]!.toLowerCase();
      const count = raw === "a single" ? 1 : words.includes(raw) ? words.indexOf(raw) + 1 : Number(raw);
      const kind = match[2]!.toLowerCase().startsWith("action") ? "action"
        : /\bspoken\b/iu.test(match[0]) ? "spoken sentence" : "sentence";
      if (kind === "action") ownActions &&= /^\s+of\s+your\s+own\b/iu.test(clause.slice(match.index + match[0].length))
        || /\byour\s+own\s*$/iu.test(before);
      // Repeated counts may describe separate parts, even when equal. Leave
      // their composition to the original request instead of imposing a total.
      if (counts.has(kind)) return "";
      counts.set(kind, count);
    }
    if (/一句话/u.test(clause) && /(?:用|请|只|回答|回复)/u.test(clause) && !/(?:不|别|不要|至少|至多)/u.test(clause)) {
      if (counts.has("sentence") || clause.match(/一句话/gu)!.length > 1) return "";
      counts.set("sentence", 1);
    }
  }
  const scopes: string[] = [];
  const reportedOrRevised = /[\r\n]/u.test(userText)
    || /\b(?:yesterday|earlier|previously|said|asked|wrote|translate(?:d)?|summari[sz]e)\b|\b(?:was|were)\s+(?:(?:his|her|their|my|the|our)\s+)?(?:question|request|instruction)\b|\b(?:do not|don['’]t)\s+answer\s+(?:that|this|the question)\b/iu.test(unquoted);
  if (!reportedOrRevised) {
    const clauses = unquoted.split(/[.!?;]/u).map(value => value.trim()).filter(Boolean);
    const companyRequest = new RegExp(`^(?:please\\s+)?(?:just|only)\\s+(?:(?:sit|stay|be)\\s+(?:here\\s+)?with\\s+me|keep\\s+me\\s+company)(?:\\s+(?:quietly|in silence|as yourself|for a while))*(?:\\s+and\\s+(?:say|speak|use|answer(?:\\s+in)?|reply(?:\\s+in)?|respond(?:\\s+in)?)\\s+(?:exactly\\s+)?${number}\\s+(?:English\\s+)?sentences?)?$`, "iu");
    if (companyRequest.test(clauses.at(-1) ?? "")
      && clauses.some(value => /^(?:please\s+)?(?:do not|don['’]t)\s+analy[sz]e\b/iu.test(value))) {
      // This bounds the companionship component, never the entire message:
      // the same user may also ask a separate factual question.
      scopes.push("For the requested companionship, describe only your own immediate actions or sensations; speak about being here with the user. Keep that companionship free of judgments about the event, its significance or the user's abilities.");
    }
    if (counts.has("action") && ownActions) {
      scopes.push("Action narration uses the same viewpoint as your speech: I/me/my/mine for yourself and you/your/yours for the user, in every clause.");
    }
    const questions = unquoted.match(/[^.!?;]+\?/gu) ?? [];
    if (questions.some(value => /^\s*(?:why|what)\s+(?:do|did)\s+you\s+(?:like|love|enjoy|prefer|dislike|hate)\b/iu.test(value))) {
      scopes.push("For this preference question, any described experience is your own. When using pronouns for that experience, use I/my; any statement about how the user feels needs their stated experience. Keep the requested answer form.");
    }
  }
  if (!counts.size && !scopes.length) return "";
  const form = [...counts].map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}${kind === "sentence" ? " in the entire reply, including action descriptions" : ""}`).join(" and ");
  return [
    ...(counts.size ? [`Their current request specifies exactly ${form}. Keep all content within that form; end after it.`] : []),
    // A total multi-sentence form leaves separate prose for reactions; make
    // clear that incidental movements there also consume the action count.
    ...(counts.has("action") ? [(counts.get("sentence") ?? 0) > 1
      ? "Use one physical verb per requested action; describe other reactions through thoughts or sensations, without extra bodily movements."
      : "The action count covers the entire reply, including physical reactions. Count distinct actions, not sentences; one continuous gesture is one action."] : []),
    ...(counts.get("spoken sentence") === 1
      ? ["Keep all speech, including interjections, in one sentence."]
      : counts.has("spoken sentence") ? ["A standalone interjection counts as a spoken sentence."] : []),
    ...scopes,
  ].join(" ");
}

function describeScene(scene: SceneState): string {
  const parts = [
    scene.location ? `at ${scene.location}` : "",
    scene.time ?? "",
    scene.participants.length > 0 ? `with ${scene.participants.join(", ")}` : "",
    scene.emotionalBeat ? `mood: ${scene.emotionalBeat}` : "",
    scene.unresolvedThreads.length > 0
      ? `open threads: ${scene.unresolvedThreads.join("; ")}`
      : "",
  ].filter(Boolean);
  return parts.join("; ");
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** A saved instruction joins other sentences; give it a full stop if the user left none. */
function sentence(value: string): string {
  return /[.!?。！？…]$/u.test(value) ? value : `${value}.`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatUtc(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} `
    + `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())} UTC, ${WEEKDAYS[value.getUTCDay()]}`;
}

function describeGap(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 2) return "moments ago";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}
