// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentMerchandisingWorkspace } from "./ContentMerchandisingWorkspace";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("ContentMerchandisingWorkspace Featured concurrency", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/content/featured?view=featured");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("sends the loaded version, refreshes on conflict, and preserves the operator draft", async () => {
    let featuredReads = 0;
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const path = String(input);
      if (path.includes("/api/v2/admin/content/characters")) {
        return Response.json({
          ok: true,
          data: {
            items: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        });
      }
      if (
        path.includes("/api/v2/admin/content/featured") &&
        (init?.method ?? "GET") === "GET"
      ) {
        featuredReads += 1;
        const conflicted = featuredReads > 1;
        return Response.json({
          ok: true,
          data: {
            items: [],
            characterIds: conflicted ? ["character-current"] : ["character-original"],
            configuredCharacterIds: conflicted
              ? ["character-current"]
              : ["character-original"],
            effectiveCharacterIds: [],
            settingVersion: conflicted ? 4 : 3,
            settingDiagnostics: [],
          },
        });
      }
      if (
        path.includes("/api/v2/admin/content/featured") &&
        init?.method === "PUT"
      ) {
        return Response.json({
          ok: false,
          error: {
            code: "conflict",
            message: "Featured configuration changed before this save was applied",
            details: {
              reason: "featured_setting_version_conflict",
              expectedVersion: 3,
              settingVersion: 4,
              configuredCharacterIds: ["character-current"],
            },
          },
        }, { status: 409 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<ContentMerchandisingWorkspace canWrite />);
    });
    await waitFor(() => featuredReads === 1);

    const ids = requiredInput('input[placeholder="char_a, char_b"]');
    const reason = requiredInput('input[placeholder="Reason (≥3 chars)"]');
    const confirmation = requiredInput(
      'input[aria-label="Featured confirmation"]',
    );
    await changeInput(ids, "character-draft");
    await changeInput(reason, "keep operator intent");
    await changeInput(confirmation, "character-draft");

    const save = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Save featured"),
    );
    expect(save).toBeDefined();
    expect(save?.disabled).toBe(false);
    await act(async () => {
      save?.click();
    });
    await waitFor(() => featuredReads === 2);
    await waitFor(() =>
      container.textContent?.includes(
        "Another operator changed Featured before your save.",
      ) ?? false,
    );

    const putCall = fetchMock.mock.calls.find(([, options]) =>
      options?.method === "PUT"
    );
    expect(JSON.parse(String(putCall?.[1]?.body))).toMatchObject({
      characterIds: ["character-draft"],
      expectedVersion: 3,
      reason: "keep operator intent",
      confirmation: "character-draft",
    });
    expect(ids.value).toBe("character-draft");
    expect(reason.value).toBe("keep operator intent");
    expect(confirmation.value).toBe("character-draft");
    expect(container.textContent).toContain(
      "Latest authority was refreshed. Your draft remains in the fields",
    );
    expect(container.textContent).toContain("Current version 4");
    expect(container.textContent).toContain(
      "Current configured IDs: character-current",
    );
  });

  it("surfaces dirty-history diagnostics from the canonical authority DTO", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = String(input);
      if (path.includes("/api/v2/admin/content/characters")) {
        return Response.json({
          ok: true,
          data: {
            items: [],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        });
      }
      return Response.json({
        ok: true,
        data: {
          items: [],
          characterIds: ["character-a"],
          configuredCharacterIds: ["character-a"],
          effectiveCharacterIds: [],
          settingVersion: 12,
          settingDiagnostics: [
            {
              code: "character_id_duplicate",
              message: "Featured character character-a is duplicated.",
              index: 1,
              id: "character-a",
            },
            {
              code: "character_id_overflow",
              message: "Featured character character-z exceeds the limit.",
              index: 24,
              id: "character-z",
            },
          ],
        },
      });
    }));

    await act(async () => {
      root.render(<ContentMerchandisingWorkspace canWrite />);
    });
    await waitFor(() =>
      container.textContent?.includes(
        "Stored Featured configuration needs repair",
      ) ?? false,
    );

    expect(container.textContent).toContain("character id duplicate");
    expect(container.textContent).toContain("character-a");
    expect(container.textContent).toContain("Position 2");
    expect(container.textContent).toContain("character id overflow");
    expect(container.textContent).toContain("Configuration version 12");
  });

  function requiredInput(selector: string) {
    const input = container.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`Missing input ${selector}`);
    return input;
  }

  it("restores the page and visited cursors after refresh, remount, and browser navigation", async () => {
    mockPagedCharacters();
    await act(async () => root.render(<ContentMerchandisingWorkspace canWrite={false} />));
    await waitFor(() => container.textContent?.includes("First character") ?? false);
    await clickPageButton("Next page");
    await waitFor(() => container.textContent?.includes("Middle character") ?? false);
    const second = { url: window.location.href, state: window.history.state };
    await clickPageButton("Next page");
    await waitFor(() => container.textContent?.includes("Last character") ?? false);
    const third = { url: window.location.href, state: window.history.state };

    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitFor(() => !pageButton("Previous page").disabled);
    expect(paginationText()).toContain("Page 3");
    expect(new URLSearchParams(window.location.search).get("contentPage")).toBe("3");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("featured");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<ContentMerchandisingWorkspace canWrite={false} />));
    await waitFor(() => container.textContent?.includes("Last character") ?? false);
    expect(paginationText()).toContain("Page 3");
    expect(pageButton("Previous page").disabled).toBe(false);

    // happy-dom does not dispatch popstate on history navigation.
    await act(async () => {
      window.history.replaceState(second.state, "", second.url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => container.textContent?.includes("Middle character") ?? false);
    expect(paginationText()).toContain("Page 2");
    await act(async () => {
      window.history.replaceState(third.state, "", third.url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => container.textContent?.includes("Last character") ?? false);
    expect(paginationText()).toContain("Page 3");
    await clickPageButton("Previous page");
    await waitFor(() => container.textContent?.includes("Middle character") ?? false);
    expect(paginationText()).toContain("Page 2");
    await clickPageButton("Previous page");
    await waitFor(() => container.textContent?.includes("First character") ?? false);
    expect(paginationText()).toContain("Page 1");
    expect(window.location.search).toBe("?view=featured");
  });

  it("offers an explicit return to the first page on a fresh shared cursor link", async () => {
    window.history.replaceState(null, "", "/admin/content/featured?contentCursor=middle&contentPage=3");
    const requests = mockPagedCharacters();
    await act(async () => root.render(<ContentMerchandisingWorkspace canWrite={false} />));
    await waitFor(() => container.textContent?.includes("Last character") ?? false);
    expect(paginationText()).toContain("Page 3");
    expect(pageButton("Back to first page").disabled).toBe(false);
    await clickPageButton("Back to first page");
    await waitFor(() => container.textContent?.includes("First character") ?? false);
    expect(paginationText()).toContain("Page 1");
    expect(requests).toEqual(["middle", ""]);
  });

  it("removes a pending mutation confirmation when write permission is revoked", async () => {
    mockPagedCharacters();
    await act(async () => root.render(<ContentMerchandisingWorkspace canWrite />));
    await waitFor(() => container.textContent?.includes("First character") ?? false);
    const unlist = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Unlist")!;
    expect(unlist.disabled).toBe(false);
    await act(async () => unlist.click());
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => root.render(<ContentMerchandisingWorkspace canWrite={false} />));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method && init.method !== "GET")).toHaveLength(0);
  });

  function mockPagedCharacters() {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/characters")) {
        const cursor = url.searchParams.get("cursor") ?? "";
        requests.push(cursor);
        const name = cursor === "middle" ? "Last character" : cursor === "first" ? "Middle character" : "First character";
        return Response.json({ ok: true, data: {
          items: [{ id: name, name }],
          pageInfo: { hasNextPage: cursor !== "middle", endCursor: cursor === "middle" ? null : cursor === "first" ? "middle" : "first" },
        } });
      }
      return Response.json({ ok: true, data: { items: [], characterIds: [], configuredCharacterIds: [], effectiveCharacterIds: [], settingVersion: 0, settingDiagnostics: [] } });
    }));
    return requests;
  }

  function paginationText() {
    return container.querySelector('[data-testid="admin-pagination"]')?.textContent;
  }

  function pageButton(label: string) {
    const button = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === label);
    if (!button) throw new Error(`Missing button ${label}`);
    return button;
  }

  async function clickPageButton(label: string) {
    expect(pageButton(label).disabled).toBe(false);
    await act(async () => pageButton(label).click());
  }
});

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Condition did not become true");
}
