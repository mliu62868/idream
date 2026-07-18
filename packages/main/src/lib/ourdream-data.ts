import type {
  FooterGroup,
  NavItem,
  OurdreamRoute,
  OurdreamRouteTemplate,
} from "@/types/ourdream";
import {
  getSafetyDocumentForRoute,
  safetyRootHref,
  safetyRoutePaths,
} from "@/lib/ourdream-safety-data";

export const primaryNavItems: NavItem[] = [
  { label: "Create", href: "/create" },
  { label: "Explore", href: "/", active: true },
  { label: "Chat", href: "/chat" },
  { label: "Generate", href: "/generate" },
  { label: "My AI", href: "/custom" },
  { label: "Feed", href: "/feed" },
  { label: "Community", href: "/community" },
];

export const secondaryNavItems: NavItem[] = [
  { label: "Help Desk", href: "/helpdesk" },
  { label: "Safety Center", href: safetyRootHref },
  { label: "More", href: "/resources-hub" },
];

export const categoryFilters = [
  "All",
  "Group Chats",
  "MILF",
  "Teen",
  "Asian",
  "Latina",
  "Blonde",
  "Busty",
  "Submissive",
  "Dominant",
  "BDSM",
  "Romantic",
  "Slow Burn",
  "Athletic",
  "Caring",
  "Virgin",
  "College Student",
  "Vampire",
  "Cosplay",
  "Redhead",
  "Elf",
  "Thick",
  "Demon",
];

export const homeFaqs = [
  {
    question: "What is Our Dream AI?",
    answer:
      "Our Dream AI is an AI roleplay platform for creating personalized AI characters, chatting with them, generating images, and building a companion that remembers context over time.",
  },
  {
    question: "How do you create an AI girlfriend on ourdream?",
    answer:
      "Use the creator to choose a name, appearance, visual style, personality details, tags, and visibility. Preview the character image before creating the final private or public character.",
  },
  {
    question: "What is ourdream.ai's pricing?",
    answer:
      "The Upgrade page loads the currently active plans, billing periods, prices, included dreamcoins, and configured entitlements from the live plan catalog.",
  },
  {
    question: "Is ourdream ai legit and safe to use?",
    answer:
      "Ourdream emphasizes privacy, safety moderation, original AI characters, and rules against underage-looking content or real-person deepfakes.",
  },
  {
    question: "Are my AI roleplay chats private on Our Dream AI?",
    answer:
      "Private chat history is designed to stay tied to your account, with product controls and moderation paths focused on keeping roleplay conversations secure.",
  },
  {
    question: "What images can I generate on ourdream.ai?",
    answer:
      "The generator pages focus on realistic and anime-style AI images for created companions, with premium controls for prompts and character selection.",
  },
  {
    question: "What do Ourdream upgrades include?",
    answer:
      "Upgrade benefits vary by plan. The live plan cards show the exact message, voice, image, video, model, control, and dreamcoin entitlements currently configured.",
  },
];

export const footerGroups: FooterGroup[] = [
  {
    title: "Learn",
    links: [
      { label: "Resources Hub", href: "/resources-hub" },
      { label: "Comparisons", href: "/comparison" },
      { label: "Character Cards", href: "/guides/character-cards" },
      { label: "Character Card Creator", href: "/guides/character-card-creator" },
      { label: "SillyTavern Setup", href: "/guides/sillytavern-setup-guide" },
    ],
  },
  {
    title: "Popular",
    links: [
      { label: "Explore Characters", href: "/" },
      { label: "Create a Character", href: "/create" },
      { label: "Generate Images", href: "/generate" },
      { label: "Community", href: "/community" },
      { label: "Upgrade", href: "/upgrade" },
    ],
  },
  {
    title: "Help",
    links: [
      { label: "Help Desk", href: "/helpdesk" },
      { label: "Safety", href: safetyRootHref },
      { label: "Terms & Policies", href: "/terms" },
    ],
  },
];

