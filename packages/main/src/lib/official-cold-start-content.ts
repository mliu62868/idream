export const officialFeedbackItems = [
  {
    id: "seed-feedback-generator-recipes",
    sourceKey: "generator-recipes",
    title: "Saved generator recipes",
    description: "Save a prompt, character, style, orientation, and preset stack so it can be reused later.",
    category: "feature",
    status: "planned",
  },
  {
    id: "seed-feedback-creator-collections",
    sourceKey: "creator-collections",
    title: "Creator collection boards",
    description: "Let creators group characters and generated media into public boards followers can browse.",
    category: "feature",
    status: "under_review",
  },
  {
    id: "seed-feedback-chat-memory-review",
    sourceKey: "chat-memory-review",
    title: "Memory review before long chats",
    description: "Give users a quick way to inspect and adjust remembered facts before continuing a session.",
    category: "improvement",
    status: "under_review",
  },
] as const;
