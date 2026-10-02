// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CmsView } from "./CmsView";
import { CmsArticleEditor } from "./CmsArticleEditor";
import { AdminI18nProvider } from "./i18n";
import { AdminV2RequestError } from "./api";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

const { apiGet, apiWrite } = vi.hoisted(() => ({ apiGet: vi.fn(), apiWrite: vi.fn() }));
vi.mock("./api", async (original) => ({ ...await original<typeof import("./api")>(), apiGet, apiWrite }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const page = { path: "/guides/example", template: "article", title: "Reading guide", description: "A useful description", canonical: null, contentStatus: "draft", contentSchemaVersion: 1, indexingStatus: "noindex", publishedAt: null, updatedAt: "2026-09-05T00:00:00.000Z", editable: true, publishability: "ready", issues: [] };
const pageInfo = { endCursor: null, hasNextPage: false, startCursor: null, hasPreviousPage: false };
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
    window.history.replaceState(null, "", "/admin/growth/content?view=cms");
    apiGet.mockReset().mockImplementation(async (path: string) => path.includes("cms/page?") ? { page: { ...page, body: article } } : { items: [page], pageInfo });
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
    apiGet.mockResolvedValueOnce({ items: [], pageInfo });
    await act(async () => root.render(<CmsView canWrite={false} />)); await settle();
    expect(container.textContent).toContain("No pages have been created yet. Refresh later to check for updates.");
    expect(container.textContent).not.toContain("Create a draft above");
    expect(button("Create draft")).toBeUndefined();
  });

  it("recovers a committed publication's cache without unpublishing the page", async () => {
    let current: typeof page | (Omit<typeof page, "publishedAt"> & { publishedAt: string }) = { ...page };
    apiGet.mockImplementation(async () => ({ items: [current], pageInfo }));
    apiWrite.mockImplementation(async (_path: string, _method: string, body: Record<string, unknown>) => {
      if (body.action !== "revalidate") {
        current = { ...page, contentStatus: "published", editable: false, publishedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
        return { page: current, cacheRevalidated: false };
      }
      return { page: current, cacheRevalidated: true };
    });
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Publish").click());
    await act(async () => {
      input(container.querySelector<HTMLInputElement>('[aria-label="CMS publish reason"]')!, "publish article");
      input(container.querySelector<HTMLInputElement>('[aria-label="CMS publish confirmation"]')!, page.path);
    });
    await act(async () => button("Confirm publish change").click()); await settle();
    expect(container.textContent).toContain("cache did not refresh");
    expect(button("Refresh public cache")).toBeDefined();
    expect(button("Unpublish")).toBeDefined();
    await act(async () => button("Refresh public cache").click());
    await act(async () => {
      input(container.querySelector<HTMLInputElement>('[aria-label="CMS publish reason"]')!, "recover public cache");
      input(container.querySelector<HTMLInputElement>('[aria-label="CMS publish confirmation"]')!, page.path);
    });
    const confirm = [...container.querySelectorAll("button")].find((node) => node.textContent === "Confirm cache refresh")!;
    await act(async () => confirm.click()); await settle();
    expect(apiWrite).toHaveBeenLastCalledWith("/api/v2/admin/cms/pages/publish", "POST", expect.objectContaining({
      action: "revalidate", contentStatus: "published", expectedUpdatedAt: current.updatedAt,
      path: page.path, reason: "recover public cache", confirmation: page.path,
    }));
    expect(button("Unpublish")).toBeDefined();
    expect(apiWrite).toHaveBeenCalledTimes(2);
  });

  it.each(["en", "zh"] as const)("explains publication fields and length requirements in %s with raw errors collapsed", async (locale) => {
    apiGet.mockResolvedValueOnce({ items: [{ ...page, publishability: "blocked", issues: [
      { code: "too_small", path: "description", message: "Too small: expected string to have >=1 characters" },
      { code: "too_small", path: "description", message: "Too small: expected string to have >=50 characters" },
      { code: "too_small", path: "body.intro", message: "Too small: expected string to have >=60 characters" },
      { code: "too_small", path: "body.sections", message: "Too small: expected array to have >=2 items" },
      { code: "too_small", path: "body.sections.0.paragraphs.0", message: "Too small: expected string to have >=40 characters" },
    ] }], pageInfo });
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

  it("restores filters and the current cursor, and reads the preceding page without losing the CMS subview", async () => {
    window.history.replaceState(null, "", "/admin/growth/content?view=cms&cmsSearch=guides&cmsStatus=draft&cmsCursor=first-page-end&page=2");
    apiGet.mockImplementation(async (path: string) => {
      const second = new URL(path, window.location.origin).searchParams.has("cursor");
      return { items: [{ ...page, title: second ? "Older guide" : "Newest guide" }], pageInfo: second
        ? { ...pageInfo, startCursor: "second-page-start", hasPreviousPage: true }
        : { ...pageInfo, endCursor: "first-page-end", hasNextPage: true } };
    });
    await act(async () => root.render(<CmsView />)); await settle();
    expect(new URL(apiGet.mock.calls.at(-1)![0], window.location.origin).searchParams).toEqual(new URLSearchParams("limit=25&q=guides&status=draft&cursor=first-page-end"));
    expect(container.textContent).toContain("Older guide");
    expect(button("Previous page").disabled).toBe(false);
    await act(async () => button("Previous page").click()); await settle();
    expect(container.textContent).toContain("Newest guide");
    expect(new URL(apiGet.mock.calls.at(-1)![0], window.location.origin).searchParams.get("before")).toBe("second-page-start");
    expect(window.location.search).toContain("view=cms");
    expect(window.location.search).not.toContain("cmsCursor=");
    expect(button("Previous page").disabled).toBe(true);
    await act(async () => button("Next page").click()); await settle();
    expect(container.textContent).toContain("Older guide");
    expect(window.location.search).toContain("cmsCursor=first-page-end");
    expect(window.location.search).not.toContain("cmsBefore=");
  });

  it("searches the authority and clears both pagination anchors when filters are applied", async () => {
    window.history.replaceState(null, "", "/admin/growth/content?view=cms&cmsCursor=old-page&page=5");
    await act(async () => root.render(<CmsView />)); await settle();
    await act(async () => input(container.querySelector<HTMLInputElement>('[aria-label="Search paths or titles"]')!, " companion "));
    await act(async () => button("Filters").click());
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('[aria-label="CMS status"]')!;
      select.value = "published";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Apply").click()); await settle();
    const params = new URL(apiGet.mock.calls.at(-1)![0], window.location.origin).searchParams;
    expect(params.get("q")).toBe("companion");
    expect(params.get("status")).toBe("published");
    expect(params.has("cursor")).toBe(false);
    expect(params.has("before")).toBe(false);
    expect(window.location.search).toContain("view=cms");
    expect(window.location.search).not.toContain("page=");
  });

  it("refreshes the current cursor from the shell and prevents the older request from replacing rows or page cursors", async () => {
    window.history.replaceState(null, "", "/admin/growth/content?view=cms&cmsSearch=guides&cmsCursor=current-page&page=2");
    let resolveOld!: (value: unknown) => void;
    apiGet.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ items: [{ ...page, title: "Fresh guide" }], pageInfo });
    await act(async () => root.render(<CmsView />)); await settle();
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))); await settle();
    expect(apiGet).toHaveBeenCalledTimes(2);
    expect(apiGet.mock.calls[1][0]).toBe(apiGet.mock.calls[0][0]);
    expect(new URL(apiGet.mock.calls[1][0], window.location.origin).searchParams.get("cursor")).toBe("current-page");
    expect(container.textContent).toContain("Fresh guide");
    await act(async () => resolveOld({ items: [{ ...page, title: "Stale guide" }], pageInfo: { ...pageInfo, endCursor: "stale-next", hasNextPage: true } }));
    expect(container.textContent).not.toContain("Stale guide");
    expect(button("Next page").disabled).toBe(true);
  });

  it("labels a retained snapshot after a failed shell refresh and retries the same page", async () => {
    await act(async () => root.render(<CmsView />)); await settle();
    apiGet.mockRejectedValueOnce(new Error("CMS backend unavailable"));
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))); await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Showing the last successful snapshot");
    expect(container.textContent).toContain("Reading guide");
    await act(async () => button("Retry").click()); await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(apiGet.mock.calls.at(-1)![0]).toBe(apiGet.mock.calls[0][0]);
  });

  it("finishes the in-flight page read when the operator switches language", async () => {
    let resolveRead!: (value: unknown) => void;
    apiGet.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    await act(async () => root.render(<AdminI18nProvider locale="en"><CmsView /></AdminI18nProvider>)); await settle();
    await act(async () => root.render(<AdminI18nProvider locale="zh"><CmsView /></AdminI18nProvider>));
    await act(async () => resolveRead({ items: [page], pageInfo }));
    expect(container.textContent).toContain("Reading guide");
    expect(container.textContent).toContain("CMS 页面");
    expect(apiGet).toHaveBeenCalledTimes(1);
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

  it("freezes an in-flight draft save without letting cancel or another page clear the current input", async () => {
    const otherPage = { ...page, path: "/guides/another", title: "Another guide" };
    apiGet.mockImplementation(async (path: string) => path.includes("cms/page?")
      ? { page: { ...(path.includes(encodeURIComponent(otherPage.path)) ? otherPage : page), body: article } }
      : { items: [page, otherPage], pageInfo });
    let finishWrite!: (value: unknown) => void;
    apiWrite.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Edit").click());
    const editor = () => [...container.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent?.includes("Edit CMS draft"))!;
    const title = editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!;
    await act(async () => {
      input(title, "My pending article title");
      input(editor().querySelector<HTMLInputElement>('[placeholder="Reason (≥3)"]')!, "Update article copy");
      input(editor().querySelector<HTMLInputElement>('[aria-label="CMS edit confirmation"]')!, page.path);
    });
    await act(async () => button("Save draft").click());
    expect(apiWrite).toHaveBeenCalledTimes(1);
    expect(button("Cancel").disabled).toBe(true);
    // happy-dom's :disabled selector misses disabled fieldset inheritance.
    expect(title.closest("fieldset")?.disabled).toBe(true);
    expect(editor().querySelector<HTMLTextAreaElement>('[aria-label="CMS article body JSON"]')!.closest("fieldset")?.disabled).toBe(true);
    const editTargets = [...container.querySelectorAll("button")].filter(node => node.textContent === "Edit");
    expect(editTargets.every(node => node.disabled)).toBe(true);
    expect([...container.querySelectorAll("button")].filter(node => node.textContent === "Publish" || node.textContent === "Refresh public cache").every(node => node.disabled)).toBe(true);
    await act(async () => { button("Cancel").click(); editTargets[1].click(); });
    expect(title.value).toBe("My pending article title");
    expect(editor().textContent).toContain(page.path);
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))); await settle();
    expect(title.value).toBe("My pending article title");
    expect(editor().textContent).toContain(page.path);
    await act(async () => finishWrite({})); await settle();
    expect(editor()).toBeUndefined();
    expect(container.textContent).toContain(`Draft saved for ${page.path}`);
    expect(apiWrite).toHaveBeenCalledTimes(1);
    expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/cms/pages", "PATCH", expect.objectContaining({ path: page.path, title: "My pending article title" }));
  });

  it("protects changed CMS input before switching to publication or another editing target", async () => {
    const otherPage = { ...page, path: "/guides/another", title: "Another guide" };
    apiGet.mockImplementation(async (path: string) => path.includes("cms/page?")
      ? { page: { ...(path.includes(encodeURIComponent(otherPage.path)) ? otherPage : page), body: article } }
      : { items: [page, otherPage], pageInfo });
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Edit").click());
    const editor = () => [...container.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent?.includes("Edit CMS draft"))!;
    await act(async () => input(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!, "My unsaved CMS title"));
    await act(async () => button("Publish").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    expect(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!.value).toBe("My unsaved CMS title");
    const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === label)!;
    await act(async () => dialogButton("Cancel").click());
    expect(container.querySelector('[aria-label="CMS publish reason"]')).toBeNull();
    const editTargets = [...container.querySelectorAll("button")].filter(node => node.textContent === "Edit");
    await act(async () => editTargets[1].click());
    expect(editor().textContent).toContain(page.path);
    expect(apiGet.mock.calls.filter(([path]) => path.includes("cms/page?")).length).toBe(1);
    await act(async () => dialogButton("Discard changes").click());
    expect(editor().textContent).toContain(otherPage.path);
    expect(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!.value).toBe(otherPage.title);
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("only guards changed drafts, preserves them through refresh and permits explicit cancellation", async () => {
    const link = document.createElement("a"); link.href = "/admin/ops/recipes"; document.body.append(link);
    const navigate = vi.fn((event: MouseEvent) => event.preventDefault()); link.addEventListener("click", navigate);
    try {
      await act(async () => root.render(<CmsView canWrite />)); await settle();
      await act(async () => button("Edit").click());
      await act(async () => link.click());
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const title = () => [...container.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent?.includes("Edit CMS draft"))!.querySelector<HTMLInputElement>('[placeholder="Page title"]')!;
      await act(async () => input(title(), "My unsaved title"));
      await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))); await settle();
      expect(title().value).toBe("My unsaved title");
      const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
      expect(reload.defaultPrevented).toBe(true);
      await act(async () => link.click());
      expect(navigate).toHaveBeenCalledTimes(1);
      await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Cancel")!.click());
      expect(title().value).toBe("My unsaved title");
      await act(async () => input(title(), page.title));
      await act(async () => link.click());
      expect(navigate).toHaveBeenCalledTimes(2);
      await act(async () => input(title(), "Explicitly cancelled title"));
      await act(async () => button("Cancel").click());
      expect(container.textContent).not.toContain("Edit CMS draft");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally { link.remove(); }
  });

  it("freezes the old editor while a confirmed replacement read is pending and restores it if that read fails", async () => {
    const otherPage = { ...page, path: "/guides/another", title: "Another guide" };
    let failRead!: (reason: unknown) => void;
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes(encodeURIComponent(otherPage.path))) return new Promise((_resolve, reject) => { failRead = reject; });
      return path.includes("cms/page?") ? { page: { ...page, body: article } } : { items: [page, otherPage], pageInfo };
    });
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Edit").click());
    const editor = () => [...container.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent?.includes("Edit CMS draft"))!;
    await act(async () => input(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!, "My retained article"));
    await act(async () => [...container.querySelectorAll("button")].filter(node => node.textContent === "Edit")[1].click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Discard changes")!.click());
    expect(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!.closest("fieldset")?.disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].filter(node => node.textContent === "Publish").every(node => node.disabled)).toBe(true);
    await act(async () => failRead(new Error("Replacement page unavailable")));
    expect(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!.value).toBe("My retained article");
    expect(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!.closest("fieldset")?.disabled).toBe(false);
    expect(button("Cancel").disabled).toBe(false);
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("freezes a CMS status command's reason and cancellation until the pending request settles", async () => {
    let failWrite!: (reason: unknown) => void;
    apiWrite.mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Publish").click());
    await act(async () => {
      input(container.querySelector<HTMLInputElement>('[aria-label="CMS publish reason"]')!, "Publish this exact page");
      input(container.querySelector<HTMLInputElement>('[aria-label="CMS publish confirmation"]')!, page.path);
    });
    await act(async () => button("Confirm publish change").click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="CMS publish reason"]')!.closest("fieldset")?.disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => button("Cancel").click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="CMS publish reason"]')!.value).toBe("Publish this exact page");
    await act(async () => failWrite(new Error("CMS publication unavailable"))); await settle();
    expect(container.querySelector('[aria-label="CMS publish reason"]')).toBeNull();
    expect(container.textContent).not.toContain("is published and indexable");
    expect(apiWrite).toHaveBeenCalledTimes(1);
    expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/cms/pages/publish", "POST", expect.objectContaining({ path: page.path, reason: "Publish this exact page", expectedUpdatedAt: page.updatedAt }));
  });

  it("protects a CMS create draft and freezes the submitted input while retaining it after permission revocation", async () => {
    let failWrite!: (reason: unknown) => void;
    apiWrite.mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    const createForm = () => [...container.querySelectorAll("details")].find(node => node.querySelector("summary")?.textContent === "Create new page draft")!;
    await act(async () => {
      input(createForm().querySelector<HTMLInputElement>('[placeholder="/guides/example"]')!, "/guides/new-draft");
      input(createForm().querySelector<HTMLInputElement>('[placeholder="Page title"]')!, "Keep my new page");
      input(createForm().querySelector<HTMLInputElement>('[placeholder="Reason (≥3)"]')!, "Create a new guide");
      input(createForm().querySelector<HTMLInputElement>('[aria-label="CMS page confirmation"]')!, "/guides/new-draft");
    });
    const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
    expect(reload.defaultPrevented).toBe(true);
    await act(async () => button("Create draft").click());
    expect(createForm().querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBe(true);
    await act(async () => root.render(<CmsView canWrite={false} />));
    await act(async () => failWrite(new AdminV2RequestError("Missing admin permission", 403, "forbidden")));
    expect(button("Create draft")).toBeUndefined();
    expect(apiWrite).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<CmsView canWrite />));
    expect(createForm().querySelector<HTMLInputElement>('[placeholder="Page title"]')!.value).toBe("Keep my new page");
    expect(createForm().querySelector<HTMLFieldSetElement>("fieldset")!.disabled).toBe(false);
  });

  it("keeps a failed save editable with the original article input for a deliberate retry", async () => {
    let failWrite!: (reason: unknown) => void;
    apiWrite.mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Edit").click());
    const editor = () => [...container.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent?.includes("Edit CMS draft"))!;
    const title = () => editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!;
    const body = { ...article, heading: "My pending body" };
    await act(async () => {
      input(title(), "My pending title");
      input(editor().querySelector<HTMLTextAreaElement>('[aria-label="CMS article body JSON"]')!, JSON.stringify(body));
      input(editor().querySelector<HTMLInputElement>('[placeholder="Reason (≥3)"]')!, "Improve the article");
      input(editor().querySelector<HTMLInputElement>('[aria-label="CMS edit confirmation"]')!, page.path);
    });
    await act(async () => button("Save draft").click());
    await act(async () => failWrite(new AdminV2RequestError("CMS write unavailable", 503, "unavailable")));
    expect(title().value).toBe("My pending title");
    expect(title().closest("fieldset")?.disabled).toBe(false);
    expect(JSON.parse(editor().querySelector<HTMLTextAreaElement>('[aria-label="CMS article body JSON"]')!.value)).toEqual(body);
    expect(button("Save draft").disabled).toBe(false);
    expect(container.textContent).not.toContain(`Draft saved for ${page.path}`);
    await act(async () => input(title(), "My corrected retry title"));
    await act(async () => button("Save draft").click()); await settle();
    expect(apiWrite).toHaveBeenCalledTimes(2);
    expect(apiWrite).toHaveBeenLastCalledWith("/api/v2/admin/cms/pages", "PATCH", expect.objectContaining({ path: page.path, title: "My corrected retry title", body }));
    expect(editor()).toBeUndefined();
    expect(container.textContent).toContain(`Draft saved for ${page.path}`);
  });

  it("keeps a version-conflicted CMS draft without silently adopting the fresh row version", async () => {
    let current = { ...page };
    apiGet.mockImplementation(async (path: string) => path.includes("cms/page?") ? { page: { ...current, body: article } } : { items: [current], pageInfo });
    apiWrite.mockRejectedValueOnce(new AdminV2RequestError("CMS page changed since it was loaded", 409, "version_conflict"));
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Edit").click());
    const editor = () => [...container.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent?.includes("Edit CMS draft"))!;
    const title = () => editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!;
    await act(async () => {
      input(title(), "Keep my conflicting article");
      input(editor().querySelector<HTMLInputElement>('[placeholder="Reason (≥3)"]')!, "Improve the article");
      input(editor().querySelector<HTMLInputElement>('[aria-label="CMS edit confirmation"]')!, page.path);
    });
    current = { ...page, title: "Another operator's article", updatedAt: "2026-10-02T05:00:00.000Z" };
    await act(async () => button("Save draft").click()); await settle();
    expect(title().value).toBe("Keep my conflicting article");
    expect(button("Save draft").disabled).toBe(false);
    expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/cms/pages", "PATCH", expect.objectContaining({ expectedUpdatedAt: page.updatedAt }));
    expect(container.textContent).not.toContain(`Draft saved for ${page.path}`);
    await act(async () => button("Edit").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Cancel")!.click());
    expect(title().value).toBe("Keep my conflicting article");
    await act(async () => button("Edit").click());
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === "Discard changes")!.click());
    expect(title().value).toBe(current.title);
    await act(async () => {
      input(title(), "My explicit fresh edit");
      input(editor().querySelector<HTMLInputElement>('[placeholder="Reason (≥3)"]')!, "Reconcile the newer article");
      input(editor().querySelector<HTMLInputElement>('[aria-label="CMS edit confirmation"]')!, page.path);
    });
    await act(async () => button("Save draft").click()); await settle();
    expect(apiWrite).toHaveBeenLastCalledWith("/api/v2/admin/cms/pages", "PATCH", expect.objectContaining({ expectedUpdatedAt: current.updatedAt, title: "My explicit fresh edit" }));
  });

  it("removes write controls on permission revocation while an attempted save fails", async () => {
    let failWrite!: (reason: unknown) => void;
    apiWrite.mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = reject; }));
    await act(async () => root.render(<CmsView canWrite />)); await settle();
    await act(async () => button("Edit").click());
    const editor = () => [...container.querySelectorAll("section")].find(node => node.querySelector("h2")?.textContent?.includes("Edit CMS draft"))!;
    await act(async () => {
      input(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!, "Permission-sensitive input");
      input(editor().querySelector<HTMLInputElement>('[placeholder="Reason (≥3)"]')!, "Improve the article");
      input(editor().querySelector<HTMLInputElement>('[aria-label="CMS edit confirmation"]')!, page.path);
    });
    await act(async () => button("Save draft").click());
    await act(async () => root.render(<CmsView canWrite={false} />));
    await act(async () => failWrite(new AdminV2RequestError("Missing admin permission", 403, "forbidden")));
    expect(button("Save draft")).toBeUndefined();
    expect(button("Edit")).toBeUndefined();
    expect(button("Publish")).toBeUndefined();
    expect(button("Create draft")).toBeUndefined();
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT))); await settle();
    expect(apiWrite).toHaveBeenCalledTimes(1);
    await act(async () => root.render(<CmsView canWrite />));
    expect(editor().querySelector<HTMLInputElement>('[placeholder="Page title"]')!.value).toBe("Permission-sensitive input");
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
