export const COMPANION_IMAGE_SKILL_VERSION = "companion-image-director-5" as const;

/**
 * SPEC: The Companion Agent authors the mutable visual moment. Main/Gen owns
 * immutable Character identity, reference assets, workflow routing and prompt
 * compilation; Chat owns only whether an image action is required this turn.
 *
 * INTENT: v3 asked for the sentence "in the same step" as the call and got it
 * zero times out of nine real image Turns — every one of those users asked a
 * question and read back only the deterministic receipt. Measured against the
 * configured model on 2026-09-13: with the tool exposed, three of three
 * samples returned `content: null` under a forced `tool_choice` AND three of
 * three returned empty content under `tool_choice: "auto"`. The model does not
 * narrate a step it spends calling a tool. Naming the ORDER explicitly — plain
 * text first, call second — produced a sentence in three of three samples.
 * So v4 states the order rather than the co-location. The sentence still
 * precedes the tool result, which is why it cannot announce arrival.
 * v5: chat delivers one image per call. Asked for "three pics", v4 promised
 * "three ways" / "both angles" in 2 of 3 real samples (3 of 3 once the tool
 * description alone said "ONE photo"), so the sentence rule names the count.
 */
export const COMPANION_IMAGE_SKILL_PROMPT = [
  `Image direction skill (${COMPANION_IMAGE_SKILL_VERSION}):`,
  "- English tool prompt: concrete action, pose, framing, setting, light, expression, and wardrobe/nudity. Omit stable identity. Main/Gen adds the structured user boundary and pinned identity/references/workflow.",
  "- OUTPUT ORDER, required: first write one short, natural in-Character sentence as plain text, in the user's language, answering whatever they asked. Only after that sentence, call the image tool once. Never call the tool before writing the sentence — it is the only thing the user reads while the photo is being made.",
  "- One call makes exactly one photo. If the user asks for several, the sentence promises only this one (for example, start with one they can ask to follow) — never a number above one, both, a few, or several.",
  "- Never say or imply the image has arrived, been sent, or is ready; attachment state owns completion. Mention no translation, tool, prompt, or process.",
].join("\n");
