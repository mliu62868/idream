// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CmsView } from "./CmsView";
import { CmsArticleEditor } from "./CmsArticleEditor";
import { AdminI18nProvider } from "./i18n";
import { AdminV2RequestError } from "./api";

const { apiGet, apiWrite } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), apiGet, apiWrite }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const page = { path: "/guides/example", template: "article", title: "Reading guide", description: "A useful description", canonical: null, contentStatus: "draft", contentSchemaVersion: 1, indexingStatus: "noindex", publishedAt: null, updatedAt: "2026-09-05T00:00:00.000Z", editable: true, publishability: "ready", issues: [] };
const article = { heading: "Original heading", intro: "Introduction text", sections: [{ heading: "First", paragraphs: ["Paragraph one", "Paragraph two"] }], cta: { label: "Explore", href: "/explore" } };
function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); }

describe("CMS operating permissions and article fields", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    apiGet.mockReset().mockImplementation(async (path: string) => path.includes("cms/page?") ? { page: { ...page, body: article } } : { items: [page] });
    apiWrite.mockReset().mockResolvedValue({});
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
  const field = (label: string) => [...container.querySelectorAll("label")].find((node) => node.firstChild?.textContent === label)!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;

  it("lets a reader inspect article content without offering write operations", async () => {
    await act(async () => root.render(<CmsView canWrite={false} />)); await settle();
    expect(container.textContent).toContain("You can browse CMS pages");
    expect(button("Create draft")).toBeUndefined(); expect(button("Edit")).toBeUndefined(); expect(button("Publish")).toBeUndefined();
    await act(async () => button("View page").click());
    expect(field("Article heading").value).toBe("Original heading");
    expect(container.querySelector("fieldset")?.disabled).toBe(true);
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("gives a reader an honest empty state without creation instructions", async () => {
    apiGet.mockResolvedValueOnce({ items: [] });
    await act(async () => root.render(<CmsView canWrite={false} />)); await settle();
    expect(container.textContent).toContain("No pages have been created yet. Refresh later to check for updates.");
    expect(container.textContent).not.toContain("Create a draft above");
    expect(button("Create draft")).toBeUndefined();
  });

  it.each(["en", "zh"] as const)("explains publication fields and length requirements in %s with raw errors collapsed", async (locale) => {
    apiGet.mockResolvedValueOnce({ items: [{ ...page, publishability: "blocked", issues: [
      { code: "too_small", path: "description", message: "Too small: expected string to have >=1 characters" },
      { code: "too_small", path: "description", message: "Too small: expected string to have >=50 characters" },
      { code: "too_small", path: "body.intro", message: "Too small: expected string to have >=60 characters" },
      { code: "too_small", path: "body.sections", message: "Too small: expected array to have >=2 items" },
      { code: "too_small", path: "body.sections.0.paragraphs.0", message: "Too small: expected string to have >=40 characters" },
    ] }] });
    await act(async () => root.render(<AdminI18nProvider locale={locale}><CmsView canWrite /></AdminI18nProvider>)); await settle();
    const details = [...container.querySelectorAll("details")].find((node) => node.textContent?.includes("Too small:"))!;
    expect(details.open).toBe(false);
    const requirements = details.parentElement?.querySelector("ul")?.textContent;
    expect(requirements).toContain(locale === "zh" ? "Meta 描述至少需要 50 个字符。" : "Meta description needs at least 50 characters.");
    expect(requirements).toContain(locale === "zh" ? "引言至少需要 60 个字符。" : "Introduction needs at least 60 characters.");
    expect(requirements).toContain(locale === "zh" ? "文章章节至少需要 2 项。" : "Article sections: at least 2 items.");
    expect(requirements).toContain(locale === "zh" ? "第 1 节第 1 段至少需要 40 个字符。" : "Section 1, paragraph 1 needs at least 40 characters.");
    expect(requirements).not.toContain("Too small:");
    expect(requirements).not.toContain("1 characters");
    expect(details.textContent).toContain("description: Too small:");
  });

  it("edits article fields and JSON without losing optional content", async () => {
    function Editor() { const [json, setJson] = useState(JSON.stringify(article)); return <CmsArticleEditor bodyJson={json} onChange={setJson} />; }
    await act(async () => root.render(<Editor />));
    const jsonField = () => container.querySelector<HTMLTextAreaElement>('[aria-label="CMS article body JSON"]')!;
    expect(jsonField().closest("details")?.open).toBe(false);
    await act(async () => input(field("Article heading"), "Changed heading"));
    expect(JSON.parse(jsonField().value)).toEqual({ ...article, heading: "Changed heading" });
    await act(async () => button("Add section").click());
    expect(JSON.parse(jsonField().value).sections).toHaveLength(2);
    await act(async () => input(jsonField(), JSON.stringify({ ...article, heading: "From JSON" })));
    expect(field("Article heading").value).toBe("From JSON");
    await act(async () => input(jsonField(), "{broken"));
    expect(container.textContent).toContain("The JSON does not match article fields");
    expect(jsonField().value).toBe("{broken");
    expect(jsonField().closest("details")?.open).toBe(true);
  });

  it("creates a draft from fields and presents a permission failure in Chinese", async () => {
    apiWrite.mockRejectedValue(new AdminV2RequestError("Missing admin permission", 403, "forbidden"));
    await act(async () => root.render(<AdminI18nProvider locale="zh"><CmsView canWrite /></AdminI18nProvider>)); await settle();
    await act(async () => {
      input(container.querySelector<HTMLInputElement>('[placeholder="/guides/example"]')!, "/guides/test");
      input(container.querySelector<HTMLInputElement>('[placeholder="页面标题"]')!, "页面标题");
      input(container.querySelector<HTMLInputElement>('[placeholder="原因（≥3 字符）"]')!, "创建文章草稿");
      input(container.querySelector<HTMLInputElement>('[aria-label="CMS 页面确认文本"]')!, "/guides/test");
      input(field("文章标题"), "文章正文标题");
    });
    await act(async () => button("创建草稿").click());
    expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/cms/pages", "POST", expect.objectContaining({ body: { heading: "文章正文标题", intro: "", sections: [] } }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("权限");
    expect(container.querySelector('[role="alert"] details')?.textContent).toContain("Missing admin permission");
  });
});
