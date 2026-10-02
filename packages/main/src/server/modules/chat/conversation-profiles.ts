import { conversationProfileCatalogSchema, conversationProfileSnapshotSchema, DEFAULT_CHAT_EXPERIENCE } from "@idream/shared/contracts";

// Catalog versions are product choices, not a second model route. Chat still
// selects its one qualified provider/model; tool and memory authority stay intact.
export const CONVERSATION_PROFILE_CATALOG = conversationProfileCatalogSchema.parse({
  version: 1,
  items: [
    { id: "natural", label: "Natural", description: "Conversation that follows your pace.", replyStyle: "natural", answerMaxOutputTokens: 1024,
      preferences: { responseLength: "auto", interactionIntensity: "balanced", sceneGeneration: "follow" } },
    { id: "quick", label: "Quick", description: "A concise answer, with one to three sentences.", replyStyle: "concise", answerMaxOutputTokens: 256,
      preferences: { responseLength: "short", interactionIntensity: "balanced", sceneGeneration: "follow" } },
    { id: "gentle", label: "Gentle", description: "Calm, patient replies that leave room for you.", replyStyle: "gentle", answerMaxOutputTokens: 768,
      preferences: { responseLength: "auto", interactionIntensity: "gentle", sceneGeneration: "follow" } },
    { id: "expressive", label: "Expressive", description: "Vivid dialogue and emotion within the character's personality.", replyStyle: "expressive", answerMaxOutputTokens: 1536,
      preferences: { responseLength: "long", interactionIntensity: "expressive", sceneGeneration: "follow" } },
    { id: "story", label: "Story", description: "Rich scene detail and small developments while you choose your actions.", replyStyle: "story", answerMaxOutputTokens: 2048,
      preferences: { responseLength: "long", interactionIntensity: "balanced", sceneGeneration: "advance" } },
  ].map(item => ({ ...item, version: 1, messageUnits: 1, costDreamcoins: 0 })),
});

export function conversationProfileSnapshot(id: string, version: number) {
  const entry = CONVERSATION_PROFILE_CATALOG.items.find(item => item.id === id && item.version === version);
  if (!entry) return null;
  return conversationProfileSnapshotSchema.parse({
    id: entry.id, version: entry.version, replyStyle: entry.replyStyle,
    answerMaxOutputTokens: entry.answerMaxOutputTokens,
    messageUnits: entry.messageUnits, costDreamcoins: entry.costDreamcoins,
  });
}

export const DEFAULT_PROFILE_EXPERIENCE = {
  ...DEFAULT_CHAT_EXPERIENCE,
  conversationProfile: conversationProfileSnapshot("natural", 1)!,
};
