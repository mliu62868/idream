// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
vi.mock("./AgeGateBoundary", () => ({ useAgeGateAccess: () => ({ accepted: true }) }));
import { HelpDeskWorkspace } from "./HelpDeskWorkspace";
import { helpTopics } from "./help-articles";
import { ourdreamRoutePaths } from "@/lib/ourdream-data";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const envelope = (data: unknown) => Response.json({ ok: true, data });
async function settle() { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }

// SPEC (US-SF-01): self-service answers grouped by topic, filterable, with a
// way out to a support request already pointed at the right category.
describe("Help Desk articles", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    const saved = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
    window.history.replaceState(null, "", "/helpdesk");
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/me") return envelope({ user: { id: "customer" }, anonymousId: null });
      if (url.pathname === "/api/v1/support/history") return envelope({ supportRequests: [], reports: [], appeals: [] });
      return envelope({ items: [], nextCursor: null, viewerId: "customer" });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function mount() { await act(async () => root.render(createElement(HelpDeskWorkspace))); await settle(); }
  const articles = () => container.querySelector('[data-testid="help-articles"]')!;
  const topicTitles = () => [...articles().querySelectorAll("section")].map((node) => node.getAttribute("aria-label"));
  async function search(value: string) {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search help articles"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("groups articles by topic and filters them by keyword", async () => {
    await mount();
    expect(topicTitles()).toEqual(["Account & sign-in", "Generation & refunds", "Chat & memory", "Privacy & account deletion", "Creating & publishing"]);
    expect(articles().querySelectorAll("details")).toHaveLength(helpTopics.flatMap((topic) => topic.articles).length);

    await search("refund");
    expect(topicTitles()).toContain("Generation & refunds");
    const summaries = [...articles().querySelectorAll("summary")].map((node) => node.textContent);
    expect(summaries).toContain("A generation failed. Do I get my coins back?");
    expect(summaries).not.toContain("I forgot my password.");
    expect([...articles().querySelectorAll("details")].every((node) => node.open)).toBe(true);

    // A keyword that is only in the article's synonyms still finds it.
    await search("locked out");
    expect([...articles().querySelectorAll("summary")].map((node) => node.textContent)).toEqual(["I forgot my password."]);

    await search("zzq-no-such-topic");
    expect(topicTitles()).toEqual([]);
    expect(articles().textContent).toContain("No article matches");
  });

  it("opens a support request with the topic's category preselected", async () => {
    await mount();
    const stuck = [...container.querySelectorAll("button")].find((node) => node.textContent === "Still stuck? Contact support about chat & memory")!;
    await act(async () => stuck.click());
    expect(container.querySelector<HTMLSelectElement>('select[name="category"]')!.value).toBe("chat");
    expect(document.activeElement?.getAttribute("name")).toBe("subject");
  });

  it("links only to places that exist", () => {
    const known = new Set<string>([...ourdreamRoutePaths, "/generate", "/coins"]);
    for (const link of helpTopics.flatMap((topic) => topic.articles.flatMap((article) => article.links))) {
      if (link.href.startsWith("#")) continue;
      expect(known, link.href).toContain(new URL(link.href, "http://localhost").pathname);
    }
  });
});
