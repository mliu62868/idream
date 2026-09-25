// @vitest-environment happy-dom

// SPEC: 已有公告可以编辑：回填当前值，PATCH 发标题 / 正文 / 级别 / 链接 / 时间窗，确认串是公告 id。
//       启停不在这张表单里（仍走行内启用 / 停用），所以编辑不发 active。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementsView } from "./AnnouncementsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const announcement = {
  id: "ann-1",
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

  it("prefills the form and patches the edited copy with the id as confirmation", async () => {
    await act(async () => root.render(<AnnouncementsView />));
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
    expect(body).toMatchObject({ title: "Launch sale v2", body: "50% off", level: "promo", href: null, confirmation: "ann-1", reason: "fix copy" });
    expect(body).not.toHaveProperty("active");
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
