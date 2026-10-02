// SPEC: Render only versioned, validated CMS articles.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { PublishedRoutePage } from "@/server/cms/published-route";
import type { OurdreamRoute } from "@/types/ourdream";
import type { buildCmsFamilyDirectory } from "@/lib/resource-library";
import { RouteShell } from "./OurdreamRoutePage";

export function CmsRenderer({ page, directory, label = "iDream guide" }: Readonly<{ page: PublishedRoutePage; directory?: ReturnType<typeof buildCmsFamilyDirectory>; label?: string }>) {
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
            {label}
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
          {directory ? <section className="mt-8 space-y-4" aria-label="Published directory">
            <form action={page.path} method="get" className="flex flex-wrap gap-2 text-sm">
              <input aria-label="Search published pages" name="q" maxLength={200} defaultValue={directory.search} placeholder="Search this directory" className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-white" />
              <button className="rounded-full bg-white px-4 py-2 font-bold text-black" type="submit">Search</button>
              {directory.search ? <Link className="px-3 py-2 underline" href={page.path}>Clear search</Link> : null}
            </form>
            {directory.items.length ? <div className="grid gap-3 sm:grid-cols-2">{directory.items.map(item => <Link key={item.path} href={item.path} className="rounded-xl border border-white/10 bg-white/5 p-4">
              <h2 className="font-bold text-white">{item.title}</h2><p className="mt-2 text-sm leading-6 text-white/65">{item.description}</p><span className="mt-3 block text-sm font-semibold">Read more →</span>
            </Link>)}</div> : <p className="text-sm text-white/60">{directory.search ? "No published pages match this search." : "No detail pages have been published yet."}</p>}
            {directory.pageCount > 1 ? <nav aria-label="Directory pages" className="flex items-center justify-between gap-3 text-sm">
              {directory.page > 1 ? <Link className="underline" href={`${page.path}?${new URLSearchParams({ ...(directory.search ? { q: directory.search } : {}), page: String(directory.page - 1) })}`}>Previous</Link> : <span />}
              <span>Page {directory.page} of {directory.pageCount}</span>
              {directory.page < directory.pageCount ? <Link className="underline" href={`${page.path}?${new URLSearchParams({ ...(directory.search ? { q: directory.search } : {}), page: String(directory.page + 1) })}`}>Next</Link> : <span />}
            </nav> : null}
          </section> : null}
          <nav className="mt-8 flex flex-wrap gap-3 text-sm text-white/75" aria-label="On this page">{body.sections.map((section, index) => <a className="underline" key={section.heading} href={`#section-${index + 1}`}>{section.heading}</a>)}</nav>
          {body.sections.map((section, index) => (
            <section
              className="mt-10 rounded-[16px] border border-white/10 bg-[rgb(18,18,18)] p-6"
              key={section.heading}
              id={`section-${index + 1}`}
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
