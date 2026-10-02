// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
import { HelpDeskWorkspace } from "./HelpDeskWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const item = (id: string, status = "planned", userVoted = false) => ({ id, title: id, description: "A product improvement to discuss.", category: "feature", status, voteCount: userVoted ? 1 : 0, userVoted });
const envelope = (data: unknown) => Response.json({ ok: true, data });
const page = (ids: string[], nextCursor: string | null, viewerId = "customer", status = "planned") => envelope({ items: ids.map((id) => item(id, status)), nextCursor, viewerId });
async function settle() { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

describe("public roadmap pages", () => {
  let root: Root;
  let container: HTMLDivElement;
  let viewer: string;
  let feedbackFetch: (url: URL, init?: RequestInit) => Promise<Response>;
  beforeEach(() => {
    viewer = "customer";
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
    window.history.replaceState(null, "", "/helpdesk");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    feedbackFetch = async () => page(["First idea"], "next");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/me") return envelope({ user: { id: viewer }, anonymousId: null });
      if (url.pathname === "/api/v1/support/history") return envelope({ supportRequests: [], reports: [], appeals: [] });
      return feedbackFetch(url, init);
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function mount() { await act(async () => root.render(createElement(HelpDeskWorkspace))); await settle(); }
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label);
    expect(button, label).toBeDefined(); await act(async () => button!.click()); await settle();
  }
  const titles = () => [...container.querySelectorAll('[data-testid="feedback-items"] h4')].map((node) => node.textContent);

  it("appends later pages, preserves their order after a vote, and refreshes from the start", async () => {
    const requests: string[] = [];
    feedbackFetch = async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/vote")) return envelope({ item: item("Last idea", "planned", true) });
      return url.searchParams.has("cursor") ? page(["Last idea"], null) : page(["First idea"], "next");
    };
    await mount(); await click("Load more ideas");
    expect(titles()).toEqual(["First idea", "Last idea"]);
    await click("Vote0for Last idea");
    expect(titles()).toEqual(["First idea", "Last idea"]);
    const voted = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("Last idea"));
    expect(voted?.getAttribute("aria-pressed")).toBe("true");
    await click("Refresh roadmap items");
    expect(titles()).toEqual(["First idea"]);
    expect(requests.filter((request) => request.includes("cursor=next"))).toHaveLength(1);
  });

  it("retains loaded ideas and cursor when the next page fails, then retries it", async () => {
    let attempts = 0;
    feedbackFetch = async (url) => {
      if (!url.searchParams.has("cursor")) return page(["First idea"], "next");
      attempts += 1;
      return attempts === 1 ? Response.json({ error: { message: "Temporary connection problem" } }, { status: 503 }) : page(["Last idea"], null);
    };
    await mount(); await click("Load more ideas");
    expect(titles()).toEqual(["First idea"]);
    expect(container.textContent).toContain("Temporary connection problem");
    await click("Load more ideas");
    expect(titles()).toEqual(["First idea", "Last idea"]);
    expect(attempts).toBe(2);
  });

  it("cancels a previous page when status changes and ignores its late response", async () => {
    let finish!: (value: Response) => void;
    let oldSignal: AbortSignal | null | undefined;
    feedbackFetch = async (url, init) => {
      if (url.searchParams.has("cursor")) { oldSignal = init?.signal; return new Promise((resolve) => { finish = resolve; }); }
      return url.searchParams.get("status") === "shipped" ? page(["Shipped idea"], null, viewer, "shipped") : page(["First idea"], "next");
    };
    await mount(); await click("Load more ideas");
    const title = container.querySelector<HTMLInputElement>('[name="feedbackTitle"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "My unfinished idea");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Roadmap status"]');
    expect(select).not.toBeNull();
    await act(async () => { select!.value = "shipped"; select!.dispatchEvent(new Event("change", { bubbles: true })); }); await settle();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finish(page(["Late planned idea"], null))); await settle();
    expect(titles()).toEqual(["Shipped idea"]);
    expect(title.value).toBe("My unfinished idea");
  });

  it("drops old vote state and late pages after a different account gains focus", async () => {
    let finish!: (value: Response) => void;
    let oldSignal: AbortSignal | null | undefined;
    feedbackFetch = async (url, init) => {
      if (url.searchParams.has("cursor")) { oldSignal = init?.signal; return new Promise((resolve) => { finish = resolve; }); }
      return viewer === "customer" ? envelope({ items: [item("Old account idea", "planned", true)], nextCursor: "old-next", viewerId: viewer }) : page(["New account idea"], null, viewer);
    };
    await mount(); await click("Load more ideas");
    viewer = "other";
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finish(envelope({ items: [item("Late account idea", "planned", true)], nextCursor: null, viewerId: "customer" }))); await settle();
    expect(titles()).toEqual(["New account idea"]);
    expect(container.querySelector('[data-testid="feedback-items"] [aria-pressed="true"]')).toBeNull();
  });

  it("rechecks identity when a page was answered for a different account", async () => {
    let reads = 0;
    feedbackFetch = async () => {
      reads += 1;
      if (reads === 1) {
        viewer = "other";
        return envelope({ items: [item("Wrong scope result", "planned", true)], nextCursor: null, viewerId: viewer });
      }
      return page(["Current account idea"], null, viewer);
    };
    await mount();
    expect(reads).toBe(2);
    expect(titles()).toEqual(["Current account idea"]);
    expect(container.querySelector('[data-testid="feedback-items"] [aria-pressed="true"]')).toBeNull();
  });

  it("does not apply a late vote after the account changes", async () => {
    let finish!: (value: Response) => void;
    feedbackFetch = async (url) => {
      if (url.pathname.endsWith("/vote")) return new Promise((resolve) => { finish = resolve; });
      return page([viewer === "customer" ? "Old account idea" : "New account idea"], null, viewer);
    };
    await mount(); await click("Vote0for Old account idea");
    viewer = "other";
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await act(async () => finish(envelope({ item: item("Old account idea", "planned", true) }))); await settle();
    expect(titles()).toEqual(["New account idea"]);
    expect(container.querySelector('[data-testid="feedback-items"] [aria-pressed="true"]')).toBeNull();
  });

  it.each(["customer", "anonymous"])("does not file a %s support draft into a new account while a focus identity check is delayed", async (initialViewer) => {
    viewer = initialViewer;
    let finishViewer!: (response: Response) => void;
    let holdViewer = false;
    const persisted: Array<{ userId: string; description: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/me") return holdViewer
        ? new Promise<Response>((resolve) => { finishViewer = resolve; })
        : envelope({ user: viewer === "anonymous" ? null : { id: viewer }, anonymousId: viewer === "anonymous" ? "test-browser" : null });
      if (path === "/api/v1/support/history") return envelope({ supportRequests: [], reports: [], appeals: [] });
      if (path === "/api/v1/support/requests") {
        const expectedScope = new Headers(init?.headers).get("x-idream-viewer-scope");
        if (expectedScope && expectedScope !== `user:${viewer}`) return Response.json({ ok: false, error: { message: "Your account changed." } }, { status: 409 });
        const body = JSON.parse(String(init?.body));
        persisted.push({ userId: viewer, description: body.description });
        return envelope({ request: { id: "support-a", ticketId: "SUP-A", status: "received", category: "generation" } });
      }
      return envelope({ items: [], nextCursor: null, viewerId: viewer === "anonymous" ? null : viewer });
    }));
    await mount();
    await act(async () => {
      const subject = container.querySelector<HTMLInputElement>('[name="subject"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(subject, "Private account problem");
      subject.dispatchEvent(new Event("input", { bubbles: true }));
      const description = container.querySelector<HTMLTextAreaElement>('[name="description"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, "Only the original account should send this private description.");
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    viewer = "other"; holdViewer = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await click("Submit request");
    holdViewer = false;
    await act(async () => finishViewer(envelope({ user: { id: viewer }, anonymousId: null })));
    await settle();
    expect(persisted).toEqual([]);
  });

  it("clears the previous account's history and pending support state before the next account's history arrives", async () => {
    let finishSupport!: (response: Response) => void;
    let finishHistory!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path === "/api/v1/me") return envelope({ user: { id: viewer }, anonymousId: null });
      if (path === "/api/v1/support/history") return viewer === "other"
        ? new Promise<Response>((resolve) => { finishHistory = resolve; })
        : envelope({ supportRequests: [{ id: "support-a", ticketId: "SUP-A", category: "bug", subject: "Original account ticket", status: "received", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", resolution: null }], reports: [], appeals: [] });
      if (path === "/api/v1/support/requests") return new Promise<Response>((resolve) => { finishSupport = resolve; });
      return page([], null, viewer);
    }));
    await mount();
    expect(container.textContent).toContain("Original account ticket");
    const fillDraft = async (text: string) => act(async () => {
      const subject = container.querySelector<HTMLInputElement>('[name="subject"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(subject, text);
      subject.dispatchEvent(new Event("input", { bubbles: true }));
      const description = container.querySelector<HTMLTextAreaElement>('[name="description"]')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, `${text} private description`);
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await fillDraft("Original account"); await click("Submit request");
    viewer = "other";
    await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    expect(container.textContent).not.toContain("Original account ticket");
    await fillDraft("Next account");
    const submit = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Submit request");
    expect(submit).toBeDefined(); expect(submit!.disabled).toBe(false);
    await act(async () => finishSupport(envelope({ request: { id: "support-a", ticketId: "SUP-A", status: "received", category: "bug" } }))); await settle();
    expect(container.textContent).not.toContain("SUP-A");
    expect(container.querySelector<HTMLInputElement>('[name="subject"]')!.value).toBe("Next account");
    await act(async () => finishHistory(envelope({ supportRequests: [], reports: [], appeals: [] })));
  });
});