const renderableCatalogPaths = [
  "/",
  "/chat",
  "/create",
  "/ai-girl",
  "/ai-girlfriend",
  "/ai-boyfriend",
  "/generate",
  "/affiliate",
  "/custom",
  "/upgrade",
  "/ai-instructions",
  "/authors/lizzie-od",
  "/nude-ai",
  "/generate/ai-porn",
  "/generate/ai-hentai",
  "/generate/ai-blowjob-generator",
  "/generate/gay-ai-porn-generator",
  "/generate/ai-anime-porn-generator",
  "/generate/ai-cum-generator",
  "/generate/nsfw-ai-generator-furry",
  "/generator/ai-boobs-generator",
  "/generator/ai-joi-generator",
  "/generator/ai-kiss-generator",
  "/generator/ai-roleplay-generator",
  "/generator/ai-waifu-generator",
  "/ai-girlfriend/best-ai-girlfriend-app",
  "/ai-girlfriend/best-free-ai-girlfriend-apps",
  "/ai-girlfriend/what-is-an-ai-girlfriend",
  "/ai-girlfriend/how-do-ai-girlfriends-work",
  "/ai-girlfriend/are-ai-girlfriends-safe",
  "/ai-girlfriend/is-having-an-ai-girlfriend-cheating",
  "/guides/how-to-bypass-character-ai-filter",
  "/guides/how-to-use-character-ai",
  "/guides/is-character-ai-real-people-or-ai",
  "/guides/is-character-ai-safe",
  "/guides/what-ai-model-does-character-ai-use",
  "/guides/why-is-character-ai-not-working",
  "/guides/is-character-ai-shutting-down",
  "/guides/are-character-ai-chats-private-privacy-guide",
  "/guides/does-character-ai-still-have-a-filter",
  "/guides/can-you-make-gemini-nsfw",
  "/guides/does-deepseek-allow-nsfw",
  "/guides/does-chatgpt-allow-nsfw",
  "/guides/does-character-ai-allow-nsfw",
  "/guides/character-cards",
  "/guides/character-hub-ai",
  "/guides/janitor-ai-images-first-message",
  "/guides/character-card-creator",
  "/guides/sillytavern-setup-guide",
  "/sex-chat/nsfw-ai-chat-no-message-limit",
  "/guides/how-to-write-character-ai-bot",
  "/guides/how-to-write-thoughts-character-ai",
  "/sex-chat/best-nsfw-ai-chat",
  "/sex-chat/free-nsfw-ai-chat",
  "/sex-chat/ai-sex-chat-roleplay",
  "/sex-chat/ai-sex-chat-with-pictures",
  "/sex-chat/uncensored-ai-sex-chat",
  "/sex-chat/ai-sex-chat-app",
  "/sex-chat/best-dirty-talk-ai",
  "/sex-chat/ai-sex-video-chat",
  "/sex-chat/ai-sex-chat",
  "/sex-chat/gay-ai-sex-chat",
  "/sex-chat/ai-sex-chat-no-sign-up",
  "/comparison/kling-ai-nsfw",
  "/comparison/flux-nsfw",
  "/comparison/sora-ai-nsfw",
  "/comparison/nano-banana-nsfw",
  "/comparison/grok-imagine-alternative",
  "/comparison/sora-alternatives",
  "/free-ai-girlfriend",
  "/lovescape-ai-alternatives",
  "/secrets-ai-alternatives",
  "/kupid-ai-alternatives",
  "/best-replika-alternatives",
  "/juicychat-ai-alternatives",
  "/nectar-ai-alternatives",
  "/candy-ai-alternatives",
  "/spicy-chat-ai-alternatives",
  "/golove-ai-alternatives",
  "/comparison/muah-ai-alternative",
  "/comparison/nomi-alternative",
  "/comparison/girlfriendgpt-alternative",
  "/comparison/chai-alternative",
  "/comparison/janitor-ai-alternative",
  "/comparison/crushon-ai-alternatives",
  "/comparison/character-ai-alternative",
  "/comparison/spicychat-vs-ourdream-ai",
  "/comparison/girlfriendgpt-vs-ourdream-ai",
  "/comparison/juicychat-vs-ourdream-ai",
  "/comparison/candy-ai-vs-ourdream-ai",
  "/comparison",
  "/resources-hub",
  "/site/rprp-ai",
  "/games",
  "/romantasy",
  "/videos",
  "/videos/realistic-ai-porn",
  "/videos/big-tits-ai-porn",
  "/videos/ai-porn-videos",
  "/videos/ai-cowgirl",
  "/videos/ai-porn-big-ass",
  "/videos/ai-generated-blowjob",
  "/videos/ai-porn-doggystyle",
  "/videos/ai-bbw-porn",
  "/videos/ai-anime-porn",
  "/videos/ai-deepthroat-porn",
  "/videos/ai-cumshot-video",
  "/videos/ai-anal-porn",
  "/videos/ai-generated-hentai",
  "/videos/asian-ai-porn",
  "/videos/ai-missionary-sex",
  "/videos/goth-porn",
  "/videos/ai-milf-porn",
  "/videos/ai-blonde",
  "/videos/black-ai-porn",
  "/videos/ai-japanese-porn",
  "/videos/ai-latina-porn",
  "/videos/ai-futa-porn",
  "/videos/gay-ai-porn",
  "/type/angel-ai-girlfriend",
  "/type/anime-ai-girlfriend",
  "/type/black-ai-girlfriend",
  "/type/erotic-ai-girlfriend",
  "/type/femdom-ai-girlfriend",
  "/type/furry-ai-girlfriend",
  "/type/futa-ai-girlfriend",
  "/type/goth-ai-girlfriend",
  "/type/horny-ai-girlfriend",
  "/type/hot-ai-girlfriend",
  "/type/indian-ai-girlfriend",
  "/type/korean-ai-girlfriend",
  "/type/lesbian-ai-girlfriend",
  "/type/nude-ai-girlfriend",
  "/type/real-ai-girlfriend",
  "/type/roleplay-ai-girlfriend",
  "/type/sexy-ai-girlfriend",
  "/type/shemale-ai-girlfriend",
  "/type/sus-ai-girlfriend",
  "/type/trans-ai-girlfriend",
  "/type/twins-ai-girlfriend",
  "/type/vr-ai-girlfriend",
  "/type/xxx-ai-girlfriend",
] as const;

