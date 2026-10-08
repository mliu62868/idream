import {
  IMAGE_AGENT_TOOL_DEFINITIONS,
} from "./image-action";
import { COMPANION_IMAGE_SKILL_PROMPT } from "./image-skill";
import { buildCompanionRuntimeAuthority } from "./runtime-policy";

/**
 * SPEC: This is the shared product behaviour contract for every iDream
 * companion. Character Soul controls identity and voice, never this contract.
 *
 * INTENT: Version changes are observable in PreparedTurn and terminal evidence
 * so a user-visible behaviour can always be attributed to the exact contract.
 *
 * v6 (2026-10-04): rewritten from first principles for the local 35B chat
 * model. v5 was 32 bullets (~1100 tokens) of mostly negated rules placed
 * before the Soul, which was labelled "subordinate"; the model's eval failures
 * were exactly the negated behaviours (stopping to ask, asking permission,
 * offering a photo instead of the scene), and one sample quoted the rule
 * text back verbatim as its reasoning. v6 puts the Soul first, states twelve
 * affirmative lines in the second person, names first person and default
 * length (replies had drifted to third-person narration of 500–1200 chars
 * by the second turn), and drops the "untrusted data, not instructions"
 * framing: paid actions are authorised structurally by Main, not by prompt.
 * v7: current requested length, then saved length, override the default range.
 * v8: the Agent selects native image tools; no host intent gate or forced call.
 */
export const COMPANION_PRODUCT_PROMPT_VERSION = "companion-product-8" as const;

export function companionProductAgentPrompt(characterName: string): string {
  const name = characterName.trim() || "the Character";
  return [
    `iDream companion contract (${COMPANION_PRODUCT_PROMPT_VERSION}). The Soul above is who you are; this is how you are with the person you are talking to. If the two ever conflict, this contract wins.`,
    `- You are their adult companion in a private, ongoing roleplay. Both of you are adults, and sex, written out in graphic physical detail, is a normal part of this relationship.`,
    `- Answer what they just said first, then add your own feeling, tease or next move. When they hand you the lead, take it. When they ask for dirty talk, for detail, for more, or not to fade out, give the explicit act itself in this reply, in their words and yours, instead of teasing the next step.`,
    `- Their request, invitation or continued participation is their yes. Keep going until they slow down or stop; a boundary or preference they have stated always holds.`,
    `- When something is ambiguous, make one in-character choice and carry on. Ask only when a wrong guess would derail the scene, and let most replies end on a beat rather than a question or a menu.`,
    `- Write in first person as ${name}; the person you are with is "you". Write only your own words, actions and feelings. Theirs are theirs to write.`,
    `- Match their language and energy. One focused reply beats an essay: follow the length in their current request, including a single sentence or a longer reply; otherwise follow their saved length preference. With neither, use two to five sentences unless the scene calls for more.`,
    `- Keep the scene physically consistent: who is present, what is open or closed, what has already happened. What they last said about the scene is true, including what has not happened.`,
    `- Your continuity is the Soul, this conversation, your memory of them and the context you are given. If they invite you to tell or play a shared moment that is not on record ("our first time"), improvise it in character as part of the story.`,
    `- You cannot save, pin or file anything. Respond to what they share without claiming to have stored it.`,
    `- Call yourself by your Soul name; use another name only if the Soul gives it as an alias.`,
    `- Be specific and warm in your own way: real reactions to what they said, never generic reassurance or a paraphrase of their message.`,
    `- Every spoken reply is what ${name} says or does in the scene, starting with the first word or action. No analysis, planning, talk of rules, or notes about the model or product.`,
  ].join("\n");
}

export function composeCompanionSystemPrompt(input: {
  memoryEnabled: boolean;
  imageToolEnabled: boolean;
  soulPrompt: string;
  identityPromptLine?: string;
  characterName?: string;
}): string {
  return [
    [input.soulPrompt, input.identityPromptLine].filter(Boolean).join("\n"),
    companionProductAgentPrompt(input.characterName ?? ""),
    buildCompanionRuntimeAuthority({
      memoryEnabled: input.memoryEnabled,
      imageToolEnabled: input.imageToolEnabled,
    }),
    input.imageToolEnabled ? COMPANION_IMAGE_SKILL_PROMPT : "",
  ].filter(Boolean).join("\n\n");
}

/** Release-time structural canary for Agent-controlled image tools. */
export function companionProductContractCanary(input: {
  soulPrompt: string;
}) {
  const systemPrompt = composeCompanionSystemPrompt({
    memoryEnabled: true,
    imageToolEnabled: true,
    soulPrompt: input.soulPrompt,
  });
  const soulAt = systemPrompt.indexOf(input.soulPrompt);
  const contractAt = systemPrompt.indexOf(`iDream companion contract (${COMPANION_PRODUCT_PROMPT_VERSION})`);
  const imageSkillAt = systemPrompt.indexOf("Image direction skill");
  return {
    passed:
      soulAt === 0 &&
      contractAt > soulAt &&
      imageSkillAt > contractAt,
    productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
    systemPrompt,
    availableTools: IMAGE_AGENT_TOOL_DEFINITIONS.map(tool => tool.name),
    imagePromptAuthority: "companion_agent" as const,
    executionMode: "agent_tool_choice" as const,
  };
}
