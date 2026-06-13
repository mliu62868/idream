import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Crown,
  ImageIcon,
  Lock,
  PlayCircle,
  Search,
  Settings2,
  Sparkles,
  Wand2,
} from "lucide-react";
import {
  characterCards,
  getRoutesByPrefix,
  ourdreamRoutePaths,
} from "@/lib/ourdream-data";
import type { OurdreamRoute } from "@/types/ourdream";
import { AppSidebar } from "./AppSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SafetyCenterPage } from "./SafetyCenterPage";
import { SiteFooter } from "./SiteFooter";

function activeHrefForPath(path: string) {
  if (path.startsWith("/create")) return "/create";
  if (path.startsWith("/chat")) return "/chat";
  if (path.startsWith("/generate") || path.startsWith("/generator")) {
    return "/generate";
  }
  if (path.startsWith("/custom") || path === "/profile") return "/custom";
  return "/";
}

function AppTopbar() {
  return (
    <header className="sticky top-0 z-40 h-14 w-full bg-[rgba(13,13,13,0.62)] backdrop-blur-xl">
      <div className="flex h-14 items-center justify-between gap-3 px-4 md:px-[60px]">
        <Link className="hidden md:block" href="/">
          <Image
            alt="ourdream.ai"
            className="h-3.5 w-auto"
            height={15}
            src="/images/ourdream/ourdream-logo.svg"
            width={130}
          />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-4 py-2 text-[12px] font-medium leading-4 text-[rgb(170,170,170)] md:max-w-[340px]">
          <Search className="h-4 w-4 shrink-0" />
          <span className="truncate">Search characters, guides, and generators</span>
        </div>
        <Link
          className="hidden text-[12px] font-bold leading-4 text-white md:block"
          href="/login"
        >
          Login
        </Link>
        <Link
          className="rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] px-4 py-2 text-[12px] font-bold leading-4 text-white"
          href="/signup"
        >
          Join Free
        </Link>
      </div>
    </header>
  );
}

function RouteShell({
  children,
  route,
}: Readonly<{ children: React.ReactNode; route: OurdreamRoute }>) {
  const activeHref = activeHrefForPath(route.path);

  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref={activeHref} />
        <div className="min-w-0 flex-1 pb-16 md:pb-14">
          <AppTopbar />
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
    ["Generate", "Use image and video controls from the target generator flow."],
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
              The target page combines creator CTAs, feature blocks, testimonials,
              and internal article cards. This clone preserves that structure for
              every public marketing route.
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
  const controls = ["Gender", "Style", "Personality", "Voice", "Relationship"];

  return (
    <RouteShell route={route}>
      <section className="px-4 pb-12 pt-10 md:px-[60px] md:pb-16">
        <div className="mx-auto max-w-6xl">
          <h1 className="text-center text-[clamp(28px,6vw,52px)] font-black leading-none text-white">
            Create Your Dream AI Girl
          </h1>
          <div className="mt-9 grid gap-4 md:grid-cols-[360px_1fr]">
            <div className="relative min-h-[560px] overflow-hidden rounded-[20px] bg-[rgb(18,18,18)]">
              <Image
                alt=""
                className="object-cover object-top"
                fill
                priority
                sizes="360px"
                src="/images/ourdream/card-sarah-mercer.webp"
              />
              <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.82),rgba(0,0,0,.1)_62%,transparent)]" />
              <div className="absolute inset-x-0 bottom-0 p-5">
                <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
                  Preview
                </p>
                <h2 className="mt-2 text-[26px] font-black leading-7">
                  Your custom character
                </h2>
                <p className="mt-2 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                  The original creator starts with a large centered title and
                  guides users through compact selection controls.
                </p>
              </div>
            </div>
            <div className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-6">
              <div className="grid gap-3 md:grid-cols-2">
                {controls.map((control) => (
                  <button
                    className="flex min-h-20 items-center justify-between rounded-[14px] bg-[rgb(36,36,36)] px-4 text-left text-white transition-colors hover:bg-[rgb(46,46,46)]"
                    key={control}
                  >
                    <span>
                      <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                        Select
                      </span>
                      <span className="mt-1 block text-[18px] font-bold leading-6">
                        {control}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 text-[rgb(170,170,170)]" />
                  </button>
                ))}
              </div>
              <div className="mt-5 rounded-[14px] bg-[rgb(36,36,36)] p-4">
                <label className="text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                  Custom prompt
                </label>
                <div className="mt-3 min-h-28 rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-[rgb(170,170,170)]">
                  Describe the companion you want to create.
                </div>
              </div>
              <button className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[14px] font-black text-white">
                <Wand2 className="h-4 w-4" />
                Generate character
              </button>
            </div>
          </div>
        </div>
      </section>
    </RouteShell>
  );
}

function GeneratorPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  const fields = [
    "Select Character (required)",
    "Background (optional)",
    "Pose (optional)",
    "Outfit (optional)",
    "Custom Prompt (premium feature)",
  ];

  return (
    <RouteShell route={route}>
      <section className="px-4 py-8 md:px-[60px] md:py-12">
        <div className="mx-auto grid max-w-6xl gap-5 md:grid-cols-[420px_1fr]">
          <div className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
            <div className="grid grid-cols-2 rounded-full bg-[rgb(36,36,36)] p-1">
              {["Image", "Video"].map((mode, index) => (
                <button
                  className={`h-10 rounded-full text-[13px] font-bold ${
                    index === 0
                      ? "bg-white text-[rgb(13,13,13)]"
                      : "text-[rgb(170,170,170)]"
                  }`}
                  key={mode}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="mt-4 space-y-3">
              {fields.map((field, index) => (
                <button
                  className="flex h-12 w-full items-center justify-between rounded-[12px] bg-[rgb(36,36,36)] px-4 text-left text-[13px] font-semibold text-[rgb(170,170,170)]"
                  key={field}
                >
                  <span>{field}</span>
                  {index === 4 ? (
                    <Lock className="h-4 w-4" />
                  ) : (
                    <Settings2 className="h-4 w-4" />
                  )}
                </button>
              ))}
            </div>
            <button className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[14px] font-black text-white">
              <ImageIcon className="h-4 w-4" />
              Generate
            </button>
          </div>

          <div className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4">
            <div className="mb-4 flex gap-2">
              {["Images", "Videos", "Liked"].map((tab, index) => (
                <button
                  className={`h-9 rounded-full px-4 text-[12px] font-bold ${
                    index === 0
                      ? "bg-[rgb(46,46,46)] text-white"
                      : "text-[rgb(170,170,170)]"
                  }`}
                  key={tab}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {characterCards.slice(2, 8).map((card) => (
                <div
                  className="relative aspect-[4/5] overflow-hidden rounded-[14px] bg-[rgb(36,36,36)]"
                  key={card.id}
                >
                  <Image
                    alt=""
                    className="object-cover object-top"
                    fill
                    sizes="180px"
                    src={card.image}
                  />
                  <div className="absolute bottom-2 left-2 right-2 rounded-full bg-black/45 px-3 py-1 text-[11px] font-bold">
                    {card.title}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      <RelatedRoutes route={route} />
    </RouteShell>
  );
}

function ProfilePage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <section className="px-4 py-10 md:px-[60px]">
        <div className="mx-auto max-w-5xl">
          <h1 className="text-[38px] font-black uppercase leading-10 text-white">
            {route.title}
          </h1>
          <div className="mt-6 flex flex-wrap gap-2">
            {["Recent Characters", "Group Chats", "Packs", "Presets", "Created"].map(
              (tab, index) => (
                <button
                  className={`h-10 rounded-full px-4 text-[13px] font-bold ${
                    index === 0
                      ? "bg-[rgb(46,46,46)] text-white"
                      : "text-[rgb(170,170,170)]"
                  }`}
                  key={tab}
                >
                  {tab}
                </button>
              ),
            )}
          </div>
          <div className="mt-10 rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-10 text-center">
            <Bot className="mx-auto h-10 w-10 text-[rgb(114,113,112)]" />
            <h2 className="mt-4 text-[22px] font-black uppercase">
              No characters yet
            </h2>
            <p className="mx-auto mt-3 max-w-md text-[14px] leading-6 text-[rgb(170,170,170)]">
              The target route presents a personal collection shell. This clone
              keeps the tabbed empty-state surface without implementing account
              storage.
            </p>
            <Link
              className="mt-6 inline-flex h-11 items-center justify-center rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)]"
              href="/create"
            >
              Create
            </Link>
          </div>
        </div>
      </section>
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
                Public sitemap route cloned into the shared Ourdream page
                system.
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
                  The original route uses a long editorial article layout with a
                  dark background, bold white headings, muted body copy, inline
                  links, and related CTAs. This cloned route preserves that page
                  architecture for sitemap coverage while keeping backend and
                  account features out of scope.
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
                {["Unlimited messaging", "Creator controls", "Image and video tools"].map(
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
      <section className="px-4 pb-14 md:px-[60px]">
        <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
          {[
            ["Yearly", "$9.99", "Billed as one annual payment"],
            ["Monthly", "$19.99", "Flexible month-to-month access"],
          ].map(([name, price, copy], index) => (
            <article
              className={`rounded-[20px] border p-6 ${
                index === 0
                  ? "border-[rgb(253,95,194)] bg-[rgb(36,36,36)]"
                  : "border-white/10 bg-[rgb(18,18,18)]"
              }`}
              key={name}
            >
              <Crown className="h-6 w-6 text-[rgb(253,95,194)]" />
              <h2 className="mt-4 text-[26px] font-black uppercase">{name}</h2>
              <p className="mt-2 text-[44px] font-black leading-none">{price}</p>
              <p className="mt-3 text-[14px] leading-6 text-[rgb(170,170,170)]">
                {copy}
              </p>
              <button className="mt-6 h-11 w-full rounded-full bg-white text-[14px] font-black text-[rgb(13,13,13)]">
                Upgrade
              </button>
            </article>
          ))}
        </div>
      </section>
    </RouteShell>
  );
}

function TermsPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  return (
    <RouteShell route={route}>
      <article className="px-4 py-12 md:px-[60px]">
        <div className="mx-auto max-w-4xl">
          <h1 className="text-[44px] font-black uppercase leading-none text-white">
            Terms & Policies
          </h1>
          <div className="mt-8 space-y-5 rounded-[18px] border border-white/10 bg-[rgb(18,18,18)] p-6 text-[15px] leading-8 text-[rgb(170,170,170)]">
            <p>
              This visual clone recreates the public terms route surface and
              footer navigation. It does not reproduce account systems,
              payments, moderation tooling, or legally binding policy behavior.
            </p>
            <p>
              The original site links to terms from the age gate and footer. In
              this clone, the route remains available so every public link has a
              matching page.
            </p>
          </div>
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