const linkedNonSitemapPaths = [
  "/terms",
  "/helpdesk",
  "/feed",
  "/community",
  "/type",
  "/profile",
  "/profile/redeem-code",
  "/profile/notifications",
  "/profile/account-management",
  "/login",
  "/signup",
] as const;

export const ourdreamRoutePaths = [
  ...renderableCatalogPaths,
  ...linkedNonSitemapPaths,
  ...safetyRoutePaths,
].filter((path) => path !== "/");

const ourdreamRoutePathSet = new Set<string>(ourdreamRoutePaths);

const routeOverrides: Record<
  string,
  Partial<Pick<OurdreamRoute, "description" | "eyebrow" | "template" | "title">>
> = {
  "/chat": {
    title: "NSFW AI Chat",
    description:
      "Your chat hub — pick up recent AI conversations or start a new one from Explore.",
    template: "marketing",
  },
  "/create": {
    title: "Create Your Dream AI Girl",
    description:
      "Character creator with style controls, preview cards, and guided fields for building a private or public AI companion.",
    template: "create",
  },
  "/custom": {
    title: "Manage Your Dream AI Characters",
    description:
      "Personal AI library shell for recent characters, media, presets, created companions, and clearly labeled deferred group-chat and pack tabs.",
    template: "profile",
  },
  "/profile": {
    title: "Profile",
    description:
      "Account settings, billing state, referral invites, redeem codes, preferences, and personal media management.",
    template: "profile",
  },
  "/profile/redeem-code": {
    title: "Redeem Dreamcoin Code",
    description:
      "Redeem a promo or support code into dreamcoins from the account workspace.",
    template: "profile",
  },
  "/profile/notifications": {
    title: "Profile Notifications",
    description:
      "Manage product update preferences from the account workspace.",
    template: "profile",
  },
  "/profile/account-management": {
    title: "Account Management",
    description:
      "Manage account-level session and deletion actions from the account workspace.",
    template: "profile",
  },
  "/generate": {
    title: "NSFW AI Image Generator",
    description:
      "Image generation workspace with required character selection, optional prompts, premium controls, and gallery states.",
    template: "generator",
  },
  "/upgrade": {
    title: "Upgrade Ourdream",
    description:
      "Prepaid upgrade page with plan cards, access periods, dreamcoin allowances, and premium generation controls from the live catalog.",
    template: "upgrade",
  },
  "/ai-girlfriend": {
    title: "AI Girlfriend Characters",
    description:
      "AI girlfriend landing page with a character browser, creator CTA, feature sections, and related discovery paths.",
    template: "marketing",
  },
  "/ai-boyfriend": {
    title: "AI Boyfriend Characters",
    template: "marketing",
  },
  "/resources-hub": {
    title: "Resources Hub",
    description:
      "Published guides for character cards, character creation, SillyTavern setup, platform comparisons, and the live creation tools.",
    template: "library",
  },
  "/guides/sillytavern-setup-guide": {
    title: "SillyTavern Setup Guide",
    description:
      "A practical guide for translating SillyTavern-style character cards into focused Ourdream character, chat, and image-generation fields.",
    template: "article",
  },
  "/type": {
    title: "AI Girlfriend Types",
    description:
      "Index of AI girlfriend type landing pages with pill-style internal links.",
    template: "library",
  },
  "/videos": {
    title: "AI Video Guides",
    description:
      "Video category index for generated media ideas, cinematic roleplay routes, and related adult AI video guide pages.",
    template: "library",
  },
  "/comparison": {
    title: "Compare AI Girlfriend Platforms",
    description:
      "Comparison hub for AI companion alternatives and Ourdream competitor pages.",
    template: "comparison",
  },
  "/games": {
    title: "AI Games",
    description:
      "A reserved library for future game-style roleplay guides; no game guide is published here yet.",
    template: "library",
  },
  "/romantasy": {
    title: "AI Romantasy",
    description:
      "A reserved library for future fantasy-romance guides; no romantasy guide is published here yet.",
    template: "library",
  },
  "/terms": {
    title: "Terms & Policies",
    description:
      "Clear platform policies for account access, adult content boundaries, creator responsibilities, and safe use.",
    template: "terms",
  },
  "/helpdesk": {
    title: "Help Desk",
    description:
      "Support requests, account and billing help, product FAQs, roadmap voting, appeals, and beta feedback paths.",
    template: "marketing",
  },
};

