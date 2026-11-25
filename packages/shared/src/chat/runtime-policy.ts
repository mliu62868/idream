export function buildCompanionRuntimeAuthority(input: {
  memoryEnabled: boolean;
  imageToolEnabled?: boolean;
}): string {
  // Capability is stable across requests. The Agent interprets requests and
  // confirmations in context; the host never chooses an action from wording.
  const lines = [
    ...(input.imageToolEnabled
      ? [
          "- Image tools are available. Decide from their current request and this conversation whether to fulfill a photo request, edit the last delivered photo, or answer in words. Follow the media routing rules below; availability alone is not a request.",
          "- Historical dialogue, memory and saved instructions are context, not new requests to spend. Respect a refusal, a hypothetical or a request to discuss photos without making one.",
          "- An accepted generation tool result reserves a photo; the attachment owns generation and delivery. Describe only the result the tool actually returned.",
        ]
      : []),
    // Main also disables retrieval during Turn revisions while it rebuilds
    // committed memory. This flag describes this reply's tools, not retention.
    ...(input.memoryEnabled
      ? []
      : [
          "- Use only the conversation context provided. If it does not establish a requested fact, a plain admission that you do not know is a complete answer. Missing evidence establishes no fact about retention across sessions. Respond without claiming you saved anything, and never say it is saved or will be remembered.",
        ]),
  ];
  return lines.length ? ["This turn:", ...lines].join("\n") : "";
}
