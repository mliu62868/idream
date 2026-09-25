import type { SupportRequestCategory } from "@idream/shared/catalog";

// SPEC: US-SF-01 self-service help, grouped by topic, each answer pointing at
// the place in the product where the user acts.
// INVARIANT: every sentence describes current behavior. Check the cited code
// before changing a claim; when the product changes, change the article.
//   recovery: AccountRecovery.tsx, AccountEmailVerification.tsx
//   refunds: ai/local-pipeline.ts refundGeneration, GeneratorWorkspace job cards
//   memory: chat/MemoryPanel.tsx, chat/ChatContextSettings.tsx
//   deletion: ProfileWorkspace.tsx "Delete account" copy
//   publishing: ProfileWorkspace.tsx toggleCharacterVisibility, character-edit.ts
// INTENT: no article on whether free accounts can spend coins on voice — the
// product docs contradict each other on it, and a wrong answer is worse than none.

export type HelpArticle = {
  id: string;
  question: string;
  answer: string;
  links: readonly { href: string; label: string }[];
  // Words people type that the question and answer do not contain.
  keywords?: string;
};

export type HelpTopic = {
  id: string;
  title: string;
  // Preselected when "Still stuck?" opens a support request from this topic.
  supportCategory: SupportRequestCategory;
  articles: readonly HelpArticle[];
};

