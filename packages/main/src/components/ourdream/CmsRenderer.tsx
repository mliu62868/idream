// SPEC: 渲染 DB 驱动的 CMS 页（ADMIN_PHASE3_DESIGN §3.2）。body 形如
//   { heading?, intro?, sections?: [{heading?, paragraphs?: string[]}], cta?: {label?, href?} }
// INTENT: 简单、干净的可读版式（与富静态页解耦）；脏 body 安全降级为标题页。
import type { PublishedRoutePage } from "@/server/cms/published-route";

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

export function CmsRenderer({ page }: Readonly<{ page: PublishedRoutePage }>) {
  const body = asBody(page.body);
  const sections = Array.isArray(body.sections) ? body.sections : [];
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-4xl font-bold tracking-tight">{body.heading ?? page.title}</h1>
      {page.description ? (
        <p className="mt-4 text-lg text-[rgb(120,120,120)]">{page.description}</p>
      ) : null}
      {body.intro ? <p className="mt-6 leading-relaxed">{body.intro}</p> : null}
      {sections.map((section, index) => (
        <section key={index} className="mt-10">
          {section.heading ? (
            <h2 className="text-2xl font-semibold tracking-tight">{section.heading}</h2>
          ) : null}
          {(Array.isArray(section.paragraphs) ? section.paragraphs : []).map((paragraph, pIndex) => (
            <p key={pIndex} className="mt-3 leading-relaxed text-[rgb(60,60,60)]">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
      {body.cta?.href ? (
        <a
          className="mt-10 inline-block rounded-md bg-black px-5 py-3 font-medium text-white"
          href={body.cta.href}
        >
          {body.cta.label ?? "Get started"}
        </a>
      ) : null}
    </main>
  );
}
