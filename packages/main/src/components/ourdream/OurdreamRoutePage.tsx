import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  PlayCircle,
  Sparkles,
} from "lucide-react";
import {
  getOurdreamRoute,
  getRoutesByPrefix,
} from "@/lib/ourdream-data";
import {
  hasDedicatedStaticArticleContent,
  type DedicatedStaticArticlePath,
} from "@/lib/static-article-authority";
import { isPublicRouteDiscoverable } from "@/lib/public-route-authority";
import { toSafetyHref } from "@/lib/ourdream-safety-data";
import type { OurdreamRoute } from "@/types/ourdream";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SafetyCenterPage } from "./SafetyCenterPage";
import { SiteFooter } from "./SiteFooter";
import { AuthNav } from "./AuthNav";
import { AuthWorkspace } from "./AuthWorkspace";
import { AppSearch } from "./AppSearch";
import { ChatHubWorkspace } from "./ChatHubWorkspace";
import { ComparisonPlanSnapshot } from "./ComparisonPlanSnapshot";
import { CommunityWorkspace } from "./CommunityWorkspace";
import { CreateWorkspace } from "./CreateWorkspace";
import { FeedWorkspace } from "./FeedWorkspace";
import { GeneratorWorkspace } from "./GeneratorWorkspace";
import { HelpDeskWorkspace } from "./HelpDeskWorkspace";
import { ProfileWorkspace } from "./ProfileWorkspace";
import { PublicCharacterStrip } from "./PublicCharacterStrip";
import { UpgradeWorkspace } from "./UpgradeWorkspace";
import { MobileAppMenu } from "./MobileAppMenu";

function activeHrefForPath(path: string) {
  if (path === "/login" || path === "/signup") return "";
  if (path.startsWith("/create")) return "/create";
  if (path.startsWith("/chat")) return "/chat";
  if (path.startsWith("/generate") || path.startsWith("/generator")) {
    return "/generate";
  }
  if (path.startsWith("/custom")) return "/custom";
  if (path.startsWith("/profile")) return "/profile";
  if (path.startsWith("/feed")) return "/feed";
  if (path.startsWith("/community")) return "/community";
  if (path.startsWith("/helpdesk")) return "/helpdesk";
  if (path.startsWith("/safety")) return "/safety/introduction";
  if (
    path.startsWith("/resources-hub") ||
    path.startsWith("/type") ||
    path.startsWith("/comparison") ||
    path.includes("alternatives") ||
    path.startsWith("/videos") ||
    path.startsWith("/ai-instructions") ||
    path.startsWith("/ai-girl") ||
    path.startsWith("/ai-girlfriend") ||
    path.startsWith("/ai-boyfriend") ||
    path.startsWith("/affiliate") ||
    path.startsWith("/authors") ||
    path.startsWith("/site") ||
    path.startsWith("/guides") ||
    path.startsWith("/sex-chat") ||
    path.startsWith("/nude-ai") ||
    path.startsWith("/free-ai-girlfriend") ||
    path.startsWith("/games") ||
    path.startsWith("/romantasy")
  ) {
    return "/resources-hub";
  }
  if (path.startsWith("/upgrade")) return "/upgrade";
  return "/";
}

function AppTopbar({
  activeHref,
  currentPath,
}: Readonly<{ activeHref: string; currentPath: string }>) {
  return (
    <header className="sticky top-0 z-40 h-14 w-full bg-[rgba(13,13,13,0.62)] backdrop-blur-xl">
      <div className="flex h-14 items-center justify-between gap-3 px-4 md:px-[60px]">
        <MobileAppMenu activeHref={activeHref} currentPath={currentPath} />
        <Link className="hidden md:block" href="/">
          <Image
            alt="ourdream.ai"
            className="h-3.5 w-auto"
            height={15}
            src="/images/ourdream/ourdream-logo.svg"
            width={130}
          />
        </Link>
        <AppSearch />
        <div className="flex items-center gap-3">
          <AuthNav />
        </div>
      </div>
    </header>
  );
}

