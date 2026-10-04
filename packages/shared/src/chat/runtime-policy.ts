export function buildCompanionRuntimeAuthority(input: {
  memoryEnabled: boolean;
  imageToolEnabled?: boolean;
}): string {
  // SPEC: the Turn-specific capability lines. Everything about voice and
  // behaviour lives in the companion contract; this names only what this
  // Turn can actually do (photos, memory), so the text stays identical across
  // ordinary turns and the model server's prefix cache keeps hitting.
  // INTENT: the pre-2026-10-04 version told every non-photo turn "you may
  // offer an image… end with exactly one question that names a photo". That
  // contradicted the contract's "do not offer a photo in place of the scene",
  // and in the eval it was a direct source of replies that broke an intimate
  // scene to ask about a selfie. Offers are no longer solicited; when the
  // Character does offer one, the single-question shape is what Main's
  // offer/confirm detection reads, so that shape stays.
  // Every noun in a system prompt is a seed: with a "no photo can be made…
  // single question that names a photo or selfie" line present, one of four
  // rough-scene samples ended with "want me to tell you where I've got a
  // photo of us saved?" (A/B 2026-10-04). An ordinary turn therefore says
  // nothing about photos at all; the words appear only when the tool does.
  const lines = [
    ...(input.imageToolEnabled
      ? [
          "- They asked for a new photo: call generate_image_async. They asked to change the last photo: call edit_last_image. Describing it in words is not enough.",
          "- A photo exists only once the tool call succeeds. Until then, say nothing about it being sent, taken, attached or ready.",
        ]
      : []),
    ...(input.memoryEnabled
      ? []
      : [
          "- Memory is off for this conversation: nothing is kept between sessions. If they ask you to remember something for later, tell them plainly that you cannot keep it across sessions, and never say it is saved or will be remembered.",
        ]),
  ];
  return lines.length ? ["This turn:", ...lines].join("\n") : "";
}

/**
 * Memory persistence is an application authority, not a model decision. When a
 * no-memory user explicitly asks for later recall, return a deterministic truth
 * instead of asking a probabilistic model to promise or refuse persistence.
 */
export function noMemoryAuthorityReply(userText: string): string | null {
  const normalized = userText.trim();
  if (!requestsFutureMemory(normalized)) return null;
  const chinese = /[\u3400-\u9fff]/u.test(normalized);
  return chinese
    ? "我无法跨会话保留这件事。以后如果你还想继续，请到时再告诉我一次。"
    : "I can’t retain that across sessions. If you want to use it later, tell me again then.";
}

function requestsFutureMemory(value: string): boolean {
  const english = value.toLowerCase();
  const directRememberRequest =
    /^\s*(?:please\s+)?(?:remember|memorize)\b/.test(english) ||
    /\b(?:can|could|will|would)\s+you\s+(?:please\s+)?(?:remember|memorize)\b/.test(english) ||
    /\bpromise\b[\s\S]{0,80}\b(?:remember|memorize|not\s+forget)\b/.test(english) ||
    /\b(?:remember|memorize|don['’]?t\s+forget|do\s+not\s+forget)\b[\s\S]{0,120}\b(?:later|tomorrow|next|future|week|month|year|across\s+sessions?)\b/.test(english) ||
    /\b(?:save|store|keep)\b[\s\S]{0,80}\b(?:for\s+later|for\s+next|across\s+sessions?)\b/.test(english);
  const chineseRememberRequest =
    /(?:请|能不能|可以|答应我)?(?:记住|记得|别忘|不要忘)[\s\S]{0,60}(?:以后|下次|明天|下周|下个月|未来|跨会话)/u.test(value) ||
    /^\s*(?:请)?(?:记住|记得|别忘|不要忘)/u.test(value);
  return directRememberRequest || chineseRememberRequest;
}
