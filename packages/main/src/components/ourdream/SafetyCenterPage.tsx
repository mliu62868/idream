import Image from "next/image";
import Link from "next/link";
import {
  Ban,
  Check,
  ChevronRight,
  CircleQuestionMark,
  Compass,
  Flag,
  Heart,
  IdCard,
  Mail,
  Menu,
  Moon,
  Monitor,
  Search,
  Shield,
  ShieldCheck,
  Sun,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  getNextSafetyDocument,
  getSafetyDocumentForRoute,
  safetyNavGroups,
  toSafetyHref,
} from "@/lib/ourdream-safety-data";
import { cn } from "@/lib/utils";
import type { OurdreamRoute } from "@/types/ourdream";

const imagePathMap: Record<string, string> = {
  "logo/dark.svg": "/images/ourdream/safety/logo-dark.svg",
  "logo/light.svg": "/images/ourdream/safety/logo-light.svg",
  "images/defense-in-depth-dark.svg":
    "/images/ourdream/safety/images-defense-in-depth-dark.svg",
  "images/defense-in-depth-light.svg":
    "/images/ourdream/safety/images-defense-in-depth-light.svg",
};

const cardIcons: Record<string, LucideIcon> = {
  ban: Ban,
  check: Check,
  "circle-question": CircleQuestionMark,
  compass: Compass,
  envelope: Mail,
  flag: Flag,
  heart: Heart,
  "id-card": IdCard,
  shield: Shield,
  "shield-check": ShieldCheck,
};

function safetySlugify(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function stripBoilerplate(markdown: string) {
  const lines = markdown.split("\n");
  let index = 0;

  if (lines[index]?.startsWith("> ## Documentation Index")) {
    while (
      index < lines.length &&
      (lines[index].startsWith(">") || lines[index].trim() === "")
    ) {
      index += 1;
    }
  }

  if (lines[index]?.startsWith("# ")) {
    index += 1;
    while (lines[index]?.trim() === "") index += 1;
    if (lines[index]?.startsWith("> ")) index += 1;
    while (lines[index]?.trim() === "") index += 1;
  }

  return lines.slice(index);
}

function normalizeMarkdownText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeHref(href: string) {
  return href.replace(/\\([()])/g, "$1");
}

function SafetyInlineLink({
  children,
  href,
}: Readonly<{ children: React.ReactNode; href: string }>) {
  const normalizedHref = normalizeHref(href);
  const localHref = toSafetyHref(normalizedHref);
  const className =
    "font-semibold text-[#d7d2d5] underline decoration-[#f17bb6] decoration-2 underline-offset-4 transition-colors hover:text-white";

  if (localHref.startsWith("http") || localHref.startsWith("mailto:")) {
    return (
      <a className={className} href={localHref} rel="noopener" target="_blank">
        {children}
      </a>
    );
  }

  if (localHref.startsWith("#")) {
    return (
      <a className={className} href={localHref}>
        {children}
      </a>
    );
  }

  return (
    <Link className={className} href={localHref}>
      {children}
    </Link>
  );
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\[([^\]]+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let lastIndex = 0;
  let match = pattern.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[2] !== undefined && match[3] !== undefined) {
      nodes.push(
        <SafetyInlineLink href={match[3]} key={`${keyPrefix}-link-${match.index}`}>
          {renderInline(match[2], `${keyPrefix}-link-${match.index}`)}
        </SafetyInlineLink>,
      );
    } else if (match[5] !== undefined) {
      nodes.push(
        <strong
          className="font-bold text-[#d7d2d5]"
          key={`${keyPrefix}-strong-${match.index}`}
        >
          {renderInline(match[5], `${keyPrefix}-strong-${match.index}`)}
        </strong>,
      );
    } else if (match[7] !== undefined) {
      nodes.push(
        <em className="italic text-[#d7d2d5]" key={`${keyPrefix}-em-${match.index}`}>
          {renderInline(match[7], `${keyPrefix}-em-${match.index}`)}
        </em>,
      );
    }

    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function extractHeadings(markdown: string) {
  return stripBoilerplate(markdown)
    .filter((line) => line.startsWith("## "))
    .map((line) => {
      const title = line.replace(/^##\s+/, "").trim();
      return {
        id: safetySlugify(title),
        title,
      };
    });
}

function isBlockStart(line: string) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("#") ||
    trimmed.startsWith("<CardGroup") ||
    trimmed.startsWith("<Note") ||
    trimmed.startsWith("<img") ||
    trimmed.startsWith("|") ||
    trimmed.startsWith("* ") ||
    /^\d+\.\s+/.test(trimmed)
  );
}

function parseImageLine(line: string) {
  const dataPath = line.match(/data-path="([^"]+)"/)?.[1];
  const alt = line.match(/alt="([^"]*)"/)?.[1] ?? "";
  const width = Number(line.match(/width="([^"]+)"/)?.[1] ?? 720);
  const height = Number(line.match(/height="([^"]+)"/)?.[1] ?? 460);

  if (!dataPath || dataPath.includes("light.svg")) return undefined;

  const src = imagePathMap[dataPath];
  if (!src) return undefined;

  return { alt, height, src, width };
}

