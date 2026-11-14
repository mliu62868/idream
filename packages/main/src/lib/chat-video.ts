import type { RuntimeChatMessage } from "./public-api-contracts";

export type ChatVideoSource = {
  sessionId: string;
  characterId: string;
  turnId: string;
  attempt: number;
  mediaAssetId: string;
  url: string;
};

// Explicit creation opens a quote form. Requests to send or show media belong to Chat.
export function isExplicitChatVideoRequest(text: string) {
  const value = text.trim();
  return /^(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:(?:generate|create|make)\b.{0,160}\b(?:video|animation|clip)\b|animate\b)/iu.test(value) ||
    /^请?(?:(?:帮|给)我)?(?:生成|制作|做).{0,80}(?:视频|动画)/u.test(value);
}

export function chatVideoSources(messages: readonly RuntimeChatMessage[], fallback: { sessionId: string; characterId: string | null }): ChatVideoSource[] {
  return messages.flatMap(message => {
    const attributed = message as RuntimeChatMessage & { sessionId?: string; characterId?: string };
    const characterId = attributed.characterId ?? fallback.characterId;
    if (message.role !== "assistant" || message.status !== "sent" || !message.turnId || !message.attempt || !characterId) return [];
    return (message.attachments ?? []).flatMap(attachment =>
      attachment.kind === "generated_image" && attachment.status === "completed" && attachment.mediaAssetId && attachment.mediaUrl
        ? [{ sessionId: attributed.sessionId ?? fallback.sessionId, characterId, turnId: message.turnId!, attempt: message.attempt!, mediaAssetId: attachment.mediaAssetId, url: attachment.thumbnailUrl ?? attachment.mediaUrl }]
        : []);
  }).reverse();
}
