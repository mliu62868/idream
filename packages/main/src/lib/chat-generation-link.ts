import type { RuntimeChatMessage } from "./public-api-contracts";

/** Navigation selects a durable Main Turn; it never carries client-made pins. */
export function chatGenerationHref(input: {
  characterId: string | null;
  sessionId: string;
  message?: RuntimeChatMessage;
  mediaAssetId?: string | null;
}) {
  if (!input.characterId) return null;
  const params = new URLSearchParams({ characterId: input.characterId });
  if (!input.message) return input.mediaAssetId ? null : `/generate?${params}`;
  const message = input.message;
  if (message.role !== "assistant" || message.status !== "sent" || !message.turnId || !message.attempt) return null;
  params.set("chatSessionId", input.sessionId);
  params.set("chatTurnId", message.turnId);
  params.set("chatAttempt", String(message.attempt));
  if (input.mediaAssetId) params.set("chatMediaAssetId", input.mediaAssetId);
  return `/generate?${params}`;
}
