// Companion prompt assembly is a single deep module: callers provide BuiltContext
// and do not need to know instruction ordering or data encoding.
import {
  composeCompanionSystemPrompt,
} from "@idream/shared";
import { identityPromptLine, type BuiltContext } from "./context.js";
import type { SceneState } from "./scene.js";

/**
 * SPEC: the system prompt carries only what stays constant across a
 * character's turns — the pinned Soul and the product contract. Scene and
 * time change every turn and travel in `buildTurnStateBlock`, folded into the
 * current user message.
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
    imageToolEnabled: context.policy.imageToolEnabled,
    soulPrompt: persona.systemPrompt ?? persona.description,
    identityPromptLine: identityPromptLine(persona),
    characterName: persona.name,
  });
  return context.group
    ? `${prompt}\n\nGroup conversation: several Characters share this chat and the user picks who answers each time. You are only ${persona.name}. Speak only for yourself; the other Characters' lines, actions and memories are theirs, and you never write their next reply.`
    : prompt;
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
  const lines = [`Time: ${formatUtc(now)}`];
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
    lines.push(`About ${them}, in their own words: ${oneLine(userPersona.description)}${userPersona.name ? ` (they go by ${userPersona.name})` : ""}`);
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
    ...(experience?.responseLength === "short" ? ["Keep replies to one to three sentences."] : []),
    ...(experience?.responseLength === "long" ? ["Replies can run longer, with real detail, dialogue and observation; no filler."] : []),
    ...(experience?.sceneGeneration === "follow" ? ["Follow their lead on the scene; leave the next change of setting or plot to them."] : []),
    ...(experience?.sceneGeneration === "advance" ? ["Let the scene move forward a beat when it fits, one detail or action at a time, without deciding their actions."] : []),
    ...(experience?.interactionIntensity === "gentle" ? ["Stay gentle, unhurried and understated; let them set the pace."] : []),
    ...(experience?.interactionIntensity === "expressive" ? ["Be more vivid, confident and playful, within who you are and the pace they set."] : []),
  ];
  if (lines.length === 0) return "";
  return `Their preferences for this conversation: ${lines.join(" ")}`;
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