export function RouteShell({
  children,
  route,
}: Readonly<{ children: React.ReactNode; route: OurdreamRoute }>) {
  const activeHref = activeHrefForPath(route.path);

  return (
    <div className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref={activeHref} />
        <div className="min-w-0 flex-1 pb-16 md:pb-14">
          <AppTopbar activeHref={activeHref} currentPath={route.path} />
          <main>{children}</main>
        </div>
      </div>
      <SiteFooter />
      <MobileBottomNav activeHref={activeHref} />
    </div>
  );
}

function PageHero({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <section className="px-4 pb-8 pt-10 md:px-[60px] md:pb-12 md:pt-14">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-center gap-2 text-[12px] font-bold uppercase leading-4 text-[rgb(253,95,194)]">
          <span>{route.eyebrow ?? "ourdream.ai"}</span>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-[rgb(170,170,170)]">{route.template}</span>
        </div>
        <h1 className="max-w-4xl text-[40px] font-black uppercase leading-[0.96] tracking-normal text-white md:text-[68px]">
          {route.title}
        </h1>
        <p className="mt-5 max-w-2xl text-[15px] font-medium leading-7 text-[rgb(170,170,170)] md:text-[17px]">
          {route.description}
        </p>
        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
            href="/create"
          >
            Create your AI
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            className="inline-flex h-11 items-center justify-center rounded-full bg-[rgb(46,46,46)] px-5 text-[14px] font-bold text-white hover:bg-[rgb(53,53,54)]"
            href="/"
          >
            Explore characters
          </Link>
        </div>
      </div>
    </section>
  );
}

function FeatureGrid() {
  const features = [
    ["Create", "Shape appearance, personality details, tags, and visual style."],
    ["Chat", "Start long-memory roleplay with public or private characters."],
    ["Generate", "Use image controls with saved gallery results."],
    ["Upgrade", "Review live plans, entitlements, and included dreamcoins."],
  ];

  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="grid gap-3 md:grid-cols-4">
        {features.map(([title, copy]) => (
          <article
            className="rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-5"
            key={title}
          >
            <Sparkles className="mb-5 h-5 w-5 text-[rgb(253,95,194)]" />
            <h2 className="text-[20px] font-black uppercase leading-6 text-white">
              {title}
            </h2>
            <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
              {copy}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function MarketingPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  if (route.path === "/login" || route.path === "/signup") {
    return (
      <RouteShell route={route}>
        <AuthWorkspace mode={route.path === "/signup" ? "signup" : "login"} />
      </RouteShell>
    );
  }

  return (
    <RouteShell route={route}>
      <PageHero route={route} />
      <PublicCharacterStrip />
      <section className="px-4 py-8 md:px-[60px] md:py-12">
        <div className="relative overflow-hidden rounded-[18px] bg-[rgb(18,18,18)]">
          <Image
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-55"
            height={288}
            loading="eager"
            src="/images/ourdream/promo-card-female.webp"
            unoptimized
            width={1440}
          />
          <div className="relative max-w-xl p-6 md:p-10">
            <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
              Start free
            </p>
            <h2 className="mt-3 text-[32px] font-black uppercase leading-8 text-white md:text-[42px] md:leading-10">
              Build your dream companion
            </h2>
            <p className="mt-4 text-[14px] font-medium leading-6 text-white/80">
              Discover adult AI companions, customize the details that matter,
              and move from exploration to private chat or generation without
              losing context.
            </p>
            <Link
              className="mt-6 inline-flex h-10 items-center justify-center rounded-full bg-white px-5 text-[13px] font-bold text-[rgb(13,13,13)]"
              href="/create"
            >
              Create
            </Link>
          </div>
        </div>
      </section>
      <FeatureGrid />
      <RelatedRoutes route={route} />
    </RouteShell>
  );
}

function CreatePage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <CreateWorkspace />
    </RouteShell>
  );
}

function ChatHubPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <ChatHubWorkspace />
    </RouteShell>
  );
}

function GeneratorPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <GeneratorWorkspace />
      <RelatedRoutes route={route} />
    </RouteShell>
  );
}

