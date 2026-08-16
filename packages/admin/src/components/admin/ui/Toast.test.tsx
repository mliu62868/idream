// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { ToastProvider, useFailureToast, useToast } from "./Toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("announces a success result to assistive tech and clears itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(<Fixture tone="success" title="Ledger adjusted for user-1" />);
    await act(async () => click("fire"));

    const toast = liveToast();
    expect(toast?.getAttribute("role")).toBe("status");
    expect(toast?.getAttribute("aria-live")).toBe("polite");
    expect(toast?.textContent).toContain("Ledger adjusted for user-1");
    expect(region()?.getAttribute("aria-label")).toBe("Action results");

    // SPEC: 成功 5s 自动消失——运营不该为了继续干活先去关一条"成功了"。
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(liveToast()).toBeNull();
  });

  it("keeps a failure on screen until it is dismissed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await render(<Fixture tone="error" title="Refund failed" />);
    await act(async () => click("fire"));

    expect(liveToast()?.getAttribute("role")).toBe("alert");
    expect(liveToast()?.getAttribute("aria-live")).toBe("assertive");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(liveToast()).not.toBeNull();

    await act(async () => click("Dismiss"));
    expect(liveToast()).toBeNull();
  });

  it("stacks results instead of replacing the previous one", async () => {
    await render(<Fixture tone="info" title="Queued" />);
    await act(async () => click("fire"));
    await act(async () => click("fire"));

    expect(document.body.querySelectorAll('[data-testid="admin-action-status"]')).toHaveLength(2);
  });

  // SPEC: 行动链接不收起 toast。
  // INTENT: 「复制给工程」点完就把错误抹掉的话，运营刚复制完就失去了要转述的那段话。
  it("keeps the failure on screen after its action link is used", async () => {
    const copied: string[] = [];
    await render(<ActionFixture onAction={(text) => copied.push(text)} />);
    await act(async () => click("fire"));
    await act(async () => click("Copy for engineering"));

    expect(copied).toEqual(["copied once"]);
    expect(liveToast()).not.toBeNull();
    expect(liveToast()?.textContent).toContain("Refund failed");
  });

  // SPEC: 溢出时先挤掉可丢的（success/info），别让「失败不会自己消失」变成空话。
  it("evicts a success before an unread failure when the stack overflows", async () => {
    await render(<OverflowFixture />);
    await act(async () => click("fill"));

    const tones = [...document.body.querySelectorAll('[data-testid="admin-action-status"]')].map(
      (node) => node.getAttribute("data-tone"),
    );
    expect(tones).toHaveLength(4);
    expect(tones.filter((tone) => tone === "error")).toHaveLength(4);
  });

  it("turns an authority failure into operator copy with a details escape hatch", async () => {
    await render(<FailureFixture />);
    await act(async () => click("fail"));

    const toast = liveToast();
    expect(toast?.getAttribute("data-tone")).toBe("error");
    expect(toast?.textContent).toContain("Someone changed this record before your action landed.");
    expect(toast?.textContent).toContain("Refresh to load the current version, then decide again.");
    expect(toast?.textContent).toContain("Copy for engineering");
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root.render(<ToastProvider>{node}</ToastProvider>);
    });
  }

  function click(label: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === label ||
        candidate.getAttribute("aria-label") === label,
    );
    expect(button, `no button labelled ${label}`).toBeTruthy();
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
});

function liveToast() {
  return document.body.querySelector('[data-testid="admin-action-status"]');
}

function region() {
  return document.body.querySelector('[role="region"]');
}

function Fixture({ title, tone }: { title: string; tone: "success" | "error" | "info" }) {
  const { toast } = useToast();
  return (
    <button onClick={() => toast({ title, tone })} type="button">
      fire
    </button>
  );
}

function ActionFixture({ onAction }: { onAction: (text: string) => void }) {
  const { toast } = useToast();
  return (
    <button
      onClick={() =>
        toast({
          tone: "error",
          title: "Refund failed",
          action: { label: "Copy for engineering", onClick: () => onAction("copied once") },
        })
      }
      type="button"
    >
      fire
    </button>
  );
}

function OverflowFixture() {
  const { toast } = useToast();
  return (
    <button
      onClick={() => {
        // 先攒 4 条失败，再来一条成功——成功该被丢掉，而不是顶掉最早那条失败。
        for (let index = 0; index < 4; index += 1) {
          toast({ tone: "error", title: `Failure ${index}` });
        }
        toast({ tone: "success", title: "Unrelated success" });
      }}
      type="button"
    >
      fill
    </button>
  );
}

function FailureFixture() {
  const failureToast = useFailureToast();
  return (
    <button
      onClick={() =>
        failureToast(
          new AdminV2RequestError("Character version changed", 409, "conflict", undefined, "req-9"),
        )
      }
      type="button"
    >
      fail
    </button>
  );
}
