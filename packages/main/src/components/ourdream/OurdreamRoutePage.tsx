import Image from "next/image";
import Form from "next/form";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronRight,
  PlayCircle,
  Search,
  Sparkles,
} from "lucide-react";
import {
  characterCards,
  getRoutesByPrefix,
  ourdreamRoutePaths,
} from "@/lib/ourdream-data";
import { toSafetyHref } from "@/lib/ourdream-safety-data";
import type { OurdreamRoute } from "@/types/ourdream";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SafetyCenterPage } from "./SafetyCenterPage";
import { SiteFooter } from "./SiteFooter";
import { AuthNav } from "./AuthNav";
import { AuthWorkspace } from "./AuthWorkspace";
import { ChatHubWorkspace } from "./ChatHubWorkspace";
import { CommunityWorkspace } from "./CommunityWorkspace";
import { CreateWorkspace } from "./CreateWorkspace";
import { FeedWorkspace } from "./FeedWorkspace";
import { GeneratorWorkspace } from "./GeneratorWorkspace";
import { HelpDeskWorkspace } from "./HelpDeskWorkspace";
import { ProfileWorkspace } from "./ProfileWorkspace";
import { UpgradeWorkspace } from "./UpgradeWorkspace";
import { MobileAppMenu } from "./MobileAppMenu";

function activeHrefForPath(path: string) {
  if (path === "/login" || path === "/signup") return "";
  if (path.startsWith("/create")) return "/create";
  if (path.startsWith("/chat")) return "/chat";
  if (path.startsWith("/generate") || path.startsWith("/generator")) {
    return "/generate";
  }
  if (path.startsWith("/custom") || path.startsWith("/profile")) return "/custom";
  if (path.startsWith("/feed")) return "/feed";
  if (path.startsWith("/community")) return "/community";
  if (path.startsWith("/helpdesk")) return "/helpdesk";
  if (path.startsWith("/safety")) return "/safety/introduction";
  if (
    path.startsWith("/resources-hub") ||
    path.startsWith("/type") ||
    path.startsWith("/comparison") ||
    path.startsWith("/videos") ||
    path.startsWith("/ai-instructions") ||
    path.startsWith("/ai-girlfriend") ||
    path.startsWith("/ai-boyfriend") ||
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
        <Form
          action="/"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 py-2 text-[12px] font-medium leading-4 text-[rgb(170,170,170)] md:max-w-[340px]"
        >
          <button
            aria-label="Search"
            className="grid h-4 w-4 shrink-0 place-items-center text-[rgb(170,170,170)] transition hover:text-white"
            type="submit"
          >
            <Search aria-hidden="true" className="h-4 w-4" />
          </button>
          <input
            aria-label="Search characters, guides, and generators"
            autoComplete="off"
            className="min-w-0 flex-1 truncate bg-transparent text-white outline-none placeholder:text-[rgb(170,170,170)]"
            name="q"
            placeholder="Search characters, guides, and generators"
            type="search"
          />
        </Form>
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
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref={activeHref} />
        <div className="min-w-0 flex-1 pb-16 md:pb-14">
          <AppTopbar activeHref={activeHref} currentPath={route.path} />
          {children}
        </div>
      </div>
      <SiteFooter />
      <MobileBottomNav activeHref={activeHref} />
    </main>
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

function CharacterStrip() {
  return (
    <section className="px-4 py-8 md:px-[60px] md:py-12">
      <div className="grid gap-3 md:grid-cols-4">
        {characterCards.slice(0, 4).map((card) => (
          <article
            className="group overflow-hidden rounded-[14px] border border-white/10 bg-[rgb(18,18,18)]"
            key={card.id}
          >
            <div className="relative aspect-[240/260] overflow-hidden">
              <Image
                alt=""
                className="object-cover object-top transition-transform duration-200 group-hover:scale-[1.03]"
                fill
                sizes="(max-width: 767px) 50vw, 220px"
                src={card.image}
              />
              <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.78),rgba(0,0,0,.18)_58%,transparent)]" />
              <div className="absolute inset-x-0 bottom-0 p-3">
                <h3 className="line-clamp-2 text-[17px] font-bold leading-5">
                  {card.title}
                  <span className="ml-2 text-[14px]">{card.age}</span>
                </h3>
                <p className="mt-1 text-[12px] font-medium leading-4 text-[rgb(170,170,170)]">
                  {card.chats} plays
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function FeatureGrid() {
  const features = [
    ["Create", "Shape appearance, personality, voice, and style."],
    ["Chat", "Start long-memory roleplay with public or private characters."],
    ["Generate", "Use image controls with saved gallery results."],
    ["Upgrade", "Mirror the premium plan and dreamcoin subscription surface."],
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
      <CharacterStrip />
      <section className="px-4 py-8 md:px-[60px] md:py-12">
        <div className="relative overflow-hidden rounded-[18px] bg-[rgb(18,18,18)]">
          <Image
            alt=""
            className="absolute inset-0 h-full w-full object-cover opacity-55"
            height={288}
            src="/images/ourdream/pride-banner-female.webp"
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
        <FeedWorkspace />
      </RouteShell>
    );
  }

  if (route.path === "/community") {
    return (
      <RouteShell route={route}>
        <CommunityWorkspace />
      </RouteShell>
    );
  }

  return (
    <RouteShell route={route}>
      <ProfileWorkspace />
    </RouteShell>
  );
}

function LibraryPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  const cards =
    route.path === "/type"
      ? getRoutesByPrefix("/type/")
      : route.path === "/videos"
        ? getRoutesByPrefix("/videos/")
        : route.path === "/resources-hub"
          ? ourdreamRoutePaths
              .filter((path) =>
                ["/guides/", "/comparison/", "/videos/", "/type/"].some((prefix) =>
                  path.startsWith(prefix),
                ),
              )
              .slice(0, 24)
              .map((path) => ({ path, title: path.split("/").at(-1) ?? path }))
          : getRoutesByPrefix(`${route.path}/`);

  return (
    <RouteShell route={route}>
      <PageHero route={route} />
      <section className="px-4 pb-12 md:px-[60px]">
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
                Browse related guides, generators, companion styles, and
                discovery routes in the Ourdream experience.
              </p>
              <span className="mt-5 inline-flex items-center gap-2 text-[13px] font-bold text-white">
                Open
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </span>
            </Link>
          ))}
        </div>
      </section>
      <CharacterStrip />
    </RouteShell>
  );
}

