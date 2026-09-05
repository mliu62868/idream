"use client";

import { useAdminI18n } from "./i18n";

const inputClass = "mt-1 min-h-10 w-full rounded-md border border-[var(--ad-border)] bg-[var(--ad-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--ad-ink)]";

type Article = Record<string, unknown> & {
  heading?: string;
  intro?: string;
  sections?: Array<Record<string, unknown> & { heading?: string; paragraphs?: string[] }>;
  cta?: Record<string, unknown> & { label?: string; href?: string };
};

// Keep JSON as the single draft: switching editors never drops optional or advanced fields.
function editableArticle(json: string): Article | null {
  try {
    const body: unknown = JSON.parse(json);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const article = body as Article;
    if (article.heading !== undefined && typeof article.heading !== "string") return null;
    if (article.intro !== undefined && typeof article.intro !== "string") return null;
    if (article.sections !== undefined && (!Array.isArray(article.sections) || !article.sections.every((section) => section && typeof section === "object" && !Array.isArray(section) && (section.heading === undefined || typeof section.heading === "string") && (section.paragraphs === undefined || (Array.isArray(section.paragraphs) && section.paragraphs.every((text) => typeof text === "string")))))) return null;
    if (article.cta !== undefined && (!article.cta || typeof article.cta !== "object" || Array.isArray(article.cta) || (article.cta.label !== undefined && typeof article.cta.label !== "string") || (article.cta.href !== undefined && typeof article.cta.href !== "string"))) return null;
    return article;
  } catch { return null; }
}

export function CmsArticleEditor({ bodyJson, onChange, readOnly = false }: { bodyJson: string; onChange: (value: string) => void; readOnly?: boolean }) {
  const { t } = useAdminI18n();
  const article = editableArticle(bodyJson);
  const sections = article?.sections ?? [];
  const update = (patch: Partial<Article>) => onChange(JSON.stringify({ ...article, ...patch }, null, 2));
  return <div className="space-y-4 md:col-span-2">
    {article ? <fieldset className="space-y-4" disabled={readOnly}>
      <legend className="text-sm font-semibold">{t("Article content")}</legend>
      <label className="block text-sm">{t("Article heading")}<input className={inputClass} maxLength={160} value={article.heading ?? ""} onChange={(event) => update({ heading: event.target.value })} /></label>
      <label className="block text-sm">{t("Introduction")}<textarea className={`${inputClass} min-h-24`} maxLength={2000} value={article.intro ?? ""} onChange={(event) => update({ intro: event.target.value })} /></label>
      <p className="text-xs text-[var(--ad-text-muted)]">{t("For publication: an introduction of at least 60 characters, two sections, and paragraphs of at least 40 characters. Drafts can be incomplete.")}</p>
      {sections.map((section, index) => <div className="space-y-3 border-t border-[var(--ad-border)] pt-4" key={index}>
        <label className="block text-sm">{t("Section heading")} {index + 1}<input className={inputClass} maxLength={160} value={section.heading ?? ""} onChange={(event) => update({ sections: sections.map((item, i) => i === index ? { ...item, heading: event.target.value } : item) })} /></label>
        <label className="block text-sm">{t("Section paragraphs")} {index + 1}<textarea className={`${inputClass} min-h-32`} value={(section.paragraphs ?? []).join("\n\n")} onChange={(event) => update({ sections: sections.map((item, i) => i === index ? { ...item, paragraphs: event.target.value.split(/\n\s*\n/) } : item) })} /></label>
        <p className="text-xs text-[var(--ad-text-muted)]">{t("Separate paragraphs with a blank line.")}</p>
        {!readOnly ? <button className="min-h-9 text-sm text-[var(--ad-red-text)]" type="button" onClick={() => update({ sections: sections.filter((_, i) => i !== index) })}>{t("Remove section")} {index + 1}</button> : null}
      </div>)}
      {!readOnly ? <button className="min-h-10 rounded-md border border-[var(--ad-border)] px-3 text-sm disabled:opacity-50" disabled={sections.length >= 30} type="button" onClick={() => update({ sections: [...sections, { heading: "", paragraphs: [""] }] })}>{t("Add section")}</button> : null}
      <details className="border-t border-[var(--ad-border)] pt-3">
        <summary className="cursor-pointer text-sm">{t("Call to action (optional)")}</summary>
        <label className="mt-3 block text-sm">{t("Button label")}<input className={inputClass} maxLength={80} value={article.cta?.label ?? ""} onChange={(event) => update({ cta: { ...article.cta, label: event.target.value, href: article.cta?.href ?? "" } })} /></label>
        <label className="mt-3 block text-sm">{t("Button destination")}<input className={inputClass} value={article.cta?.href ?? ""} onChange={(event) => update({ cta: { ...article.cta, label: article.cta?.label ?? "", href: event.target.value } })} /></label>
        {article.cta && !readOnly ? <button className="mt-2 min-h-9 text-sm text-[var(--ad-red-text)]" type="button" onClick={() => { const body = { ...article }; delete body.cta; onChange(JSON.stringify(body, null, 2)); }}>{t("Remove call to action")}</button> : null}
      </details>
    </fieldset> : <p className="text-sm text-[var(--ad-yellow-text)]" role="status">{t("The JSON does not match article fields. Correct it in the advanced editor to continue using fields.")}</p>}
    <details open={!article}>
      <summary className="cursor-pointer text-sm font-semibold">{t("Advanced JSON editor")}</summary>
      <textarea aria-label={t("CMS article body JSON")} className={`${inputClass} min-h-44 font-mono text-xs`} readOnly={readOnly} value={bodyJson} onChange={(event) => onChange(event.target.value)} />
    </details>
  </div>;
}
