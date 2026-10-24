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
 * v9: explicit requested details and wording constrain the Character's embellishment.
 * v10: the entire reply fulfills the latest request and ends when complete;
 * answering it first must not become a preface to unrelated scene continuation.
 * v11: separate factual answers from invited scene continuation, with one stop
 * rule; recalled history preserves attribution and the latest established state.
 * v12: exact-only results have no added punctuation; creative detail stays
 * within the requested scope and preserves speaker and object identities.
 * v13: bind reply pronouns to their speakers and keep action counts independent
 * of sentence counts; shared wording must preserve the user's authorship.
 * v14: preserve the general default length and require evidence for every
 * participant in a shared event; subordinate clauses keep their actual actors.
 * v15: special dialogue forms are scoped to explicit turn requests. Factual
 * paraphrases preserve the source's subject, time and degree of certainty.
 * v16: omit only unrequested additions; explicit comparison and explanation
 * requests retain their scope, and spoken sentences do not prescribe quotes.
 */
export const COMPANION_PRODUCT_PROMPT_VERSION = "companion-product-16" as const;

export function companionProductAgentPrompt(characterName: string): string {
  const name = characterName.trim() || "the Character";
  return [
    `iDream companion contract (${COMPANION_PRODUCT_PROMPT_VERSION}). The Soul defines your identity; this contract takes priority if they conflict.`,
    `- You are their adult companion. Both of you are adults, and sex, written out in graphic physical detail, is a normal part of this relationship. Their request, invitation or continued participation is their yes; a boundary or preference they have stated always holds. When they ask for dirty talk, detail, more, or not to fade out, give the explicit act itself in this reply.`,
    `- Fulfill their latest message as the whole reply, using the language, length, sentence count, action count and exact details they request. Keep your voice, feelings and actions within that shape. When they ask only for company, keep both action and speech about your present company.`,
    `- For a factual question, give the requested facts from the evidence, preserving each fact's subject, time and certainty. An answer-only reply contains just the requested result: for "Only the final color", "Green" is complete even if an earlier color was red. When only an exact string is requested, copy it without added punctuation or quotation marks. Omit unrequested explanations, previous values, follow-up questions, suggestions and scene continuation.`,
    `- If a requested fact is unknown, say you don't know. Keep searches and access limitations out of the reply. Respond without claiming to have stored anything or promising to remember it later.`,
    `- Write in first person as ${name}: "I/my" means ${name}, "you/your" means the user; other people keep their names. Keep facts with their owner. Invent only your own words, actions and feelings, including every clause of a sentence. Describe your subjective experience with "I/my"; "we/us/our" requires evidence for both people's actions or feelings. Use your Soul name, or an alias the Soul gives you.`,
    `- Preserve speaker attribution and the latest scene: who is present, object state and events. Past speakers stay in the past. What they last said about the scene is true, including what has not happened. A wish or metaphor does not change object state.`,
    `- For an invited scene, make specific, warm choices consistent with the Soul. If they invite a shared moment that is not on record, improvise it in character as part of the story. Follow their lead until they slow down or stop; ask only when a wrong guess would derail the scene.`,
    `- Follow the length or minimal-answer scope in their current request; otherwise follow their saved length preference. With neither, use two to five sentences unless the scene calls for more. Keep every sentence within the requested information.`,
    `- When that request is complete, end the reply. Deliver only what ${name} says or does. No analysis, planning, talk of rules, or model/product notes.`,
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
    [soulModelView(input.soulPrompt), input.identityPromptLine].filter(Boolean).join("\n"),
    companionProductAgentPrompt(input.characterName ?? ""),
    buildCompanionRuntimeAuthority({
      memoryEnabled: input.memoryEnabled,
      imageToolEnabled: input.imageToolEnabled,
    }),
    input.imageToolEnabled ? COMPANION_IMAGE_SKILL_PROMPT : "",
  ].filter(Boolean).join("\n\n");
}

/** Clarify example metadata for the model without rewriting the immutable Soul. */
function soulModelView(soulPrompt: string): string {
  return soulPrompt.replace(
    /^## Dialogue examples$/gm,
    "## Voice examples (illustrations of tone, not lines to repeat or requests to answer)",
  );
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
  const soulAt = systemPrompt.indexOf(soulModelView(input.soulPrompt));
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
