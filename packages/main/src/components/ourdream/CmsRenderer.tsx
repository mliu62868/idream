// SPEC: Render only versioned, validated CMS articles.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { PublishedRoutePage } from "@/server/cms/published-route";
import type { OurdreamRoute } from "@/types/ourdream";
import { RouteShell } from "./OurdreamRoutePage";

export function CmsRenderer({ page }: Readonly<{ page: PublishedRoutePage }>) {
  const body = page.body;
  const route: OurdreamRoute = {
    path: page.path,
    title: page.title,
    description: page.description,
    template: page.template,
  };
  const ctaContent = (
    <>
      {body.cta?.label}
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
            {body.heading}
          </h1>
          <p className="mt-5 text-[16px] font-medium leading-8 text-[rgb(170,170,170)]">
            {page.description}
          </p>
          <p className="mt-6 text-[15px] font-medium leading-8 text-white/85">
            {body.intro}
          </p>
          {body.sections.map((section) => (
            <section
              className="mt-10 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-6"
              key={section.heading}
            >
              <h2 className="text-[26px] font-black uppercase leading-8 text-white">
                {section.heading}
              </h2>
              {section.paragraphs.map(
                (paragraph) => (
                  <p
                    className="mt-4 text-[15px] font-medium leading-8 text-[rgb(170,170,170)]"
                    key={paragraph}
                  >
                    {paragraph}
                  </p>
                ),
              )}
            </section>
          ))}
          {body.cta ? (
            body.cta.href.startsWith("/") ? (
              <Link
                className="mt-10 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
                href={body.cta.href}
              >
                {ctaContent}
              </Link>
            ) : (
              <a
                className="mt-10 inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
                data-link-kind="external"
                href={body.cta.href}
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
