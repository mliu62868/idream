// SPEC: 渲染 DB 驱动的 CMS 页（ADMIN_PHASE3_DESIGN §3.2）。body 形如
//   { heading?, intro?, sections?: [{heading?, paragraphs?: string[]}], cta?: {label?, href?} }
// INTENT: 简单、干净的可读版式（与富静态页解耦）；脏 body 安全降级为标题页。
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { PublishedRoutePage } from "@/server/cms/published-route";
import type { OurdreamRoute } from "@/types/ourdream";
import { RouteShell } from "./OurdreamRoutePage";

type CmsSection = { heading?: string; paragraphs?: string[] };
type CmsBody = {
  heading?: string;
  intro?: string;
  sections?: CmsSection[];
  cta?: { label?: string; href?: string };
};

function asBody(value: unknown): CmsBody {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as CmsBody) : {};
}

function safeCtaHref(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

export function CmsRenderer({ page }: Readonly<{ page: PublishedRoutePage }>) {
  const body = asBody(page.body);
  const sections = Array.isArray(body.sections) ? body.sections : [];
  const ctaHref = safeCtaHref(body.cta?.href);
  const route: OurdreamRoute = {
    path: page.path,
    title: page.title,
    description: page.description,
    template: "article",
  };
  const ctaContent = (
    <>
      {body.cta?.label ?? "Get started"}
      <ArrowRight aria-hidden="true" className="h-4 w-4" />
    </>
  );

  return (
    <RouteShell route={route}>
      <article className="px-4 py-10 md:px-[60px] md:py-14">
        <div className="mx-auto max-w-3xl">
          <p className="text-[12px] font-black uppercase leading-4 text-[rgb(253,95,194)]">
            Ourdream guide
          </p>
          <h1 className="mt-3 text-[40px] font-black uppercase leading-none tracking-normal text-white md:text-[60px]">
            {body.heading ?? page.title}
          </h1>
          {page.description ? (
            <p className="mt-5 text-[16px] font-medium leading-8 text-[rgb(170,170,170)]">
              {page.description}
            </p>
          ) : null}
          {body.intro ? (
            <p className="mt-6 text-[15px] font-medium leading-8 text-white/85">
              {body.intro}
            </p>
          ) : null}
          {sections.map((section, index) => (
            <section
              className="mt-10 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-6"
              key={index}
            >
              {section.heading ? (
                <h2 className="text-[26px] font-black uppercase leading-8 text-white">
                  {section.heading}
                </h2>
              ) : null}
              {(Array.isArray(section.paragraphs) ? section.paragraphs : []).map(
                (paragraph, pIndex) => (
                  <p
                    className="mt-4 text-[15px] font-medium leading-8 text-[rgb(170,170,170)]"
                    key={pIndex}
                  >
                    {paragraph}
                  </p>
                ),
              )}
            </section>
          ))}
          {ctaHref ? (
            ctaHref.startsWith("/") ? (
              <Link
                className="mt-10 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
                href={ctaHref}
              >
                {ctaContent}
              </Link>
            ) : (
              <a
                className="mt-10 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
                data-link-kind="external"
                href={ctaHref}
                rel="noopener noreferrer"
                target="_blank"
              >
                {ctaContent}
              </a>
            )
          ) : null}
        </div>
      </article>
    </RouteShell>
  );
}