function SafetyMarkdownImage({
  alt,
  height,
  src,
  width,
}: Readonly<{ alt: string; height: number; src: string; width: number }>) {
  const logo = src.includes("logo");

  return (
    <div className={cn("my-7", logo ? "flex justify-start" : "overflow-hidden")}>
      <Image
        alt={alt}
        className={cn(
          "h-auto",
          logo ? "w-[130px]" : "w-full rounded-2xl border border-white/10",
        )}
        height={height}
        src={src}
        width={width}
      />
    </div>
  );
}

function renderCardGroup(block: string, keyPrefix: string) {
  const cards = [...block.matchAll(/<Card title="([^"]+)" icon="([^"]+)" href="([^"]+)">\s*([\s\S]*?)\s*<\/Card>/g)].map(
    (match) => ({
      description: normalizeMarkdownText(match[4]),
      href: match[3],
      icon: match[2],
      title: match[1],
    }),
  );

  return (
    <div
      className="my-3 grid max-w-none grid-cols-1 gap-x-4 gap-y-0 sm:grid-cols-2"
      key={keyPrefix}
    >
      {cards.map((card) => {
        const Icon = cardIcons[card.icon] ?? Compass;
        return (
          <Link
            className="group my-2 block min-h-[158px] overflow-hidden rounded-2xl border border-white/10 bg-[#0d0d0d] transition-colors hover:border-[#f17bb6]"
            href={toSafetyHref(card.href)}
            key={card.href}
          >
            <div className="relative px-6 py-5">
              <Icon className="mb-5 h-5 w-5 text-[#f17bb6]" strokeWidth={2.1} />
              <h3 className="text-[16px] font-semibold leading-6 text-[#e6e1e4]">
                {card.title}
              </h3>
              <p className="mt-1 text-[16px] font-normal leading-6 text-[#8f898d]">
                {card.description}
              </p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function renderNote(block: string, keyPrefix: string) {
  const body = block
    .replace(/^<Note>\s*/, "")
    .replace(/\s*<\/Note>$/, "")
    .split("\n")
    .map((line) => line.trim())
    .join(" ");

  return (
    <div
      className="my-6 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-[15px] leading-7 text-[#a6a1a4]"
      key={keyPrefix}
    >
      {renderInline(normalizeMarkdownText(body), `${keyPrefix}-note`)}
    </div>
  );
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(block: string[], keyPrefix: string) {
  const rows = block.map(splitTableRow);
  const [head = [], separator, ...body] = rows;
  const bodyRows = separator ? body : rows.slice(1);

  return (
    <div className="my-6 overflow-x-auto rounded-2xl border border-white/10" key={keyPrefix}>
      <table className="min-w-full border-collapse text-left text-[14px] leading-6">
        <thead className="bg-white/[0.04] text-[#e6e1e4]">
          <tr>
            {head.map((cell) => (
              <th className="border-b border-white/10 px-4 py-3 font-semibold" key={cell}>
                {renderInline(cell, `${keyPrefix}-th-${cell}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bodyRows.map((row, rowIndex) => (
            <tr className="border-b border-white/5 last:border-b-0" key={`${keyPrefix}-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td className="px-4 py-3 text-[#a6a1a4]" key={`${keyPrefix}-${rowIndex}-${cellIndex}`}>
                  {renderInline(cell, `${keyPrefix}-td-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderList(
  lines: string[],
  startIndex: number,
  ordered: boolean,
  keyPrefix: string,
) {
  const items: string[] = [];
  let index = startIndex;
  const itemPattern = ordered ? /^\d+\.\s+(.*)$/ : /^\*\s+(.*)$/;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const itemMatch = trimmed.match(itemPattern);

    if (itemMatch) {
      items.push(itemMatch[1]);
      index += 1;
      continue;
    }

    if (trimmed === "") break;
    if (items.length > 0 && line.startsWith("  ")) {
      items[items.length - 1] = `${items[items.length - 1]} ${trimmed}`;
      index += 1;
      continue;
    }

    break;
  }

  const ListTag = ordered ? "ol" : "ul";

  return {
    index,
    node: (
      <ListTag
        className={cn(
          "my-5 ml-6 space-y-2 text-[16px] leading-7 text-[#a6a1a4] marker:text-[#a6a1a4]",
          ordered ? "list-decimal" : "list-disc",
        )}
        key={keyPrefix}
      >
        {items.map((item, itemIndex) => (
          <li key={`${keyPrefix}-${itemIndex}`}>
            {renderInline(normalizeMarkdownText(item), `${keyPrefix}-${itemIndex}`)}
          </li>
        ))}
      </ListTag>
    ),
  };
}

function SafetyMarkdown({ markdown }: Readonly<{ markdown: string }>) {
  const lines = stripBoilerplate(markdown);
  const nodes: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === "") {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("<img")) {
      const image = parseImageLine(trimmed);
      if (image) {
        nodes.push(<SafetyMarkdownImage {...image} key={`image-${index}`} />);
      }
      index += 1;
      continue;
    }

    if (trimmed.startsWith("<CardGroup")) {
      const block: string[] = [];
      while (index < lines.length && !lines[index].includes("</CardGroup>")) {
        block.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        block.push(lines[index]);
        index += 1;
      }
      nodes.push(renderCardGroup(block.join("\n"), `cards-${index}`));
      continue;
    }

    if (trimmed.startsWith("<Note")) {
      const block: string[] = [];
      while (index < lines.length && !lines[index].includes("</Note>")) {
        block.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        block.push(lines[index]);
        index += 1;
      }
      nodes.push(renderNote(block.join("\n"), `note-${index}`));
      continue;
    }

    if (trimmed.startsWith("## ")) {
      const text = trimmed.replace(/^##\s+/, "");
      const id = safetySlugify(text);
      nodes.push(
        <h2
          className="mb-4 mt-12 scroll-mt-32 text-[24px] font-semibold leading-8 tracking-[-0.6px] text-white"
          id={id}
          key={`h2-${id}-${index}`}
        >
          {renderInline(text, `h2-${index}`)}
        </h2>,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith("### ")) {
      const text = trimmed.replace(/^###\s+/, "");
      const id = safetySlugify(text);
      nodes.push(
        <h3
          className="mb-3 mt-8 scroll-mt-32 text-[19px] font-semibold leading-7 tracking-[-0.3px] text-[#e6e1e4]"
          id={id}
          key={`h3-${id}-${index}`}
        >
          {renderInline(text, `h3-${index}`)}
        </h3>,
      );
      index += 1;
      continue;
    }

    if (trimmed.startsWith("|")) {
      const block: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        block.push(lines[index]);
        index += 1;
      }
      nodes.push(renderTable(block, `table-${index}`));
      continue;
    }

    if (trimmed.startsWith("* ")) {
      const result = renderList(lines, index, false, `ul-${index}`);
      nodes.push(result.node);
      index = result.index;
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const result = renderList(lines, index, true, `ol-${index}`);
      nodes.push(result.node);
      index = result.index;
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    if (paragraphLines.length > 0) {
      const paragraph = normalizeMarkdownText(paragraphLines.join(" "));
      nodes.push(
        <p className="my-5 text-[16px] leading-7 text-[#a6a1a4]" key={`p-${index}`}>
          {renderInline(paragraph, `p-${index}`)}
        </p>,
      );
      continue;
    }

    index += 1;
  }

  return <div className="relative mt-8 mb-14">{nodes}</div>;
}

function SafetyHeader() {
  return (
    <header className="fixed top-0 z-30 w-full border-b border-white/[0.07] bg-[#0d0d0d]/95 font-safety-docs backdrop-blur lg:sticky">
      <div className="flex h-16 items-center gap-4 px-4 lg:px-12">
        <Link className="flex shrink-0 items-center" href="/">
          <Image
            alt="ourdream Trust & Safety home page"
            className="h-6 w-auto"
            height={15}
            priority
            src="/images/ourdream/safety/logo-dark.svg"
            width={130}
          />
        </Link>
        <button className="mx-auto flex h-9 w-full max-w-[440px] items-center justify-between rounded-xl border border-white/10 bg-[#0d0d0d] px-3 text-left text-[14px] text-[#777276] shadow-[0_1px_2px_rgba(0,0,0,0.25)]">
          <span className="flex items-center gap-2">
            <Search className="h-4 w-4" />
            <span>Search...</span>
          </span>
          <span className="hidden text-[12px] font-semibold text-[#8f898d] sm:block">
            ⌘K
          </span>
        </button>
        <nav className="hidden items-center gap-6 text-[14px] font-semibold text-[#8f898d] md:flex">
          <Link className="transition-colors hover:text-white" href="/">
            ourdream
          </Link>
          <Link
            className="inline-flex h-9 items-center rounded-xl bg-[#ff79c5] px-4 text-white transition-colors hover:bg-[#f17bb6]"
            href="/safety/reporting/how-to-report"
          >
            Report a problem
          </Link>
          <button aria-label="Toggle dark mode" className="text-[#777276]">
            <Moon className="h-4 w-4" />
          </button>
        </nav>
      </div>
      <div className="flex h-12 items-center border-t border-white/[0.06] px-4 lg:px-12">
        <Link
          className="flex h-full items-center border-b-2 border-[#f17bb6] text-[14px] font-semibold text-[#e6e1e4]"
          href="/safety/introduction"
        >
          Trust & Safety
        </Link>
        <button className="ml-auto inline-flex items-center gap-2 text-[14px] font-semibold text-[#a6a1a4] lg:hidden">
          <Menu className="h-4 w-4" />
          Navigation
        </button>
      </div>
    </header>
  );
}

function SafetySidebar({ activePath }: Readonly<{ activePath: string }>) {
  return (
    <aside className="hidden w-72 shrink-0 lg:block">
      <nav className="fixed bottom-0 left-8 top-[114px] w-72 overflow-y-auto pb-8 pr-8 pt-8">
        {safetyNavGroups.map((group) => (
          <div className="mt-8 first:mt-0" key={group.title}>
            <h3 className="mb-3 text-[14px] font-semibold leading-6 text-[#d7d2d5]">
              {group.title}
            </h3>
            <ul className="space-y-px">
              {group.items.map((item) => {
                const active = item.path === activePath;
                return (
                  <li key={item.path}>
                    <Link
                      className={cn(
                        "flex min-h-9 w-64 items-start rounded-xl px-4 py-1.5 text-[14px] leading-6 transition-colors",
                        active
                          ? "bg-[#f17bb6]/10 font-semibold text-[#f17bb6]"
                          : "text-[#a6a1a4] hover:bg-white/[0.05] hover:text-[#d7d2d5]",
                      )}
                      href={toSafetyHref(item.path)}
                    >
                      {item.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function OnThisPage({ markdown }: Readonly<{ markdown: string }>) {
  const headings = extractHeadings(markdown);

  if (headings.length === 0) {
    return <div className="hidden w-[220px] xl:ml-[29px] xl:block" />;
  }

  return (
    <aside className="hidden w-[220px] xl:ml-[29px] xl:block">
      <nav className="sticky top-36 pt-2">
        <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold leading-6 text-[#d7d2d5]">
          <Menu className="h-3.5 w-3.5" />
          On this page
        </h2>
        <ul className="space-y-3">
          {headings.map((heading, index) => (
            <li key={heading.id}>
              <a
                className={cn(
                  "text-[14px] font-semibold leading-5 transition-colors hover:text-[#e6e1e4]",
                  index === 0 ? "text-[#f17bb6]" : "text-[#777276]",
                )}
                href={`#${heading.id}`}
              >
                {heading.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}

function SafetyFooter() {
  return (
    <footer className="border-t border-white/[0.07] bg-[#0d0d0d] font-safety-docs">
      <div className="mx-auto max-w-[920px] px-5 py-20 text-[#777276]">
        <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <Link href="/">
            <Image
              alt="ourdream Trust & Safety home page"
              className="h-6 w-auto"
              height={15}
              src="/images/ourdream/safety/logo-dark.svg"
              width={130}
            />
          </Link>
          <div className="flex flex-wrap gap-7 text-[14px] font-medium">
            <a className="transition-colors hover:text-white" href="mailto:trust@ourdream.ai">
              trust@ourdream.ai
            </a>
            <Link className="transition-colors hover:text-white" href="/">
              ourdream.ai
            </Link>
          </div>
          <Link
            aria-label="website"
            className="text-[#777276] transition-colors hover:text-white"
            href="/"
          >
            <Monitor className="h-5 w-5" />
          </Link>
        </div>
        <div className="mt-16 border-t border-white/[0.07] pt-10">
          <div className="flex items-center justify-between">
            <p className="text-[13px] font-semibold">
              Powered by <span className="text-[#a6a1a4]">mintlify</span>
            </p>
            <div className="flex items-center gap-5">
              <Monitor className="h-4 w-4" />
              <Sun className="h-4 w-4" />
              <Moon className="h-4 w-4" />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

function SafetyNextLink({ path }: Readonly<{ path: string }>) {
  const next = getNextSafetyDocument(path);

  if (!next) return null;

  return (
    <div className="mt-16 flex justify-end">
      <Link
        className="inline-flex items-center gap-2 text-[14px] font-semibold text-[#d7d2d5] transition-colors hover:text-white"
        href={toSafetyHref(next.path)}
      >
        {next.title}
        <ChevronRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

export function SafetyCenterPage({ route }: Readonly<{ route: OurdreamRoute }>) {
  const document = getSafetyDocumentForRoute(route.path);
  const activePath = document.path;

  return (
    <main className="min-h-screen bg-[#0d0d0d] font-safety-docs text-[#a6a1a4]">
      <SafetyHeader />
      <div className="mx-auto grid w-full max-w-[1440px] grid-cols-1 px-5 pt-40 lg:grid-cols-[288px_689px] lg:gap-x-[43px] lg:px-8 lg:pt-9 xl:grid-cols-[288px_689px_220px]">
        <SafetySidebar activePath={activePath} />
        <article className="min-w-0">
          <div className="mt-0.5 space-y-2.5">
            <p className="text-[14px] font-semibold leading-6 text-[#f17bb6]">
              {route.eyebrow ?? "Overview"}
            </p>
            <h1 className="max-w-full text-[24px] font-bold leading-8 tracking-[-0.6px] text-[#e6e1e4] sm:text-[30px] sm:leading-9 sm:tracking-[-0.75px]">
              {document.title}
            </h1>
          </div>
          <p className="mt-2 text-[18px] leading-7 text-[#a6a1a4]">
            {document.description}
          </p>
          <SafetyMarkdown markdown={document.markdown} />
          <p className="mt-16 text-[13px] leading-5 text-[#777276]">
            Last modified on June 10, 2026
          </p>
          <SafetyNextLink path={document.path} />
        </article>
        <OnThisPage markdown={document.markdown} />
      </div>
      <SafetyFooter />
    </main>
  );
}
