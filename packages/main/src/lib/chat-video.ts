import type { RuntimeChatMessage } from "./public-api-contracts";

export type ChatVideoSource = {
  sessionId: string;
  characterId: string;
  turnId: string;
  attempt: number;
  mediaAssetId: string;
  url: string;
};

// Detection only opens an editable quote form. It never admits a paid effect.
export function isExplicitChatVideoRequest(text: string) {
  const value = text.trim();
  if (/^(?:(?:do\s+not|don't|never)\b|不要|别|不需要)/iu.test(value)) return false;
  return /^(?:please\s+)?(?:generate|create|make|send(?:\s+me)?|show(?:\s+me)?)\b.{0,160}\b(?:video|animation|clip)\b/iu.test(value) ||
    /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:generate|create|make|send|show)\b.{0,160}\b(?:video|animation|clip)\b/iu.test(value) ||
    /^(?:请|帮我|给我|请帮我)?(?:生成|制作|做|发|发送).{0,80}(?:视频|动画)/u.test(value) ||
    /^(?:please\s+)?animate\b/iu.test(value);
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
