// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatorStudioSummary } from "@/lib/creator-studio";
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: ComponentProps<"a">) => createElement("a", { ...props, href: String(href) }, children) }));
import { CreatorStudioWorkspace } from "./CreatorStudioWorkspace";
import { invalidateViewerAuthority } from "./viewer-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
beforeEach(() => { invalidateViewerAuthority(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); invalidateViewerAuthority(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const envelope = (data: unknown) => Response.json({ ok: true, data });
const authority = (id: string | null = "owner-a") => envelope({ user: id ? { id } : null, anonymousId: "guest-studio" });
function summary(id = "owner-a"): CreatorStudioSummary {
  const item = { id: "older-draft", title: `${id} saved draft`, status: "draft", visibility: null, updatedAt: "2026-10-02T00:00:00.000Z", href: "/create?draft=older-draft" };
  return { schemaVersion: 1, viewerId: id, asOf: "2026-10-02T00:00:00.000Z",
    counts: { drafts: 1, characters: 2, publicCharacters: 1, comics: { total: 3, publicAvailable: 1, byStatus: { draft: 2, published: 1 } }, packs: { total: 4, publicAvailable: 1, byStatus: { draft: 2, published: 1, withdrawn: 1 } }, followers: 3, packClaims: 7, packClaimants: 2 },
    publicCharacterQualification: { available: 1, awaiting: 0, paused: 1 },
    program: { state: "unavailable", definitionVersion: null, level: null, nextLevel: null, publicWorks: 3, followers: 3 },
    recent: { drafts: [item], characters: [{ ...item, id: "character-a", title: "Owner character", visibility: "private", href: "/create?edit=character-a" }], comics: [], packs: [] } };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Studio did not settle: ${container.textContent}`); await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }
}
const reload = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Reload studio")!;

describe("Creator Studio owner workspace", () => {
  it("loads real totals with confirmed scope and exact draft management links", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? authority() : envelope(summary())));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => container.textContent?.includes("owner-a saved draft") === true);
    expect(container.querySelector('a[href="/create?draft=older-draft"]')).not.toBeNull();
    expect(container.querySelector('a[href="/create?edit=character-a"]')).not.toBeNull();
    expect(container.querySelector('a[href="/custom?tab=created"]')).not.toBeNull();
    expect(container.querySelector('a[href="/packs?scope=mine"]')).not.toBeNull();
    expect(container.textContent).toContain("Creator levels are not open yet");
    expect(container.textContent).toContain("Pack claims: 7 · 2 readers");
    const read = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/v1/creator-studio")!;
    expect(new Headers(read[1]?.headers).get("x-idream-viewer-scope")).toBe("user:owner-a");
    expect(read[1]?.cache).toBe("no-store");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("keeps older than six drafts reachable without exposing draft content in the overview", async () => {
    const data = summary(); data.counts.drafts = 8;
    data.recent.drafts = Array.from({ length: 8 }, (_, index) => ({ ...data.recent.drafts[0]!, id: `draft-${index + 1}`, title: `Draft ${index + 1}`, href: `/create?draft=draft-${index + 1}` }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? authority() : envelope(data)));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => Boolean(container.querySelector('a[href="/create?draft=draft-6"]')));
    expect(container.querySelector('a[href="/create?draft=draft-7"]')).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Show all drafts")!.click());
    expect(container.querySelector('a[href="/create?draft=draft-8"]')).not.toBeNull();
  });
  it("shows current publication availability instead of implying a public character is released", async () => {
    const data = summary();
    data.publicCharacterQualification = { available: 0, awaiting: 1, paused: 0 };
    data.recent.characters = [{ ...data.recent.characters[0]!, title: "Iris", status: "awaiting_publication", visibility: "public" }];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? authority() : envelope(data)));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => container.textContent?.includes("Iris") === true);
    const row = [...container.querySelectorAll("li")].find(item => item.textContent?.includes("Iris"))!;
    expect(row.textContent).toContain("Awaiting publication");
    expect(row.textContent).not.toContain("· public");
    expect(container.textContent).toContain("Public characters: 0 available, 1 awaiting publication, 0 paused.");
    expect(container.textContent).not.toContain("qualification");
  });
  it("displays published rule requirements without frontend default thresholds", async () => {
    const data = summary();
    data.program = { state: "published", definitionVersion: 9, level: { level: 1, label: "Working creator", publicWorks: 1, followers: 0 },
      nextLevel: { level: 2, label: "Community creator", publicWorks: 7, followers: 19, remainingPublicWorks: 4, remainingFollowers: 16 }, publicWorks: 3, followers: 3 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? authority() : envelope(data)));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => container.textContent?.includes("Working creator") === true);
    expect(container.textContent).toContain("Publish 4 more public works");
    expect(container.textContent).toContain("Gain 16 more followers");
    expect(container.textContent).toContain("Rules v9");
  });
  it("shows a retryable failure without presenting zero totals or keeping old private rows", async () => {
    let fail = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? authority() : fail
      ? new Response("<html>upstream unavailable</html>", { status: 503 }) : envelope(summary())));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => container.textContent?.includes("owner-a saved draft") === true);
    fail = true; await act(async () => reload().click());
    await until(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.textContent).not.toContain("owner-a saved draft");
    expect(container.querySelector('[data-testid="studio-totals"]')).toBeNull();
    fail = false; await act(async () => reload().click());
    await until(() => container.textContent?.includes("owner-a saved draft") === true);
  });
  it("rejects a response belonging to a different actor", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? authority() : envelope(summary("owner-b"))));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => Boolean(container.querySelector('[role="alert"]')));
    expect(container.textContent).not.toContain("owner-b saved draft");
    expect(container.querySelector('[data-testid="studio-totals"]')).toBeNull();
  });
  it("drops an old account's late read after a focus-confirmed account switch", async () => {
    let id = "owner-a", finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/me") return authority(id);
      return new Headers(init?.headers).get("x-idream-viewer-scope") === "user:owner-a"
        ? new Promise<Response>(resolve => { finish = resolve; }) : envelope(summary("owner-b"));
    }));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => Boolean(finish));
    id = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => container.textContent?.includes("owner-b saved draft") === true);
    await act(async () => finish(envelope(summary("owner-a"))));
    expect(container.textContent).not.toContain("owner-a saved draft");
  });
  it("does not send private Studio requests for a confirmed guest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => authority(null)));
    await act(async () => root.render(createElement(CreatorStudioWorkspace)));
    await until(() => Boolean(container.querySelector('a[href="/login?next=%2Fcreator-studio"]')));
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/creator-studio")).toHaveLength(0);
  });
});