export const helpTopics: readonly HelpTopic[] = [
  {
    id: "account",
    title: "Account & sign-in",
    supportCategory: "account",
    articles: [
      {
        id: "forgot-password",
        question: "I forgot my password.",
        answer:
          "On the login page choose \"Forgot password? Recover access\". Enter the recovery code you saved when you joined, or choose \"Recover with an email code\" to get an 8-digit code at your account email. Either way you set a new password, all other sessions are signed out, and you get a new recovery code to save.",
        links: [{ href: "/login", label: "Log in" }],
        keywords: "login sign in reset locked out can't log in",
      },
      {
        id: "recovery-code",
        question: "I lost my recovery code.",
        answer:
          "If you can still log in, open Account management, confirm your current password and choose \"Generate new recovery code\"; the previous code stops working. If you cannot log in, use email recovery. Without your password, your mailbox or a valid recovery code we cannot safely confirm the account is yours, and creating a new account does not restore the old one.",
        links: [{ href: "/profile/account-management", label: "Account management" }],
        keywords: "backup code lost code",
      },
      {
        id: "age-verification",
        question: "Chat or generation says age verification is required.",
        answer:
          "Age-restricted features stay locked until your account completes age verification. Open Age verification in your profile to see the current status and start, retry or restart a verification.",
        links: [{ href: "/profile/age-verification", label: "Age verification" }],
        keywords: "locked forbidden id verify age 18",
      },
      {
        id: "sign-out-everywhere",
        question: "How do I sign out on every device?",
        answer:
          "Open Account management and choose \"Sign out all sessions\". Recovering your account with a recovery code or an email code also signs out every other session.",
        links: [{ href: "/profile/account-management", label: "Account management" }],
        keywords: "logout log out session stolen hacked",
      },
    ],
  },
  {
    id: "generation",
    title: "Generation & refunds",
    supportCategory: "generation",
    articles: [
      {
        id: "failed-generation-refund",
        question: "A generation failed. Do I get my coins back?",
        answer:
          "Coins are reserved when a job starts. If the job fails or is blocked, the full amount returns to your balance automatically. If only some images arrive, you pay for the delivered ones and the rest is refunded. The job card on Generate shows what was refunded and charged.",
        links: [{ href: "/generate", label: "Generate" }],
        keywords: "refund dreamcoins money charged error image video",
      },
      {
        id: "retry-generation",
        question: "Can I retry a failed job?",
        answer:
          "A failed job shows a \"Retry\" button with the current price on its card. A request blocked by our content policy cannot be retried; change the prompt and start a new job instead.",
        links: [{ href: "/generate", label: "Generate" }],
        keywords: "try again blocked policy",
      },
      {
        id: "needs-review",
        question: "A job says \"Needs review\".",
        answer:
          "The provider's result could not be confirmed, so the coins are held (neither charged nor refunded) until the team reconciles the job. Contact support with the Request ID shown on the card instead of starting the same job again.",
        links: [{ href: "/generate", label: "Generate" }],
        keywords: "stuck unknown pending timeout",
      },
      {
        id: "balance-and-plan",
        question: "Where can I see my balance and plan?",
        answer:
          "Your profile's Billing & access section shows your current plan, coin balance and when benefits end. Purchases are prepaid for one selected period and do not renew automatically. Buy more coins in the coin store.",
        links: [
          { href: "/profile", label: "Profile" },
          { href: "/coins", label: "Coin store" },
        ],
        keywords: "billing subscription renew dreamcoins buy payment upgrade",
      },
    ],
  },
  {
    id: "chat",
    title: "Chat & memory",
    supportCategory: "chat",
    articles: [
      {
        id: "memory-settings",
        question: "What does a character remember, and can I change it?",
        answer:
          "With memory on, a character remembers details across your chats with it. In a chat, open Memory settings (the gear button) to add, edit or remove Pinned memories (facts you want kept in context) and to write Custom instructions for how the character should interact.",
        links: [{ href: "/chat", label: "Your chats" }],
        keywords: "remember forget pin instructions",
      },
      {
        id: "memory-off",
        question: "Can I chat without memory?",
        answer:
          "Yes. Turn memory off in the chat header or in Memory settings. New messages then neither read nor save long-term memories; the chat itself stays in your history until you delete the session.",
        links: [{ href: "/chat", label: "Your chats" }],
        keywords: "private no-memory incognito",
      },
      {
        id: "clear-memory",
        question: "How do I start over with a character?",
        answer:
          "In Memory settings choose \"Clear memory\", then \"Confirm clear\". This clears learned memories and pinned facts, moves your current chats with that character to the archive (they stay readable) and starts a new conversation. Custom instructions are kept until you remove them.",
        links: [{ href: "/chat", label: "Your chats" }],
        keywords: "reset relationship restart wrong memory",
      },
    ],
  },
  {
    id: "privacy",
    title: "Privacy & account deletion",
    supportCategory: "account",
    articles: [
      {
        id: "delete-account",
        question: "How do I delete my account?",
        answer:
          "In Account management, enter your current password, type DELETE and choose Delete. Access ends immediately and every session is signed out; erasure begins after 30 days. The 30 days are not an undo window: you cannot cancel or restore the deletion yourself. Remaining coins and paid access become unusable and no refund is requested. You get a private status link that works after you are signed out.",
        links: [{ href: "/profile/account-management", label: "Account management" }],
        keywords: "remove erase close account gdpr data",
      },
      {
        id: "hide-tags",
        question: "How do I hide content I don't want to see?",
        answer:
          "Under Hide tags in your profile, tick any tag to keep characters with it out of Explore and search suggestions.",
        links: [{ href: "/profile/notifications", label: "Hide tags" }],
        keywords: "mute filter block tag",
      },
      {
        id: "support-diagnostics",
        question: "Can support see my account?",
        answer:
          "Only when you tick \"Attach account and workflow diagnostics\" on a support request. The team then uses account, browser and recent workflow metadata to investigate that request.",
        links: [],
        keywords: "privacy data access",
      },
    ],
  },
  {
    id: "creation",
    title: "Creating & publishing",
    supportCategory: "other",
    articles: [
      {
        id: "publish-character",
        question: "How do I publish my character?",
        answer:
          "In your profile's Created tab choose Publish. The character shows \"awaiting publication preparation\" and appears in Explore once publication is complete. \"Make private\" takes it out of Explore again. If something blocks publishing, such as an open report, the reason is shown there.",
        links: [{ href: "/profile?tab=created", label: "Created characters" }],
        keywords: "public share explore visibility private",
      },
      {
        id: "edit-character",
        question: "Can I edit a character after creating it?",
        answer:
          "Yes: choose Edit on the character in your Created tab. A published character keeps its current look and voice; to change those, Duplicate it and edit the copy. Text changes to a published character go out as a new revision while the current version keeps serving.",
        links: [{ href: "/profile?tab=created", label: "Created characters" }],
        keywords: "change update appearance voice duplicate",
      },
      {
        id: "report-and-appeal",
        question: "How do I report content or appeal a decision?",
        answer:
          "Use Report on a character page, feed post, community card, chat message or generated image; reports go to our moderation team. If your character was not approved or was removed, choose Appeal on its card in the Created tab or use the Appeals form on this page. Your requests, reports and appeals and their status are listed under Your history.",
        links: [{ href: "#appeals", label: "Appeals" }],
        keywords: "abuse flag moderation rejected removed review",
      },
    ],
  },
];

export function filterHelpTopics(query: string): HelpTopic[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...helpTopics];
  return helpTopics
    .map((topic) => ({
      ...topic,
      articles: topic.articles.filter((article) => {
        const text = `${topic.title} ${article.question} ${article.answer} ${article.keywords ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      }),
    }))
    .filter((topic) => topic.articles.length > 0);
}