function toTitle(path: string) {
  const last = path.split("/").filter(Boolean).at(-1) ?? "ourdream ai";
  return last
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ")
    .replace(/\bAi\b/g, "AI")
    .replace(/\bNsfw\b/g, "NSFW");
}

function inferTemplate(path: string): OurdreamRouteTemplate {
  if (path.startsWith("/generate/") || path.startsWith("/generator/")) {
    return "generator";
  }
  if (path.startsWith("/comparison/") || path.includes("alternatives")) {
    return "comparison";
  }
  if (
    path.startsWith("/guides/") ||
    path.startsWith("/sex-chat/") ||
    path.startsWith("/ai-girlfriend/") ||
    path.startsWith("/videos/")
  ) {
    return "article";
  }
  if (path.startsWith("/type/") || path === "/ai-instructions") {
    return "article";
  }
  if (path === "/affiliate" || path.startsWith("/authors/") || path.startsWith("/site/")) {
    return "marketing";
  }
  if (
    path === "/feed" ||
    path === "/community" ||
    path === "/profile" ||
    path.startsWith("/profile/")
  ) {
    return "profile";
  }
  if (path === "/login" || path === "/signup" || path === "/helpdesk") {
    return "marketing";
  }
  return "library";
}

function defaultDescriptionForRoute({
  path,
  template,
  title,
}: Pick<OurdreamRoute, "path" | "template" | "title">) {
  if (path.startsWith("/generate/") || path.startsWith("/generator/")) {
    return `${title} helps adults create AI image concepts with character-aware controls, premium prompt options, and private gallery storage.`;
  }

  if (path.startsWith("/videos/")) {
    return `${title} collects AI video ideas, safety notes, and related generator paths for adults exploring cinematic roleplay media.`;
  }

  if (path.startsWith("/type/")) {
    return `${title} highlights a focused companion style with character suggestions, creation prompts, and related roleplay routes.`;
  }

  if (path.startsWith("/guides/")) {
    return `${title} explains the workflow, safety boundaries, and practical choices for better AI companion roleplay.`;
  }

  if (path.startsWith("/sex-chat/")) {
    return `${title} covers adult AI chat use cases, privacy expectations, and routes into character discovery.`;
  }

  if (path.startsWith("/comparison/") || path.includes("alternatives")) {
    return `${title} compares AI companion options across messaging, creation controls, media generation, pricing, and safety.`;
  }

  switch (template) {
    case "article":
      return `${title} is a practical guide for adults using Ourdream character chat, creation tools, and media generation.`;
    case "comparison":
      return `${title} compares companion platforms by roleplay depth, creator tools, media features, pricing, and trust signals.`;
    case "generator":
      return `${title} gives adults direct access to image generation workflows with character selection and gallery management.`;
    case "library":
      return `${title} gathers related Ourdream guides, generators, companion types, and discovery pages in one place.`;
    case "marketing":
      return `${title} introduces Ourdream's adult AI companion experience, from character discovery to creation and private chat.`;
    case "profile":
      return `${title} keeps your companions, media, presets, community activity, and account actions organized.`;
    case "safety":
      return `${title} explains platform rules, content boundaries, reporting, and moderation expectations.`;
    case "terms":
      return `${title} describes the rules and policies that govern account access, adult use, and platform safety.`;
    case "upgrade":
      return `${title} unlocks higher usage limits, dreamcoins, and premium generation controls.`;
    case "create":
      return `${title} guides you through appearance, personality, voice, visibility, and profile details for a new companion.`;
  }
}

export function getOurdreamRoute(path: string): OurdreamRoute | undefined {
  const normalized = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;

  if (!ourdreamRoutePathSet.has(normalized) && normalized !== "/") {
    return undefined;
  }

  if (normalized === "/safety" || normalized.startsWith("/safety/")) {
    const safetyDocument = getSafetyDocumentForRoute(normalized);

    return {
      path: normalized,
      title: safetyDocument.title,
      description: safetyDocument.description,
      template: "safety",
      eyebrow: "Overview",
    };
  }

  const override = routeOverrides[normalized];
  const title = override?.title ?? toTitle(normalized);
  const template = override?.template ?? inferTemplate(normalized);

  return {
    path: normalized,
    title,
    description:
      override?.description ??
      defaultDescriptionForRoute({ path: normalized, template, title }),
    template,
    eyebrow: override?.eyebrow ?? "ourdream.ai",
  };
}

export function getRoutesByPrefix(prefix: string) {
  return ourdreamRoutePaths
    .filter((path) => path.startsWith(prefix))
    .map((path) => getOurdreamRoute(path))
    .filter((route): route is OurdreamRoute => Boolean(route));
}
