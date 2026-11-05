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
        return charactersFixture(path);
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
      root.render(<ContentMerchandisingWorkspace canCurate canWrite />);
    });
    await waitFor(() => featuredReads === 1);

    // SPEC: 没有 ID 输入框、原因框、确认词框。
    expect(container.querySelector('input[placeholder="char_a, char_b"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Featured confirmation"]')).toBeNull();
    await pickCharacter("character-draft");
    expect(saveFeaturedButton().disabled).toBe(false);
    await act(async () => saveFeaturedButton().click());
    await waitFor(() => featuredReads === 2);
    await waitFor(() =>
      container.textContent?.includes(
        "Another operator changed Featured before your save.",
      ) ?? false,
    );

    const putCall = fetchMock.mock.calls.find(([, options]) =>
      options?.method === "PUT"
    );
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({
      characterIds: ["character-original", "character-draft"],
      expectedVersion: 3,
      reason: "Update Featured (+1, -0)",
    });
    expect(draftRows()).toEqual(["character-original", "character-draft"]);
    expect(container.textContent).toContain(
      "Latest authority was refreshed. Your list is kept below",
    );
    expect(container.textContent).toContain("Current version 4");
    expect(container.textContent).toContain("Currently saved: character-current");
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

  it("preserves unsaved featured curation when shell refresh returns a newer configuration", async () => {
    let featuredReads = 0;
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ ok: false, error: { code: "FORBIDDEN", message: "Fixture rejected write" } }, { status: 403 });
      }
      if (String(input).includes("/api/v2/admin/content/characters")) return charactersFixture(String(input));
      featuredReads += 1;
      const ids = featuredReads === 1 ? ["character-original"] : ["character-saved-elsewhere"];
      return Response.json({ ok: true, data: {
        items: [], characterIds: ids, configuredCharacterIds: ids, effectiveCharacterIds: [],
        settingVersion: featuredReads === 1 ? 3 : 4, settingDiagnostics: [],
      } });
    }));
    await act(async () => root.render(<ContentMerchandisingWorkspace canCurate canWrite />));
    await waitFor(() => featuredReads === 1);
    await pickCharacter("character-my-draft");

    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });

    expect(featuredReads).toBe(2);
    expect(draftRows()).toEqual(["character-original", "character-my-draft"]);
    await act(async () => saveFeaturedButton().click());
    expect(writes).toEqual([{
      characterIds: ["character-original", "character-my-draft"], expectedVersion: 3,
      reason: "Update Featured (+1, -0)",
    }]);
  });

  it("keeps new featured picks made while an earlier save is pending", async () => {
    let finishWrite!: (response: Response) => void;
    let saved = false;
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/v2/admin/content/characters")) return charactersFixture(String(input));
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        if (writes.length > 1) return Response.json({ ok: false, error: { code: "FORBIDDEN", message: "Fixture rejected second write" } }, { status: 403 });
        return new Promise<Response>(resolve => { finishWrite = resolve; });
      }
      const ids = saved ? ["character-submitted"] : [];
      return Response.json({ ok: true, data: {
        items: [], characterIds: ids, configuredCharacterIds: ids, effectiveCharacterIds: [],
        settingVersion: saved ? 4 : 3, settingDiagnostics: [],
      } });
    }));
    await act(async () => root.render(<ContentMerchandisingWorkspace canCurate canWrite />));
    await waitFor(() => container.querySelector('input[type="search"]') !== null && Boolean(saveFeaturedButtonOrNull()));
    await pickCharacter("character-submitted");
    await act(async () => saveFeaturedButton().click());
    expect(saveFeaturedButton().disabled).toBe(true);
    await pickCharacter("character-next-draft");
    saved = true;
    await act(async () => finishWrite(Response.json({ ok: true, data: {
      characterIds: ["character-submitted"], configuredCharacterIds: ["character-submitted"],
      effectiveCharacterIds: [], settingVersion: 4, settingDiagnostics: [], skipped: [], invalid: [],
    } })));

    expect(draftRows()).toEqual(["character-submitted", "character-next-draft"]);
    expect(saveFeaturedButton().disabled).toBe(false);
    await act(async () => saveFeaturedButton().click());
    expect(writes).toEqual([
      { characterIds: ["character-submitted"], expectedVersion: 3, reason: "Update Featured (+1, -0)" },
      { characterIds: ["character-submitted", "character-next-draft"], expectedVersion: 4, reason: "Update Featured (+1, -0)" },
    ]);
  });

  // SPEC: 选对象、排序、看差异、一键保存；全程不出现 ID 输入和键入确认。
  it("reorders with buttons, shows the difference by name, and saves in one click", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/api/v2/admin/content/characters")) return charactersFixture(String(input));
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, data: {
          characterIds: ["two", "one"], configuredCharacterIds: ["two", "one"],
          effectiveCharacterIds: ["two"], settingVersion: 6, settingDiagnostics: [], skipped: [], invalid: [],
        } });
      }
      return Response.json({ ok: true, data: {
        items: [
          { id: "one", name: "Ada", visibility: "public", status: "approved", thumbnailUrl: null, configuredPosition: 0, configured: true, effective: false,
            blockers: [{ code: "serving_not_live", message: "Character Serving is not live.", repairDeepLink: "/admin/characters/one?tab=release" }] },
          { id: "two", name: "Bea", visibility: "public", status: "approved", thumbnailUrl: null, configuredPosition: 1, configured: true, effective: true, blockers: [] },
        ],
        characterIds: ["one", "two"], configuredCharacterIds: ["one", "two"], effectiveCharacterIds: ["two"],
        settingVersion: 5, settingDiagnostics: [],
      } });
    }));
    await act(async () => root.render(<ContentMerchandisingWorkspace canCurate canWrite={false} />));
    await waitFor(() => Boolean(saveFeaturedButtonOrNull()));
    expect(saveFeaturedButton().disabled).toBe(true);
    // 未上线的行就地说明原因并给出修复入口。
    expect(container.textContent).toContain("Character Serving is not live.");
    expect(container.querySelector('a[href="/admin/characters/one?tab=release"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Move Bea up"]')!.click());
    expect(draftRows()).toEqual(["two", "one"]);
    expect(container.textContent).toContain("Same characters, new order.");
    await act(async () => saveFeaturedButton().click());
    expect(writes).toEqual([{ characterIds: ["two", "one"], expectedVersion: 5, reason: "Update Featured (+0, -0)" }]);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers no curation controls without content.placement.write", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/api/v2/admin/content/characters")) return charactersFixture(String(input));
      return Response.json({ ok: true, data: {
        items: [{ id: "one", name: "Ada", visibility: "public", status: "approved", thumbnailUrl: null, configuredPosition: 0, configured: true, effective: true, blockers: [] }],
        characterIds: ["one"], configuredCharacterIds: ["one"], effectiveCharacterIds: ["one"], settingVersion: 5, settingDiagnostics: [],
      } });
    }));
    await act(async () => root.render(<ContentMerchandisingWorkspace canWrite />));
    await waitFor(() => container.textContent?.includes("Ada") ?? false);
    expect(saveFeaturedButtonOrNull()).toBeUndefined();
    expect(container.querySelector('button[aria-label="Move Ada up"]')).toBeNull();
    expect(container.textContent).toContain("Editing placements is unavailable");
  });

  // SPEC: Unlist / Make private 是可逆动作：普通确认，不键入、不填原因。
  it("unlists through one plain confirmation with an automatic reason", async () => {
    const writes: Array<[string, unknown]> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "POST") {
        writes.push([url.pathname, JSON.parse(String(init.body))]);
        return Response.json({ ok: true, data: { character: { id: "first", visibility: "unlisted", status: "approved" }, replayed: false } });
      }
      if (url.pathname.endsWith("/characters")) {
        return Response.json({ ok: true, data: { items: [{ id: "first", name: "First character", visibility: "public" }], pageInfo: { hasNextPage: false, endCursor: null } } });
      }
      return Response.json({ ok: true, data: { items: [], characterIds: [], configuredCharacterIds: [], effectiveCharacterIds: [], settingVersion: 0, settingDiagnostics: [] } });
    }));
    await act(async () => root.render(<ContentMerchandisingWorkspace canWrite />));
    await waitFor(() => container.textContent?.includes("First character") ?? false);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Unlist")!.click());
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("input")).toBeNull();
    const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Unlist")!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(writes).toEqual([["/api/v2/admin/content/characters/first/visibility", {
      visibility: "unlisted", reason: "Unlist", confirmation: "first:visibility:unlisted",
    }]]);
  });

  function saveFeaturedButtonOrNull() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Save featured");
  }

  function saveFeaturedButton() {
    const button = saveFeaturedButtonOrNull();
    if (!button) throw new Error("Missing Save featured");
    return button;
  }

  function draftRows() {
    return [...container.querySelectorAll('ol[aria-label="Featured configuration and live status"] > li')]
      .map(row => row.querySelector("span[title]")?.getAttribute("title") ?? "");
  }

  async function pickCharacter(name: string) {
    const search = container.querySelector<HTMLInputElement>('input[type="search"][placeholder="Search by character name"]');
    if (!search) throw new Error("Missing Featured search");
    await changeInput(search, name);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 230)); });
    const results = container.querySelector('[data-testid="featured-search-results"]');
    const result = [...(results?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(button => button.textContent?.includes(name));
    if (!result) throw new Error(`Missing Featured search result ${name}`);
    await act(async () => result.click());
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

// 目录列表 fixture：带 search 时把搜索词当角色名返回，其余情况是空表。
function charactersFixture(path: string) {
  const search = new URL(path, "http://localhost").searchParams.get("search");
  return Response.json({ ok: true, data: {
    items: search ? [{ id: search, name: search, visibility: "public", status: "approved", servingState: "live", imageAsset: null }] : [],
    pageInfo: { endCursor: null, hasNextPage: false },
  } });
}

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
