// @vitest-environment happy-dom

// SPEC: 已有公告可以编辑：回填当前值，PATCH 发标题 / 正文 / 级别 / 链接 / 时间窗，确认串是公告 id。
//       启停不在这张表单里（仍走行内启用 / 停用），所以编辑不发 active。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementsView } from "./AnnouncementsView";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import { syncListUrl } from "./section-kit";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const announcement = {
  id: "ann-1",
  version: 7,
  title: "Launch sale",
  body: "50% off",
  level: "promo",
  active: true,
  serving: true,
  startsAt: null,
  endsAt: null,
  href: null,
  createdAt: "2026-09-20T00:00:00.000Z",
};

describe("AnnouncementsView edit", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/growth/merchandising?view=announcements");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return Response.json({ ok: true, data: { announcement } });
      }
      return Response.json({ ok: true, data: { items: [announcement], pageInfo: { endCursor: null, hasNextPage: false } } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("asks before discarding edited announcement copy for another row and does not prompt for unchanged inputs", async () => {
    const other = { ...announcement, id: "ann-other", title: "Another announcement" };
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: { items: [announcement, other], pageInfo: { endCursor: null, hasNextPage: false } } }));
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelectorAll('[aria-label="Edit announcement"]').length === 2);
    const editTargets = () => container.querySelectorAll<HTMLButtonElement>('[aria-label="Edit announcement"]');
    const title = () => container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!;
    const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === label)!;
    await act(async () => editTargets()[0].click());
    await act(async () => editTargets()[1].click());
    expect(title().value).toBe(other.title);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await changeInput(title(), "My unsaved announcement copy");
    await act(async () => editTargets()[0].click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    expect(title().value).toBe("My unsaved announcement copy");
    await act(async () => dialogButton("Cancel").click());
    expect(title().value).toBe("My unsaved announcement copy");
    await act(async () => editTargets()[0].click());
    await act(async () => dialogButton("Discard changes").click());
    expect(title().value).toBe(announcement.title);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });

  it("keeps an unsaved create draft when navigation or changing to an existing announcement is cancelled", async () => {
    const link = document.createElement("a"); link.href = "/admin/ops/presets"; document.body.append(link);
    const navigate = vi.fn((event: MouseEvent) => event.preventDefault()); link.addEventListener("click", navigate);
    const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === label)!;
    try {
      await act(async () => root.render(<AnnouncementsView canWrite />));
      await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
      await act(async () => link.click());
      expect(navigate).toHaveBeenCalledTimes(1);
      await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!, "My unpublished announcement");
      await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
      await waitFor(() => fetchMock.mock.calls.length === 2);
      const reload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(reload);
      expect(reload.defaultPrevented).toBe(true);
      await act(async () => link.click());
      expect(navigate).toHaveBeenCalledTimes(1);
      await act(async () => dialogButton("Cancel").click());
      expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!.value).toBe("My unpublished announcement");
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!.click());
      await act(async () => dialogButton("Cancel").click());
      expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!.value).toBe("My unpublished announcement");
    } finally { link.remove(); }
  });

  it("retains a failed announcement edit across permission revocation without leaving a write action exposed", async () => {
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!.click());
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!, "My revoked draft");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Reason (≥3)"]')!, "Fix the announcement copy");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement create confirmation"]')!, announcement.id);
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    const save = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Save changes")!;
    await act(async () => save.click());
    await act(async () => root.render(<AnnouncementsView canWrite={false} />));
    await act(async () => finishWrite(Response.json({ ok: false, error: { code: "forbidden", message: "Missing admin permission" } }, { status: 403 })));
    expect(container.querySelector('[aria-label="Edit announcement"]')).toBeNull();
    expect([...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Save changes")).toBeUndefined();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    await act(async () => root.render(<AnnouncementsView canWrite />));
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!.value).toBe("My revoked draft");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Missing admin permission");
  });

  it("does not pair a retained announcement edit with a newer list row version when the current Edit button is clicked", async () => {
    let current = { ...announcement };
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") return Response.json({ ok: false, error: { code: "version_conflict", message: "Announcement changed since it was loaded" } }, { status: 409 });
      return Response.json({ ok: true, data: { items: [current], pageInfo: { endCursor: null, hasNextPage: false } } });
    });
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!.click());
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!, "My conflicting announcement copy");
    current = { ...announcement, version: announcement.version + 1, title: "Another operator's announcement" };
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitFor(() => container.textContent?.includes(current.title) === true);
    const currentEdit = container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!;
    expect(currentEdit.disabled).toBe(true);
    await act(async () => currentEdit.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!.value).toBe("My conflicting announcement copy");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Reason (≥3)"]')!, "Reconcile the announcement copy");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement create confirmation"]')!, announcement.id);
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === "Save changes")!.click());
    const write = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(write[1]?.body))).toMatchObject({ entityVersion: announcement.version, title: "My conflicting announcement copy" });
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!.value).toBe("My conflicting announcement copy");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Announcement changed since it was loaded");
  });

  it("freezes announcement activation input while pending and preserves it for a failed-command retry", async () => {
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label)!;
    await act(async () => button("Deactivate").click());
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement action reason"]')!, "Pause this announcement");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement action confirmation"]')!, announcement.id);
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    await act(async () => button("Confirm update").click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Announcement action reason"]')!.closest("fieldset")?.disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => button("Cancel").click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Announcement action reason"]')!.value).toBe("Pause this announcement");
    await act(async () => finishWrite(Response.json({ ok: false, error: { code: "unavailable", message: "Announcement action unavailable" } }, { status: 503 })));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Announcement action reason"]')!.value).toBe("Pause this announcement");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Announcement action reason"]')!.closest("fieldset")?.disabled).toBe(false);
    expect(button("Confirm update").disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Announcement action unavailable");
    expect(container.textContent).not.toContain("Deactivated “Launch sale”");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("prefills the form and patches the edited copy with the id as confirmation", async () => {
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')?.click());
    const title = container.querySelector<HTMLInputElement>('input[placeholder="Title"]');
    expect(title?.value).toBe("Launch sale");
    expect(container.textContent).not.toContain("Active immediately");

    await changeInput(title!, "Launch sale v2");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Reason (≥3)"]')!, "fix copy");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement create confirmation"]')!, "ann-1");

    const save = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Save changes");
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    await waitFor(() => patchCalls().length === 1);

    const [url, init] = patchCalls()[0];
    expect(String(url)).toContain("/api/v2/admin/announcements/ann-1");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ entityVersion: 7, title: "Launch sale v2", body: "50% off", level: "promo", href: null, confirmation: "ann-1", reason: "fix copy" });
    expect(body).not.toHaveProperty("active");
  });

  it("returns to the previous cursor page after remounting without losing the announcement subview", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const secondPage = new URL(String(input), window.location.origin).searchParams.get("cursor") === "older-announcements";
      return Response.json({ ok: true, data: {
        items: [{ ...announcement, id: secondPage ? "ann-older" : announcement.id, title: secondPage ? "Older announcement" : announcement.title }],
        pageInfo: { endCursor: secondPage ? null : "older-announcements", hasNextPage: !secondPage },
      } });
    });
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.textContent?.includes("Launch sale") ?? false);
    const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
    await act(async () => button("Next page").click());
    await waitFor(() => container.textContent?.includes("Older announcement") ?? false);
    expect(window.location.search).toContain("view=announcements");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.textContent?.includes("Older announcement") ?? false);
    expect(button("Previous page").disabled).toBe(false);
    await act(async () => button("Previous page").click());
    await waitFor(() => container.textContent?.includes("Launch sale") ?? false);
    expect(window.location.search).toBe("?view=announcements");
    expect(button("Previous page").disabled).toBe(true);
  });

  it("keeps application state while allowing Next.js to synchronize a page navigation", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true, data: { items: [announcement], pageInfo: { endCursor: "older-announcements", hasNextPage: true } } }));
    await act(async () => root.render(<AnnouncementsView canWrite={false} />));
    await waitFor(() => container.textContent?.includes("Launch sale") ?? false);
    window.history.replaceState({ ...window.history.state, workspace: "keep-me", __NA: true, _N: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { old: "tree" } }, "", window.location.href);
    const push = vi.spyOn(window.history, "pushState");
    try {
      const next = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Next page")!;
      await act(async () => next.click());
      const written = push.mock.calls[0]?.[0];
      expect(written.workspace).toBe("keep-me");
      expect(written).not.toHaveProperty("__NA");
      expect(written).not.toHaveProperty("_N");
      expect(written).not.toHaveProperty("__PRIVATE_NEXTJS_INTERNALS_TREE");
      expect(window.location.search).toContain("announcementCursor=older-announcements");
    } finally {
      push.mockRestore();
    }
  });

  it("explicitly returns a fresh shared cursor link to the first page", async () => {
    window.history.replaceState(null, "", "/admin/growth/merchandising?view=announcements&announcementCursor=older-announcements&page=5");
    await act(async () => root.render(<AnnouncementsView canWrite={false} />));
    await waitFor(() => container.textContent?.includes("Launch sale") ?? false);
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 5");
    const previous = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Back to first page");
    expect(previous?.disabled).toBe(false);
    await act(async () => previous?.click());
    await waitFor(() => window.location.search === "?view=announcements");
    expect(container.querySelector('[data-testid="admin-pagination"]')?.textContent).toContain("Page 1");
    expect(new URL(String(fetchMock.mock.calls.at(-1)?.[0]), window.location.origin).searchParams.has("cursor")).toBe(false);
  });

  it("keeps the latest filter result when an earlier request completes later", async () => {
    let resolveEarlier!: (response: Response) => void;
    fetchMock.mockImplementation((input: string | URL | Request) => {
      const search = new URL(String(input), window.location.origin).searchParams.get("search");
      if (search === "older") return new Promise<Response>((resolve) => { resolveEarlier = resolve; });
      return Promise.resolve(Response.json({ ok: true, data: {
        items: [{ ...announcement, title: search === "newer" ? "Latest result" : announcement.title }],
        pageInfo: { endCursor: null, hasNextPage: false },
      } }));
    });
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.textContent?.includes("Launch sale") ?? false);
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search announcements"]')!;
    const apply = () => [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Apply")!;
    await changeInput(search, "older");
    await act(async () => apply().click());
    await waitFor(() => Boolean(resolveEarlier));
    await changeInput(search, "newer");
    await act(async () => apply().click());
    await waitFor(() => container.textContent?.includes("Latest result") ?? false);
    await act(async () => resolveEarlier(Response.json({ ok: true, data: {
      items: [{ ...announcement, title: "Stale result" }],
      pageInfo: { endCursor: "stale-cursor", hasNextPage: true },
    } })));
    expect(container.textContent).toContain("Latest result");
    expect(container.textContent).not.toContain("Stale result");
    expect(search.value).toBe("newer");
  });

  it("refreshes the current filtered cursor from the shell and ignores the earlier response", async () => {
    window.history.replaceState(null, "", "/admin/growth/merchandising?view=announcements&announcementSearch=sale");
    syncListUrl(new URLSearchParams("view=announcements&announcementSearch=sale&announcementCursor=current-page"), 2, { cursor: "announcementCursor", page: "page" });
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(Response.json({ ok: true, data: {
        items: [{ ...announcement, title: "Fresh announcement" }], pageInfo: { endCursor: null, hasNextPage: false },
      } }));
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => fetchMock.mock.calls.length === 1);
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitFor(() => fetchMock.mock.calls.length === 2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(String(fetchMock.mock.calls[0][0]));
    expect(new URL(String(fetchMock.mock.calls[1][0]), window.location.origin).searchParams.get("cursor")).toBe("current-page");
    await waitFor(() => container.textContent?.includes("Fresh announcement") ?? false);
    await act(async () => resolveOld(Response.json({ ok: true, data: {
      items: [{ ...announcement, title: "Stale announcement" }], pageInfo: { endCursor: "stale-next", hasNextPage: true },
    } })));
    expect(container.textContent).not.toContain("Stale announcement");
    const previous = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Previous page")!;
    expect(previous.disabled).toBe(false);
    await act(async () => previous.click());
    expect(window.location.search).toContain("announcementSearch=sale");
    expect(window.location.search).not.toContain("announcementCursor=");
  });

  it("does not present old rows as the result of a failed new filter", async () => {
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.textContent?.includes("Launch sale") ?? false);
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "internal_error", message: "backend unavailable" } }, { status: 503 }));
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Search announcements"]')!, "different query");
    const apply = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Apply")!;
    await act(async () => apply.click());
    await waitFor(() => container.querySelector('[role="alert"]') !== null);
    expect(container.textContent).not.toContain("Launch sale");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Retry to load the latest data.");
  });

  it.each(["toggle", "delete"])("sends the displayed announcement version for %s", async kind => {
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({ ok: true, data: { deleted: true } });
      if (init?.method === "PATCH") return Response.json({ ok: true, data: { announcement: { ...announcement, version: 8, active: false, serving: false } } });
      return Response.json({ ok: true, data: { items: [announcement], pageInfo: { hasNextPage: false, endCursor: null } } });
    });
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    const action = kind === "delete" ? container.querySelector<HTMLButtonElement>('[aria-label="Delete announcement"]')! :
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Deactivate")!;
    await act(async () => action.click());
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement action reason"]')!, "Retire the displayed announcement");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement action confirmation"]')!, announcement.id);
    const confirm = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === (kind === "delete" ? "Confirm delete" : "Confirm update"))!;
    await act(async () => confirm.click());
    const method = kind === "delete" ? "DELETE" : "PATCH";
    const [, init] = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === method)!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ entityVersion: 7, confirmation: announcement.id });
    expect(new Headers(init?.headers).get("idempotency-key")).toBeTruthy();
  });

  it("keeps a conflicting edit visible without reporting it as saved", async () => {
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!.click());
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!, "My pending copy");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Reason (≥3)"]')!, "Correct the announcement");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement create confirmation"]')!, announcement.id);
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "conflict", message: "Announcement changed. Refresh and reopen it before trying again." } }, { status: 409 }));
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Save changes")!;
    await act(async () => save.click());
    await waitFor(() => container.textContent?.includes("Announcement changed.") === true);
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')?.value).toBe("My pending copy");
    expect(container.textContent).not.toContain("Saved “My pending copy”.");
  });

  it("freezes an in-flight edit so another target and cancel cannot discard a newer input", async () => {
    const other = { ...announcement, id: "ann-2", title: "Another announcement" };
    fetchMock.mockImplementation(async (_input: string | URL | Request, init?: RequestInit) => init?.method === "PATCH"
      ? Response.json({ ok: true, data: { announcement } })
      : Response.json({ ok: true, data: { items: [announcement, other], pageInfo: { endCursor: null, hasNextPage: false } } }));
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelectorAll('[aria-label="Edit announcement"]').length === 2);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!.click());
    const title = container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!;
    await changeInput(title, "My pending copy");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Reason (≥3)"]')!, "Correct the announcement");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement create confirmation"]')!, announcement.id);
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    const save = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Save changes")!;
    await act(async () => save.click());
    const cancel = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Cancel")!;
    const editTargets = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Edit announcement"]')];
    expect(cancel.disabled).toBe(true);
    expect(title.closest("fieldset")?.disabled).toBe(true);
    expect(editTargets.every(node => node.disabled)).toBe(true);
    await act(async () => { cancel.click(); editTargets[1].click(); });
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')?.value).toBe("My pending copy");
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitFor(() => container.querySelectorAll('[aria-label="Edit announcement"]').length === 2);
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')?.value).toBe("My pending copy");
    await act(async () => finishWrite(Response.json({ ok: true, data: { announcement } })));
    await waitFor(() => container.textContent?.includes("Saved “My pending copy”.") === true);
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')?.value).toBe("");
    expect(patchCalls()).toHaveLength(1);
    expect(String(patchCalls()[0][0])).toContain(`/announcements/${announcement.id}`);
    expect(JSON.parse(String(patchCalls()[0][1]?.body))).toMatchObject({ title: "My pending copy", entityVersion: announcement.version });
  });

  it("freezes a pending creation without allowing an edit to replace that form", async () => {
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    const title = container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!;
    title.closest("details")!.open = true;
    await changeInput(title, "New operational notice");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Body"]')!, "A complete announcement body");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Reason (≥3)"]')!, "Create a scheduled notice");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement create confirmation"]')!, "New operational notice");
    let finishWrite!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishWrite = resolve; }));
    const create = [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Create")!;
    await act(async () => create.click());
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!;
    expect(edit.disabled).toBe(true);
    expect(title.closest("fieldset")?.disabled).toBe(true);
    await act(async () => edit.click());
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')?.value).toBe("New operational notice");
    await act(async () => finishWrite(Response.json({ ok: true, data: { announcement: { ...announcement, title: "New operational notice" } } })));
    await waitFor(() => container.textContent?.includes("Created “New operational notice”.") === true);
    expect(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')?.value).toBe("");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("restores editable inputs after a failed write and retries only the deliberate new copy", async () => {
    await act(async () => root.render(<AnnouncementsView canWrite />));
    await waitFor(() => container.querySelector('[aria-label="Edit announcement"]') !== null);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit announcement"]')!.click());
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!, "My failed copy");
    await changeInput(container.querySelector<HTMLInputElement>('input[placeholder="Reason (≥3)"]')!, "Correct the announcement");
    await changeInput(container.querySelector<HTMLInputElement>('[aria-label="Announcement create confirmation"]')!, announcement.id);
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error: { code: "unavailable", message: "Announcement write unavailable" } }, { status: 503 }));
    const save = () => [...container.querySelectorAll("button")].find(node => node.textContent?.trim() === "Save changes")!;
    await act(async () => save().click());
    await waitFor(() => container.textContent?.includes("Announcement write unavailable") === true);
    const title = container.querySelector<HTMLInputElement>('input[placeholder="Title"]')!;
    expect(title.value).toBe("My failed copy");
    expect(Boolean(title.closest("fieldset")?.disabled)).toBe(false);
    expect(save().disabled).toBe(false);
    expect(container.textContent).not.toContain("Saved “My failed copy”.");
    await changeInput(title, "My corrected copy");
    await act(async () => save().click());
    await waitFor(() => container.textContent?.includes("Saved “My corrected copy”.") === true);
    expect(patchCalls()).toHaveLength(2);
    expect(JSON.parse(String(patchCalls()[1][1]?.body))).toMatchObject({ title: "My corrected copy", entityVersion: announcement.version });
  });

  function patchCalls() {
    return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH") as [
      string,
      RequestInit | undefined,
    ][];
  }
});

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
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