function ProfilePage({ route }: Readonly<{ route: OurdreamRoute }>) {
  if (route.path === "/feed") {
    return (
      <RouteShell route={route}>
        <Suspense
          fallback={
            <section className="px-4 py-8 md:px-[60px] md:py-12">
              <p className="mx-auto max-w-5xl text-[13px] font-medium text-[rgb(170,170,170)]">
                Loading feed…
              </p>
            </section>
          }
        >
          <FeedWorkspace />
        </Suspense>
      </RouteShell>
    );
  }

  if (route.path === "/community") {
    return (
      <RouteShell route={route}>
        <Suspense
          fallback={
            <section className="px-4 py-8 md:px-[60px] md:py-12">
              <p className="mx-auto max-w-6xl text-[13px] font-medium text-[rgb(170,170,170)]">
                Loading community…
              </p>
            </section>
          }
        >
          <CommunityWorkspace />
        </Suspense>
      </RouteShell>
    );
  }

  return (
    <RouteShell route={route}>
      <ProfileWorkspace routePath={route.path} />
    </RouteShell>
  );
}

function LibraryPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  const cards = libraryCardsForRoute(route);

  return (
    <RouteShell route={route}>
      <PageHero route={route} />
      <section className="px-4 pb-12 md:px-[60px]">
        {cards.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-3">
            {cards.slice(0, 24).map((card) => (
            <Link
              className="group rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5 transition-colors hover:bg-[rgb(36,36,36)]"
              href={card.path}
              key={card.path}
            >
              <p className="text-[12px] font-bold uppercase leading-4 text-[rgb(253,95,194)]">
                {route.title}
              </p>
              <h2 className="mt-3 text-[20px] font-black uppercase leading-6 text-white">
                {card.title}
              </h2>
              <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                {card.description}
              </p>
              <span className="mt-5 inline-flex items-center gap-2 text-[13px] font-bold text-white">
                Open
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </span>
            </Link>
            ))}
          </div>
        ) : (
          <div
            className="rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-7"
            data-testid="truthful-library-empty-state"
          >
            <h2 className="text-[24px] font-black uppercase leading-7 text-white">
              This collection is being curated
            </h2>
            <p className="mt-3 max-w-2xl text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
              There are no dedicated published guides in this collection yet.
              Existing drafts stay preserved, but they are not presented as
              finished articles.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                className="rounded-full bg-white px-5 py-3 text-[13px] font-bold text-black"
                href="/resources-hub"
              >
                Browse published guides
              </Link>
              <Link
                className="rounded-full bg-[rgb(46,46,46)] px-5 py-3 text-[13px] font-bold text-white"
                href="/create"
              >
                Create a companion
              </Link>
            </div>
          </div>
        )}
      </section>
      <PublicCharacterStrip />
    </RouteShell>
  );
}

function routeCardsFromPaths(paths: string[]) {
  return paths
    .filter(isPublicRouteDiscoverable)
    .map((path) => getOurdreamRoute(path))
    .filter((item): item is OurdreamRoute => Boolean(item));
}

function libraryCardsForRoute(route: OurdreamRoute) {
  if (route.path === "/type") {
    return getRoutesByPrefix("/type/").filter((item) =>
      isPublicRouteDiscoverable(item.path),
    );
  }
  if (route.path === "/videos") {
    return getRoutesByPrefix("/videos/").filter((item) =>
      isPublicRouteDiscoverable(item.path),
    );
  }
  if (route.path === "/resources-hub") {
    return routeCardsFromPaths([
      "/guides/character-cards",
      "/guides/character-card-creator",
      "/guides/sillytavern-setup-guide",
      "/comparison",
      "/create",
      "/generate",
      "/upgrade",
      "/helpdesk",
      "/safety/introduction",
    ]);
  }
  if (route.path === "/games") {
    return routeCardsFromPaths([
      "/generator/ai-roleplay-generator",
      "/sex-chat/ai-sex-chat-roleplay",
      "/type/roleplay-ai-girlfriend",
      "/guides/character-cards",
      "/generate/ai-anime-porn-generator",
      "/type/anime-ai-girlfriend",
    ]);
  }
  if (route.path === "/romantasy") {
    return routeCardsFromPaths([
      "/guides/character-card-creator",
      "/generator/ai-roleplay-generator",
      "/type/roleplay-ai-girlfriend",
      "/type/angel-ai-girlfriend",
      "/type/goth-ai-girlfriend",
      "/guides/character-cards",
    ]);
  }
  return getRoutesByPrefix(`${route.path}/`).filter((item) =>
    isPublicRouteDiscoverable(item.path),
  );
}

