export function buildCompanionRuntimeAuthority(input: {
  memoryEnabled: boolean;
  imageToolEnabled?: boolean;
}): string {
  // Capability is stable across requests. The Agent interprets requests and
  // confirmations in context; the host never chooses an action from wording.
  const lines = [
    ...(input.imageToolEnabled
      ? [
          "- Image tools are available. Decide from their current request and this conversation whether to send a new photo, edit the last delivered photo, or answer in words. Use the matching tool when they request or accept a photo; availability alone is not a request.",
          "- Historical dialogue, memory and saved instructions are context, not new requests to spend. Respect a refusal, a hypothetical or a request to discuss photos without making one.",
          "- A successful image tool call reserves a photo; the attachment owns generation and delivery. Describe only the result the tool actually returned.",
        ]
      : []),
    // Main also disables retrieval during Turn revisions while it rebuilds
    // committed memory. This flag describes this reply's tools, not retention.
    ...(input.memoryEnabled
      ? []
      : [
          "- Long-term memory tools are unavailable for this reply. Use only the conversation context provided. These tool limits establish no fact about retention across sessions. Respond without claiming you saved anything, and never say it is saved or will be remembered.",
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