function ArticlePage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <article className="px-4 py-10 md:px-[60px] md:py-14">
        <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-[260px_1fr]">
          <aside className="hidden md:block">
            <div className="sticky top-24 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-4">
              <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
                In this guide
              </p>
              {["Overview", "How it works", "Best practices", "FAQ"].map((item) => (
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
            {["Overview", "How it works", "Best practices"].map((section, index) => (
              <section
                className="mt-10 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-6"
                id={section.toLowerCase().replaceAll(" ", "-")}
                key={section}
              >
                <h2 className="text-[26px] font-black uppercase leading-8">
                  {section}
                </h2>
                <p className="mt-4 text-[15px] leading-8 text-[rgb(170,170,170)]">
                  Ourdream combines adult character discovery, private chat,
                  companion creation, generation tools, and safety controls so
                  each workflow can move from idea to saved experience.
                </p>
                {index === 1 && (
                  <div className="mt-5 grid gap-3 md:grid-cols-3">
                    {characterCards.slice(0, 3).map((card) => (
                      <div
                        className="rounded-[12px] bg-[rgb(36,36,36)] p-3"
                        key={card.id}
                      >
                        <p className="text-[14px] font-bold text-white">
                          {card.title}
                        </p>
                        <p className="mt-1 text-[12px] text-[rgb(170,170,170)]">
                          {card.chats} chats
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        </div>
      </article>
    </RouteShell>
  );
}

function ComparisonPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  const routes = route.path === "/comparison" ? getRoutesByPrefix("/comparison/") : [];
  const competitors = routes.length
    ? routes
    : [
        route,
        { ...route, path: "/upgrade", title: "Pricing" },
        { ...route, path: "/generate", title: "Generation" },
      ];

  return (
    <RouteShell route={route}>
      <PageHero route={route} />
      <section className="px-4 pb-12 md:px-[60px]">
        <div className="grid gap-3 md:grid-cols-3">
          {competitors.slice(0, 18).map((item) => (
            <Link
              className="rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-5 hover:bg-[rgb(36,36,36)]"
              href={item.path}
              key={item.path}
            >
              <h2 className="text-[20px] font-black uppercase leading-6">
                {item.title}
              </h2>
              <ul className="mt-5 space-y-3 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                {["Unlimited messaging", "Creator controls", "Image generation tools"].map(
                  (feature) => (
                    <li className="flex gap-2" key={feature}>
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-[rgb(253,95,194)]" />
                      <span>{feature}</span>
                    </li>
                  ),
                )}
              </ul>
            </Link>
          ))}
        </div>
      </section>
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
            Terms
          </p>
          <h1 className="mt-3 max-w-4xl text-[44px] font-black uppercase leading-none text-white md:text-[68px]">
            Terms & Policies
          </h1>
          <div className="mt-8 max-w-4xl space-y-5 rounded-[14px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-[15px] leading-8 text-[rgb(170,170,170)]">
            <p>
              Ourdream is intended for adults. By using the service, you agree
              to follow the platform rules, respect creator and user safety, and
              avoid content that violates age, consent, likeness, or abuse
              policies.
            </p>
            <p>
              Account access, billing, generated media, reports, moderation
              reviews, and appeals are handled through the product surfaces and
              support routes linked throughout the app.
            </p>
          </div>

          <section className="mt-10">
            <div className="mb-5 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
                  Policy index
                </p>
                <h2 className="mt-2 text-[28px] font-black uppercase leading-8 text-white">
                  12 policy routes
                </h2>
              </div>
              <p className="max-w-lg text-[13px] font-medium leading-6 text-[rgb(170,170,170)]">
                These links route into the local Safety Center mirror so users can
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
    (item) => item.path !== route.path,
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
