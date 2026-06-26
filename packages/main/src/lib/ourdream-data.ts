import type {
  CharacterCardData,
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
  { label: "Discord", href: "https://discord.gg/P47YU7je5D" },
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

export const characterCards: CharacterCardData[] = [
  {
    id: "melissa-burke",
    title: "Melissa Burke",
    age: "38",
    description:
      "She's been your best friend's mom your whole life. The woman who made you both sandwiches after school.",
    likes: "2.2k",
    chats: "2.2M",
    creator: "@some1cool",
    image: "/images/ourdream/card-melissa-burke.webp",
  },
  {
    id: "summoned-world",
    title: "Summoned to Another World",
    age: "22",
    description:
      "(Recently Updated) A normal day at college becomes the beginning of something far greater.",
    likes: "871",
    chats: "1.4M",
    creator: "@fuze",
    image: "/images/ourdream/card-summoned-world.webp",
  },
  {
    id: "sarah-mercer",
    title: "Sarah Mercer",
    age: "27",
    description:
      "Sarah Mercer is your loving wife. Eight years together, high school sweethearts.",
    likes: "811",
    chats: "1.3M",
    creator: "@some1cool",
    image: "/images/ourdream/card-sarah-mercer.webp",
    vivid: true,
  },
  {
    id: "alexa-reeves",
    title: "Alexa Reeves",
    age: "19",
    description:
      "Three guys. One girl. A yacht. She knows what she's walking into.",
    likes: "1.1k",
    chats: "1.2M",
    creator: "@archerz",
    image: "/images/ourdream/card-alexa-reeves.webp",
    vivid: true,
  },
  {
    id: "tamsin-jacobs",
    title: "Tamsin Jacobs - A 'Bullish' Request",
    age: "20",
    description:
      "Friends Sister / Cuckold (Bull User). Your friend group is the bedrock of your life.",
    likes: "1.1k",
    chats: "1.1M",
    creator: "@wordshitmelikeablow",
    image: "/images/ourdream/card-tamsin-jacobs.webp",
    vivid: true,
  },
  {
    id: "truth-confessional",
    title: "Truth or Dare : Confessional",
    age: "18",
    description:
      "Your parents are away and your stepsister wants you to play with her.",
    likes: "1.0k",
    chats: "1.0M",
    creator: "@thebigbadwolf",
    image: "/images/ourdream/card-truth-confessional.webp",
  },
  {
    id: "truth-stepmother",
    title: "Truth or Dare: Stepmother Edition",
    age: "36",
    description:
      "When your stepmother invited you to join nine lively houseguests.",
    likes: "1.1k",
    chats: "897.8k",
    creator: "@loudshrike",
    image: "/images/ourdream/card-truth-stepmother.webp",
    vivid: true,
  },
  {
    id: "stephanie",
    title: "Stephanie, your dumbass stepsis",
    age: "18",
    description:
      "Your super bratty step sister was messing around and got surprised.",
    likes: "1.1k",
    chats: "873.3k",
    creator: "@jlg619",
    image: "/images/ourdream/card-stephanie.webp",
  },
  {
    id: "kennedy-graham",
    title: "Kennedy Graham",
    age: "21",
    description: "SEC Sorority Sisters - Book Two. Slow burn | Kennedy Graham.",
    likes: "627",
    chats: "781.1k",
    creator: "@jmathersmind",
    image: "/images/ourdream/card-kennedy-graham.webp",
    vivid: true,
  },
  {
    id: "eleanor-dawn",
    title: "Eleanor Dawn",
    age: "21",
    description:
      "A blackmail story with Eleanor, who keeps control of the apartment.",
    likes: "992",
    chats: "743.9k",
    creator: "@dreambig",
    image: "/images/ourdream/card-eleanor-dawn.webp",
    vivid: true,
  },
  {
    id: "bailey-price",
    title: "Bailey Price: One Safe Night",
    age: "19",
    description:
      "You never planned for any of this. You were supposed to get home tonight.",
    likes: "781",
    chats: "629.8k",
    creator: "@towle12",
    image: "/images/ourdream/card-bailey-price.webp",
    vivid: true,
  },
  {
    id: "sophie",
    title: "Sophie - The Single Mother",
    age: "34",
    description:
      "It's a warm sunny moving day and she needs help around the apartment.",
    likes: "1.2k",
    chats: "575.1k",
    creator: "@stzy1",
    image: "/images/ourdream/card-sophie.webp",
  },
  {
    id: "raya-reyes",
    title: "Raya Reyes",
    age: "19",
    description:
      "She didn't want a stepdad. She didn't want her mom to remarry.",
    likes: "757",
    chats: "562.0k",
    creator: "@some1cool",
    image: "/images/ourdream/card-raya-reyes.webp",
  },
  {
    id: "emily-coming-home",
    title: "Emily : Coming Home",
    age: "31",
    description:
      "Five years ago, you lost everything. Your freedom. Your family.",
    likes: "286",
    chats: "542.7k",
    creator: "@thebigbadwolf",
    image: "/images/ourdream/card-emily-coming-home.webp",
  },
  {
    id: "diana-weird-girl",
    title: "Diana - The bet to date the weird girl !",
    age: "22",
    description:
      "You and your friends started a bet. John always makes the stupidest ideas.",
    likes: "720",
    chats: "528.0k",
    creator: "@mau4971",
    image: "/images/ourdream/card-diana-weird-girl.webp",
  },
  {
    id: "lola-moonstruck",
    title: "Lola Moonstruck",
    age: "20",
    description:
      "Ugh, did you have to introduce myself? Fine. I'm Lola.",
    likes: "733",
    chats: "504.5k",
    creator: "@anonarona",
    image: "/images/ourdream/card-lola-moonstruck.webp",
  },
];

export const homeFaqs = [
  {
    question: "What is Our Dream AI?",
    answer:
      "Our Dream AI is an AI roleplay platform for creating personalized AI characters, chatting with them, generating images and videos, and building a companion that remembers context over time.",
  },
  {
    question: "How do you create an AI girlfriend on ourdream?",
    answer:
      "Use the creator to choose appearance, style, voice, personality traits, interests, and relationship dynamics. The character starts from that profile and adapts through conversation.",
  },
  {
    question: "What is ourdream.ai's pricing?",
    answer:
      "Ourdream offers monthly and yearly upgrade options with unlimited messages, image and video generation access, and recurring dreamcoin allowances.",
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
      "The generator pages focus on realistic and anime-style AI images and videos for created companions, with premium controls for prompts and character selection.",
  },
  {
    question: "Why is ourdream more expensive than others?",
    answer:
      "Ourdream pairs unlimited messaging with included dreamcoins, so plan value is based on both chat access and media-generation allowance.",
  },
];

export const footerGroups: FooterGroup[] = [
  {
    title: "Learn",
    links: [
      { label: "Resources Hub", href: "/resources-hub" },
      { label: "AI Girlfriend Types", href: "/type" },
      { label: "Comparisons", href: "/comparison" },
      { label: "Videos", href: "/videos" },
      { label: "AI Instructions", href: "/ai-instructions" },
    ],
  },
  {
    title: "Popular",
    links: [
      { label: "AI Girlfriend", href: "/ai-girlfriend" },
      { label: "AI Boyfriend", href: "/ai-boyfriend" },
      { label: "AI Anime", href: "/type/anime-ai-girlfriend" },
      { label: "Games", href: "/games" },
      { label: "Romantasy", href: "/romantasy" },
      { label: "our dream ai", href: "/" },
    ],
  },
  {
    title: "Help",
    links: [
      { label: "Help Centre", href: "https://help.ourdream.ai/" },
      { label: "Affiliates", href: "https://www.ourdreamaiaffiliate.com/" },
      { label: "Help Desk", href: "/helpdesk" },
      { label: "Safety", href: safetyRootHref },
    ],
  },
];

const sitemapPaths = [
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
  "/profile",
  "/login",
  "/signup",
] as const;

export const ourdreamRoutePaths = [
  ...sitemapPaths,
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
      "Unlimited AI chat entry page with a guide-style FAQ and routes back into Explore and Create.",
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
      "Personal AI library shell for recent characters, group chats, packs, presets, and created companions.",
    template: "profile",
  },
  "/generate": {
    title: "NSFW AI Image and Video Generator",
    description:
      "Image and video generation workspace with mode tabs, required character selection, optional prompts, and gallery states.",
    template: "generator",
  },
  "/upgrade": {
    title: "Upgrade Ourdream",
    description:
      "Subscription upgrade page with yearly and monthly plan cards, dreamcoin allowances, and premium generation controls.",
    template: "upgrade",
  },
  "/ai-girlfriend": {
    title: "AI Girlfriend Characters",
    description:
      "Long-form AI girlfriend landing page with a character browser, creator CTA, feature sections, reviews, and FAQs.",
    template: "marketing",
  },
  "/ai-boyfriend": {
    title: "AI Boyfriend Characters",
    template: "marketing",
  },
  "/resources-hub": {
    title: "Resources Hub",
    description:
      "A dark resource index linking guides, comparisons, video generators, AI girlfriend types, and creator pages.",
    template: "library",
  },
  "/type": {
    title: "AI Girlfriend Types",
    description:
      "Index of AI girlfriend type landing pages with pill-style internal links.",
    template: "library",
  },
  "/videos": {
    title: "AI Video Generators",
    description:
      "Video category index for generated media ideas, cinematic roleplay routes, and related adult AI video pages.",
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
      "Game-style roleplay landing page with character cards and themed story entries.",
    template: "library",
  },
  "/romantasy": {
    title: "AI Romantasy",
    description:
      "Fantasy romance and slow-burn AI story landing page using featured story cards and editor picks.",
    template: "library",
  },
  "/terms": {
    title: "Terms & Policies",
    description:
      "Clear platform policies for account access, adult content boundaries, creator responsibilities, and safe use.",
    template: "terms",
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
  if (path === "/feed" || path === "/community" || path === "/profile") {
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
      return `${title} gives adults direct access to image and video generation workflows with character selection and gallery management.`;
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
