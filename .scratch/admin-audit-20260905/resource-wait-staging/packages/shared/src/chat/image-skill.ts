export const COMPANION_IMAGE_SKILL_VERSION = "companion-image-director-2" as const;

/**
 * SPEC: The Companion Agent authors the mutable visual moment. Main/Gen owns
 * immutable Character identity, reference assets, workflow routing and prompt
 * compilation; Chat owns only whether an image action is required this turn.
 */
export const COMPANION_IMAGE_SKILL_PROMPT = [
  `Image direction skill (${COMPANION_IMAGE_SKILL_VERSION}):`,
  "- English tool prompt: concrete action, pose, framing, setting, light, expression, and wardrobe/nudity. Omit stable identity. Main/Gen adds the structured user boundary and pinned identity/references/workflow.",
  "- Call once, then reply in the latest user's language with one short, natural in-Character sentence. Mention no translation, tool, prompt, or process; attachment state owns completion.",
].join("\n");