type ArticleContent = {
  intro: string;
  sections: Array<{
    body: string;
    bullets?: string[];
    title: string;
  }>;
  faq: Array<{
    answer: string;
    question: string;
  }>;
};

const articleContentByPath: Record<
  DedicatedStaticArticlePath,
  ArticleContent
> = {
  "/guides/character-cards": {
    intro:
      "Use character cards as portable source material for a companion: who they are, how they speak, what scenario they start in, and what should stay consistent across chat and image generation.",
    sections: [
      {
        title: "Overview",
        body:
          "A strong character card is a compact profile, not a lore dump. It gives enough detail for a roleplay model to hold the same voice and situation while leaving room for the user to steer the scene.",
        bullets: [
          "Name, age, role, and relationship to the user.",
          "Personality traits that affect dialogue, not just appearance.",
          "Opening scenario, first message, and the emotional hook.",
          "Visual notes that should carry into generation prompts.",
        ],
      },
      {
        title: "How it works",
        body:
          "In Ourdream, the card idea usually starts in Create, becomes a saved companion, then flows into chat, Generate, and My AI without losing the original character context.",
        bullets: [
          "Start with the character premise and choose the closest style.",
          "Add appearance and personality details before previewing.",
          "Use the first chat turns to test voice and scenario clarity.",
          "Save generated media only after the character identity feels stable.",
        ],
      },
      {
        title: "Best practices",
        body:
          "The best cards are specific where consistency matters and flexible where the user should have control. Keep the profile direct, test it in a real first conversation, then tighten anything that makes the character drift.",
        bullets: [
          "Prefer concrete behavior over long abstract adjectives.",
          "Write one memorable first-message hook.",
          "Keep visual traits short enough to reuse in prompts.",
          "Update the card after testing instead of adding more backstory by default.",
        ],
      },
    ],
    faq: [
      {
        question: "What should a character card include?",
        answer:
          "Include identity, relationship context, personality, scenario, first message, and a few visual anchors. Those fields are enough to make chat and generation feel connected.",
      },
      {
        question: "Do character cards replace the Create flow?",
        answer:
          "No. Treat the card as the source brief. The Create flow turns that brief into a saved companion with profile details, visibility, preview media, and later edits.",
      },
      {
        question: "How long should the card be?",
        answer:
          "Short enough to scan in one sitting. If a detail does not change dialogue, appearance, or the opening scene, keep it out of the first version.",
      },
    ],
  },
  "/guides/character-card-creator": {
    intro:
      "A creator workflow turns a rough companion idea into a reusable card with a clear first scene, repeatable personality, and enough visual direction for media generation.",
    sections: [
      {
        title: "Overview",
        body:
          "Start by deciding the user's relationship to the companion, then write the traits that should show up in the first five chat turns.",
        bullets: [
          "Define the user role before writing the opening.",
          "Choose a voice pattern the model can repeat.",
          "Keep appearance details separate from personality details.",
        ],
      },
      {
        title: "How it works",
        body:
          "Draft the card, test it in chat, revise the first message, then save the stable version to My AI for later generation and edits.",
      },
      {
        title: "Best practices",
        body:
          "Avoid stuffing every possible scene into the card. A focused opening plus a few constraints produces a more consistent companion than a long encyclopedia entry.",
      },
    ],
    faq: [
      {
        question: "Can I revise a card after saving?",
        answer:
          "Yes. Use My AI to edit created companions, duplicate experiments, and keep private drafts separate from public submissions.",
      },
      {
        question: "What makes a card easier to generate from?",
        answer:
          "Clear visual anchors: hair, outfit, mood, setting, and one or two distinctive details that can survive different poses.",
      },
    ],
  },
  "/guides/sillytavern-setup-guide": {
    intro:
      "Use this page as a practical bridge from external card-writing habits into an Ourdream workflow that keeps discovery, chat, creation, and generation in one account.",
    sections: [
      {
        title: "Overview",
        body:
          "SillyTavern-style cards often contain personality, scenario, and first-message fields. Those map cleanly into Ourdream's Create steps when you keep each field focused.",
      },
      {
        title: "How it works",
        body:
          "Move the persona into personality, the scenario into description and opening context, and the visual prompt into appearance details before testing the companion.",
      },
      {
        title: "Best practices",
        body:
          "Keep imported wording concise. After the first chat test, remove anything that makes replies verbose or distracts from the current scene.",
      },
    ],
    faq: [
      {
        question: "Can I bring over an existing card idea?",
        answer:
          "Yes, when you have the right to use that material. Convert it into the Create fields instead of pasting a large unedited block.",
      },
      {
        question: "Where do visuals belong?",
        answer:
          "Put stable appearance details in the character profile and use Generate prompts for scene-specific pose, outfit, and background changes.",
      },
    ],
  },
};

