import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildCmsFamilyDirectory } from "@/lib/resource-library";
import { editorialContent } from "@/server/cms/editorial-content";
import { validateCmsPublication } from "@/server/cms/route-page-contract";
import { CmsRenderer } from "./CmsRenderer";
vi.mock("./OurdreamRoutePage", () => ({ RouteShell: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));

describe("CMS actual article and directory rendering", () => {
  it("renders independent text, working section anchors and published detail links", () => {
    const source = editorialContent.find(page => page.path === "/images")!;
    const page = { ...validateCmsPublication({ ...source, template: "article", canonical: source.path, indexingStatus: "index" }), publishedAt: new Date(), updatedAt: new Date() };
    const directory = buildCmsFamilyDirectory("/images", editorialContent.map(row => ({ ...row, canonical: row.path, indexingStatus: "index" as const })));
    const html = renderToStaticMarkup(createElement(CmsRenderer, { page, directory }));
    expect(html).toContain('href="/images/edit-a-source"'); expect(html).toContain('href="/images/character-identity"'); expect(html).toContain('action="/images"'); expect(html).toContain('href="#section-1"'); expect(html).toContain('id="section-1"'); expect(html).toContain("Start with a recognizable character");
    expect(html).not.toContain("lizzie-od"); expect(html).not.toContain("/videos/ai-anime-porn");
  });
  it("keeps an empty search explicit while leaving the genuine index article readable", () => {
    const source = editorialContent.find(page => page.path === "/glossary")!;
    const page = { ...validateCmsPublication({ ...source, template: "article", canonical: source.path, indexingStatus: "index" }), publishedAt: new Date(), updatedAt: new Date() };
    const html = renderToStaticMarkup(createElement(CmsRenderer, { page, directory: buildCmsFamilyDirectory("/glossary", [], { q: "missing" }) }));
    expect(html).toContain("No published pages match this search."); expect(html).toContain("Inputs are different from results"); expect(html).toContain('href="/glossary"');
  });
});
