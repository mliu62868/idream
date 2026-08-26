// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reportRequest, useReportDialog } from "./ReportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SPEC: 举报弹窗是站内所有举报入口的唯一实现。它提交的 category 必须是用户点选的那个，
//       description 必须是用户写的那段 —— 这两件事以前在六个入口里全是写死的常量。
const statuses: string[] = [];

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
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("submits the reason the user picked with the note the user typed", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { report: { id: "r1" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(createElement(Host)));
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/reports");
    expect(JSON.parse(String(init.body))).toEqual({
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
      vi.fn(async () => new Response("{}", { status: 500 })),
    );

    await act(async () => root.render(createElement(Host)));
    await clickText(container, "Report");
    await clickText(container, "Submit report");

    expect(statuses).toEqual(["Could not submit the report. Please try again."]);
    expect(container.querySelector("[data-testid=report-dialog]")).not.toBeNull();
  });
});