function articleContentForRoute(route: OurdreamRoute): ArticleContent {
  if (!hasDedicatedStaticArticleContent(route.path)) {
    throw new Error(
      `Static article content is not published for route ${route.path}`,
    );
  }
  const content =
    articleContentByPath[route.path as DedicatedStaticArticlePath];
  if (!content) {
    throw new Error(
      `Static article content is not published for route ${route.path}`,
    );
  }
  return content;
}

function ArticlePage({ route }: Readonly<{ route: OurdreamRoute }>) {
  const content = articleContentForRoute(route);
  const tocItems = [...content.sections.map((section) => section.title), "FAQ"];

  return (
    <RouteShell route={route}>
      <article className="px-4 py-10 md:px-[60px] md:py-14">
        <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[260px_1fr]">
          <aside className="hidden md:block">
            <div className="sticky top-24 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-4">
              <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
                In this guide
              </p>
              {tocItems.map((item) => (
                <a
                  className="mt-4 block text-[13px] font-semibold text-[rgb(170,170,170)]"
                  href={`#${item.toLowerCase().replaceAll(" ", "-")}`}
                  key={item}
                >
                  {item}
                </a>
              ))}
            </div>
          </aside>
          <div>
            <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
              Ourdream guide
            </p>
            <h1 className="mt-3 text-[40px] font-black uppercase leading-[0.98] text-white md:text-[60px]">
              {route.title}
            </h1>
            <p className="mt-5 max-w-3xl text-[17px] font-medium leading-8 text-[rgb(170,170,170)]">
              {route.description}
            </p>
            <p className="mt-5 max-w-3xl text-[15px] font-medium leading-7 text-white/80">
              {content.intro}
            </p>
            {content.sections.map((section) => (
              <section
                className="mt-10 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-6"
                id={section.title.toLowerCase().replaceAll(" ", "-")}
                key={section.title}
              >
                <h2 className="text-[26px] font-black uppercase leading-8">
                  {section.title}
                </h2>
                <p className="mt-4 text-[15px] leading-8 text-[rgb(170,170,170)]">
                  {section.body}
                </p>
                {section.bullets ? (
                  <ul className="mt-5 grid gap-3 md:grid-cols-2">
                    {section.bullets.map((bullet) => (
                      <li
                        className="flex gap-3 rounded-[12px] bg-[rgb(36,36,36)] p-3 text-[13px] font-medium leading-5 text-[rgb(210,210,210)]"
                        key={bullet}
                      >
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(253,95,194)]" />
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
            <section
              className="mt-10 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-6"
              id="faq"
            >
              <h2 className="text-[26px] font-black uppercase leading-8">
                FAQ
              </h2>
              <div className="mt-5 grid gap-3">
                {content.faq.map((item) => (
                  <div
                    className="rounded-[12px] bg-[rgb(36,36,36)] p-4"
                    key={item.question}
                  >
                    <h3 className="text-[15px] font-black leading-5 text-white">
                      {item.question}
                    </h3>
                    <p className="mt-2 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                      {item.answer}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </article>
    </RouteShell>
  );
}

const comparisonFeatureRows = [
  {
    area: "Roleplay",
    ourdream:
      "Public and private companions flow from Explore into persistent chat sessions, My AI, and creator profiles.",
    compare:
      "Check whether the alternative keeps character context across discovery, chat history, and private library actions.",
  },
  {
    area: "Creator tools",
    ourdream:
      "Guided Create supports private drafts, public review submission, edit, duplicate, and status handoff in My AI.",
    compare:
      "Check whether the alternative has a full character builder or only prompt-style bot setup.",
  },
  {
    area: "Image generation tools",
    ourdream:
      "Generate supports character selection, mode/background/pose/outfit presets, Gallery actions, Image Edit, and Feed remix provenance.",
    compare:
      "Check whether media creation is connected to the same companion identity or handled as a separate tool.",
  },
  {
    area: "Account and pricing",
    ourdream:
      "Current plan prices and included dreamcoins are loaded from the plan authority below; checkout and billing state live on Upgrade.",
    compare:
      "Compare included credits, chat limits, prepaid access periods, and whether plan changes preserve the current workflow.",
  },
] as const;

function comparisonSubject(route: OurdreamRoute) {
  if (route.path === "/comparison") return "AI companion platforms";
  return route.title
    .replace(/\bAlternative(s)?\b/gi, "")
    .replace(/\bVs\b/g, "vs")
    .replace(/\s+/g, " ")
    .trim();
}

function ComparisonChecklist({ route }: Readonly<{ route: OurdreamRoute }>) {
  const subject = comparisonSubject(route);

  return (
    <section className="px-4 py-10 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="max-w-3xl">
          <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
            Decision checklist
          </p>
          <h2 className="mt-3 text-[32px] font-black uppercase leading-9 text-white md:text-[42px] md:leading-[44px]">
            Compare {subject} by the workflow users actually finish
          </h2>
          <p className="mt-4 text-[15px] font-medium leading-7 text-[rgb(170,170,170)]">
            Use this section to compare roleplay depth, creator controls,
            media tools, and pricing before moving into Create, Chat, Generate,
            or Upgrade.
          </p>
        </div>
        <div className="mt-7 overflow-hidden rounded-[16px] border border-white/10 bg-[rgb(18,18,18)]">
          <div className="grid border-b border-white/10 bg-[rgb(28,28,28)] text-[12px] font-black uppercase leading-4 text-white md:grid-cols-[180px_1fr_1fr]">
            <div className="p-4 text-[rgb(170,170,170)]">Area</div>
            <div className="p-4">Ourdream</div>
            <div className="p-4">What to verify elsewhere</div>
          </div>
          {comparisonFeatureRows.map((row) => (
            <div
              className="grid border-b border-white/10 last:border-b-0 md:grid-cols-[180px_1fr_1fr]"
              key={row.area}
            >
              <div className="bg-[rgb(24,24,24)] p-4 text-[13px] font-black uppercase leading-5 text-[rgb(253,95,194)]">
                {row.area}
              </div>
              <div className="p-4 text-[14px] font-medium leading-7 text-white/85">
                {row.ourdream}
              </div>
              <div className="p-4 text-[14px] font-medium leading-7 text-[rgb(170,170,170)]">
                {row.compare}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ComparisonRouteCards({ route }: Readonly<{ route: OurdreamRoute }>) {
  const cards =
    route.path === "/comparison"
      ? [
          { path: "/create", title: "Create a companion" },
          { path: "/generate", title: "Open Generate" },
          { path: "/upgrade", title: "Review live plans" },
        ]
      : [
          { path: "/comparison", title: "All comparisons" },
          { path: "/create", title: "Create a companion" },
          { path: "/generate", title: "Open Generate" },
        ];

  return (
    <section className="px-4 py-10 md:px-[60px] md:py-12">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
              Next routes
            </p>
            <h2 className="mt-3 text-[32px] font-black uppercase leading-9 text-white md:text-[42px] md:leading-[44px]">
              {route.path === "/comparison"
                ? "Open a focused competitor page"
                : "Move from comparison into the product"}
            </h2>
          </div>
          <Link
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-[rgb(46,46,46)] px-5 text-[13px] font-black text-white hover:bg-[rgb(53,53,54)]"
            href="/upgrade"
          >
            See plans
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-7 grid gap-3 md:grid-cols-3">
          {cards.slice(0, 18).map((item) => (
            <Link
              className="group rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5 transition-colors hover:bg-[rgb(36,36,36)]"
              href={item.path}
              key={item.path}
            >
              <h3 className="text-[20px] font-black uppercase leading-6 text-white">
                {item.title}
              </h3>
              <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                Review feature fit, pricing, creator workflow, and the fastest
                path into a real Ourdream action.
              </p>
              <span className="mt-5 inline-flex items-center gap-2 text-[13px] font-bold text-white">
                Open
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function ComparisonPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <PageHero route={route} />
      <ComparisonChecklist route={route} />
      <ComparisonPlanSnapshot />
      <ComparisonRouteCards route={route} />
    </RouteShell>
  );
}

function UpgradePage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <PageHero route={route} />
      <UpgradeWorkspace />
    </RouteShell>
  );
}

function HelpDeskPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <HelpDeskWorkspace />
    </RouteShell>
  );
}

const termsPolicyLinks = [
  {
    title: "What we won't do",
    copy: "The platform commitments and product boundaries users should know first.",
    href: toSafetyHref("/policies/what-we-wont-do"),
  },
  {
    title: "Acceptable use",
    copy: "Allowed uses, creator responsibilities, and account expectations.",
    href: toSafetyHref("/policies/acceptable-use"),
  },
  {
    title: "Prohibited content",
    copy: "Content categories that cannot be hosted, published, or generated.",
    href: toSafetyHref("/policies/prohibited-content"),
  },
  {
    title: "Age verification",
    copy: "How age checks work in the product and when extra verification applies.",
    href: toSafetyHref("/policies/age-verification"),
  },
  {
    title: "Intellectual property",
    copy: "Rules for creator uploads, generated assets, likeness, and ownership claims.",
    href: toSafetyHref("/policies/intellectual-property"),
  },
  {
    title: "How moderation works",
    copy: "How reports, automated checks, and human review move through the system.",
    href: toSafetyHref("/moderation/how-it-works"),
  },
  {
    title: "Why was my character rejected?",
    copy: "Common rejection categories and the product path to fix a submission.",
    href: toSafetyHref("/moderation/why-rejected"),
  },
  {
    title: "Appeals",
    copy: "How to request a fresh review when a moderation decision looks wrong.",
    href: toSafetyHref("/moderation/appeals"),
  },
  {
    title: "Report a problem",
    copy: "Where to report character, media, message, profile, and account issues.",
    href: toSafetyHref("/reporting/how-to-report"),
  },
  {
    title: "Your safety tools",
    copy: "Account controls for hiding, muting, reporting, and managing your experience.",
    href: toSafetyHref("/your-account/safety-tools"),
  },
  {
    title: "Privacy at a glance",
    copy: "A product-level summary of private chats, account data, and visibility.",
    href: toSafetyHref("/your-account/privacy-summary"),
  },
  {
    title: "Wellbeing resources",
    copy: "External resources and support routes linked from the account center.",
    href: toSafetyHref("/your-account/wellbeing-resources"),
  },
] as const;

const termsActionLinks = [
  { title: "Help Desk", copy: "Submit a beta support request.", href: "/helpdesk" },
  { title: "Profile", copy: "Manage account, preferences, billing, and deletion.", href: "/profile" },
  { title: "Upgrade", copy: "Review plan terms and dreamcoin allowances.", href: "/upgrade" },
  { title: "Trust contact", copy: "Reach the team for trust, legal, or security routing.", href: "/safety/contact" },
] as const;

function TermsPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <article className="px-4 py-12 md:px-[60px]">
        <div className="mx-auto max-w-6xl">
          <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
            Product policy index
          </p>
          <h1 className="mt-3 max-w-4xl text-[44px] font-black uppercase leading-none text-white md:text-[68px]">
            Beta Terms & Policies
          </h1>
          <div className="mt-8 max-w-4xl space-y-5 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-[15px] leading-8 text-[rgb(170,170,170)]">
            <p>
              Ourdream is intended for adults. By using the service, you agree
              to follow the platform rules, respect creator and user safety, and
              avoid content that violates age, consent, likeness, or abuse
              policies.
            </p>
            <p>
              This beta index describes current product behavior, not a copied
              third-party legal agreement. Account access, billing, generated
              media, reports, reviews, and appeals use the local product
              surfaces linked throughout the app.
            </p>
          </div>

          <section className="mt-10">
            <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
                  Policy index
                </p>
                <h2 className="mt-2 text-[28px] font-black uppercase leading-8 text-white">
                  {termsPolicyLinks.length} policy routes
                </h2>
              </div>
              <p className="max-w-lg text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                These links route into the local Safety Center so users can
                move from Terms into the exact policy, report, privacy, or appeal path.
              </p>
            </div>
            <div
              className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
              data-testid="terms-policy-links"
            >
              {termsPolicyLinks.map((item) => (
                <Link
                  className="group rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-5 transition-colors hover:bg-[rgb(36,36,36)]"
                  href={item.href}
                  key={item.href}
                >
                  <div className="flex items-start justify-between gap-4">
                    <h3 className="text-[18px] font-black uppercase leading-6 text-white">
                      {item.title}
                    </h3>
                    <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(253,95,194)] transition-transform group-hover:translate-x-1" />
                  </div>
                  <p className="mt-3 text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                    {item.copy}
                  </p>
                </Link>
              ))}
            </div>
          </section>

          <section className="mt-10">
            <h2 className="text-[28px] font-black uppercase leading-8 text-white">
              Account and support actions
            </h2>
            <div className="mt-4 grid gap-3 md:grid-cols-4" data-testid="terms-action-links">
              {termsActionLinks.map((item) => (
                <Link
                  className="rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-5 transition-colors hover:bg-[rgb(36,36,36)]"
                  href={item.href}
                  key={item.href}
                >
                  <h3 className="text-[16px] font-black uppercase leading-5 text-white">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                    {item.copy}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </article>
    </RouteShell>
  );
}

function RelatedRoutes({ route }: Readonly<{ route: OurdreamRoute }>) {
  const prefix = route.path.split("/").slice(0, 2).join("/") || "/";
  const related = getRoutesByPrefix(`${prefix}/`).filter(
    (item) =>
      item.path !== route.path && isPublicRouteDiscoverable(item.path),
  );

  if (related.length === 0) return null;

  return (
    <section className="px-4 pb-12 md:px-[60px]">
      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-[24px] font-black uppercase leading-7 text-white">
          Related pages
        </h2>
        <PlayCircle className="h-5 w-5 text-[rgb(253,95,194)]" />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {related.slice(0, 6).map((item) => (
          <Link
            className="rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-4 hover:bg-[rgb(36,36,36)]"
            href={item.path}
            key={item.path}
          >
            <p className="text-[16px] font-black uppercase leading-5 text-white">
              {item.title}
            </p>
            <p className="mt-2 text-[12px] font-medium leading-5 text-[rgb(170,170,170)]">
              {item.description}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function OurdreamRoutePage({ route }: Readonly<{ route: OurdreamRoute }>) {
  // /chat is a real chat hub (sessions list), not the marketing template the
  // route metadata otherwise resolves to.
  if (route.path === "/chat") return <ChatHubPage route={route} />;
  if (route.path === "/helpdesk") return <HelpDeskPage route={route} />;

  switch (route.template) {
    case "article":
      return <ArticlePage route={route} />;
    case "comparison":
      return <ComparisonPage route={route} />;
    case "create":
      return <CreatePage route={route} />;
    case "generator":
      return <GeneratorPage route={route} />;
    case "library":
      return <LibraryPage route={route} />;
    case "marketing":
      return <MarketingPage route={route} />;
    case "profile":
      return <ProfilePage route={route} />;
    case "safety":
      return <SafetyCenterPage route={route} />;
    case "terms":
      return <TermsPage route={route} />;
    case "upgrade":
      return <UpgradePage route={route} />;
  }
}
