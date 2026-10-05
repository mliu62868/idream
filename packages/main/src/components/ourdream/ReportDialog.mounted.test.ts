// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reportRequest, useReportDialog } from "./ReportDialog";
import { invalidateViewerAuthority } from "./viewer-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SPEC: 举报弹窗是站内所有举报入口的唯一实现。它提交的 category 必须是用户点选的那个，
//       description 必须是用户写的那段 —— 这两件事以前在六个入口里全是写死的常量。
const statuses: string[] = [];
let viewer: string | null;
const me = () => Response.json({ ok: true, data: { user: viewer ? { id: viewer } : null } });
const reported = () => Response.json({ ok: true, data: { report: { id: "r1" } } });
async function settle() { for (let i = 0; i < 8; i += 1) await act(async () => new Promise(resolve => setTimeout(resolve, 0))); }

function Host() {
  const { openReport, reportDialog } = useReportDialog((message) =>
    statuses.push(message),
  );
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        onClick: () =>
          openReport({ kind: "record", targetType: "media", targetId: "media-1" }),
        type: "button",
      },
      "Report",
    ),
    reportDialog,
  );
}

async function clickText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  if (!button) throw new Error(`No button labelled ${text}: ${container.textContent}`);
  await act(async () => {
    button.click();
  });
}

describe("reportRequest", () => {
  it("routes each surface to its own endpoint and keeps the chosen reason", () => {
    expect(reportRequest({ kind: "character", id: "c 1" }, "spam", "")).toEqual({
      url: "/api/v1/characters/c%201/report",
      body: { category: "spam" },
    });
    expect(reportRequest({ kind: "feedItem", id: "f1" }, "quality", " glitchy ")).toEqual({
      url: "/api/v1/feed/items/f1/report",
      body: { category: "quality", description: "glitchy" },
    });
    expect(
      reportRequest(
        { kind: "record", targetType: "chat_message", targetId: "m1" },
        "underage_content",
        "",
      ),
    ).toEqual({
      url: "/api/v1/reports",
      body: { targetType: "chat_message", targetId: "m1", category: "underage_content" },
    });
  });
});

describe("ReportDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    statuses.length = 0;
    viewer = "owner-a";
    invalidateViewerAuthority();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/generate?tab=gallery");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    invalidateViewerAuthority();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits the reason the user picked with the note the user typed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input) === "/api/v1/me" ? me() : reported());
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(createElement(Host)));
    await settle();
    await clickText(container, "Report");

    const radios = [...container.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    const harassment = radios.find((node) => node.value === "harassment_or_hate");
    expect(harassment).toBeTruthy();
    await act(async () => {
      harassment?.click();
    });

    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("no description field");
    await act(async () => {
      // React 的受控输入只认原生 setter 触发的 input 事件。
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(textarea, "They kept threatening me.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickText(container, "Submit report");

    const writes = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/v1/reports");
    expect(writes).toHaveLength(1);
    const [url, init] = writes[0];
    expect(url).toBe("/api/v1/reports");
    expect(new Headers(init?.headers).get("x-idream-viewer-scope")).toBe("user:owner-a");
    expect(JSON.parse(String(init?.body))).toEqual({
      targetType: "media",
      targetId: "media-1",
      category: "harassment_or_hate",
      description: "They kept threatening me.",
    });
    expect(statuses).toEqual(["Report submitted."]);
    expect(container.querySelector("[data-testid=report-dialog]")).toBeNull();
  });

  it("keeps the dialog open and reports the failure when the write is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? me() : new Response("{}", { status: 500 })),
    );

    await act(async () => root.render(createElement(Host)));
    await settle();
    await clickText(container, "Report");
    await clickText(container, "Submit report");

    expect(statuses).toEqual(["Could not submit the report. Please try again."]);
    expect(container.querySelector("[data-testid=report-dialog]")).not.toBeNull();
  });

  it("does not submit an old viewer's report when the cookie changes before focus", async () => {
    const accepted: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/me") return me();
      const expected = new Headers(init?.headers).get("x-idream-viewer-scope");
      if (expected && expected !== `user:${viewer}`) return Response.json({ ok: false }, { status: 409 });
      accepted.push(viewer!); return reported();
    }));
    await act(async () => root.render(createElement(Host))); await settle();
    await clickText(container, "Report"); viewer = "owner-b";
    await clickText(container, "Submit report"); await settle();
    expect(accepted).toEqual([]);
    expect(statuses).not.toContain("Report submitted.");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("fixes the expected viewer at the write boundary even if the cookie changes after confirmation", async () => {
    const accepted: string[] = [], scopes: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/me") return me();
      viewer = "owner-b";
      const expected = new Headers(init?.headers).get("x-idream-viewer-scope"); scopes.push(expected);
      if (expected && expected !== `user:${viewer}`) return Response.json({ ok: false }, { status: 409 });
      accepted.push(viewer); return reported();
    }));
    await act(async () => root.render(createElement(Host))); await settle();
    await clickText(container, "Report"); await clickText(container, "Submit report"); await settle();
    expect(scopes).toEqual(["user:owner-a"]);
    expect(accepted).toEqual([]);
    expect(statuses).not.toContain("Report submitted.");
  });

  it("keeps the report available for retry when its account confirmation fails before the write", async () => {
    let unavailable = false;
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me") return unavailable ? Response.json({ ok: false }, { status: 503 }) : me();
      writes.push(String(input)); return reported();
    }));
    await act(async () => root.render(createElement(Host))); await settle();
    await clickText(container, "Report"); unavailable = true;
    await clickText(container, "Submit report"); await settle();
    expect(writes).toEqual([]);
    expect(container.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Your account could not be checked");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    unavailable = false; await clickText(container, "Submit report"); await settle();
    expect(writes).toEqual(["/api/v1/reports"]);
    expect(statuses.at(-1)).toBe("Report submitted.");
  });

  it("discards an old viewer's late receipt without closing the new viewer's dialog", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === "/api/v1/me" ? me()
      : new Promise<Response>(resolve => { finish = resolve; })));
    await act(async () => root.render(createElement(Host))); await settle();
    await clickText(container, "Report");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Submit report")!.click());
    await settle(); expect(finish).toBeTypeOf("function");
    viewer = "owner-b"; await act(async () => window.dispatchEvent(new Event("focus"))); await settle();
    await clickText(container, "Report");
    await act(async () => finish(reported())); await settle();
    expect(statuses).not.toContain("Report submitted.");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Submit report")?.disabled).toBe(false);
  });

  it("keeps the guest's draft open without submitting or redirecting when secure recovery keys are unavailable", async () => {
    viewer = null;
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const writes: string[] = [];
    vi.stubGlobal("crypto", { randomUUID: undefined });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/me") return me();
      writes.push(String(input)); return reported();
    }));
    await act(async () => root.render(createElement(Host))); await settle();
    await clickText(container, "Report");
    await act(async () => container.querySelector<HTMLInputElement>('input[value="quality"]')!.click());
    await act(async () => {
      const textarea = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Private draft stays.");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickText(container, "Submit report"); await settle();
    expect(writes).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[value="quality"]')?.checked).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe("Private draft stays.");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
    expect(window.sessionStorage.getItem("idream:report-signup-draft")).toBeNull();
  });

  it("takes a guest through signup and restores the same draft without submitting it", async () => {
    viewer = null;
    const accepted: string[] = [];
    const navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/me") return me();
      viewer = "owner-b";
      if (!new Headers(init?.headers).has("x-idream-viewer-scope")) accepted.push(viewer);
      return reported();
    }));
    await act(async () => root.render(createElement(Host))); await settle();
    await clickText(container, "Report");
    await act(async () => container.querySelector<HTMLInputElement>('input[value="quality"]')!.click());
    const description = "The original clip stopped halfway.";
    await act(async () => {
      const textarea = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, description);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickText(container, "Submit report"); await settle();
    expect(accepted).toEqual([]);
    const signup = new URL(String(navigate.mock.calls.at(-1)?.[0]), window.location.origin);
    expect(signup.pathname).toBe("/signup");
    const next = signup.searchParams.get("next");
    expect(next).toContain("/generate?");
    expect(next).toContain("tab=gallery");
    expect(next).not.toContain(description);
    await act(async () => root.unmount()); invalidateViewerAuthority();
    viewer = "owner-b"; window.history.replaceState(null, "", next!);
    root = createRoot(container); await act(async () => root.render(createElement(Host))); await settle();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[value="quality"]')?.checked).toBe(true);
    expect(container.querySelector("textarea")?.value).toBe(description);
    expect(accepted).toEqual([]);
    expect(window.location.search).toBe("?tab=gallery");
  });
});
