// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountAgeVerification } from "./AccountAgeVerification";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const ok = (data: unknown, status = 200) => Response.json({ ok: true, data }, { status });
const failure = (message: string, status = 403) =>
  Response.json({ ok: false, error: { message } }, { status });

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
  vi.unstubAllGlobals();
});

function startButton() {
  return container.querySelector<HTMLButtonElement>(
    '[data-testid="profile-age-verification-start"]',
  );
}

async function mount(fetcher: Fetcher, redirect = vi.fn()) {
  await act(async () => {
    root.render(
      createElement(AccountAgeVerification, { ownerId: "owner-a", fetcher, redirect }),
    );
  });
  return redirect;
}

describe("account age verification escape hatch", () => {
  it("stays out of the way when nothing blocks the account", async () => {
    await mount(async () => ok({ status: "not_required" }));
    expect(container.querySelector('[data-testid="profile-age-verification"]')).toBeNull();
  });

  // 这是这个组件存在的唯一理由：failed/expired/pending 在补上入口之前
  // 没有任何站内动作可以离开，用户只能等运营改库。
  it.each(["failed", "expired", "pending", "required"] as const)(
    "offers a new attempt when the account is locked in %s",
    async (status) => {
      await mount(async () => ok({ status }));
      expect(startButton()).not.toBeNull();
      expect(startButton()?.disabled).toBe(false);
    },
  );

  it("creates a session and reports the unlock when the provider answers inline", async () => {
    const fetcher = vi.fn<Fetcher>(async (_input, init) =>
      init?.method === "POST"
        ? ok({ verification: { id: "av-1", status: "not_required" }, url: null })
        : ok({ status: "failed" }),
    );
    const redirect = await mount(fetcher);

    await act(async () => startButton()!.click());

    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/v1/age-verification/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(redirect).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Verification is complete");
  });

  it("hands the user to the provider when one returns a link", async () => {
    const fetcher = vi.fn<Fetcher>(async (_input, init) =>
      init?.method === "POST"
        ? ok({
            verification: { id: "av-1", status: "pending" },
            url: "https://verify.example.com/session/av-1",
          })
        : ok({ status: "required" }),
    );
    const redirect = await mount(fetcher);

    await act(async () => startButton()!.click());

    expect(redirect).toHaveBeenCalledWith("https://verify.example.com/session/av-1");
  });

  // provider 返回的 url 是外部输入，javascript: 也能被 new URL() 解析。
  it("refuses a provider link that is not http(s)", async () => {
    const fetcher = vi.fn<Fetcher>(async (_input, init) =>
      init?.method === "POST"
        ? ok({
            verification: { id: "av-1", status: "pending" },
            url: "javascript:alert(1)",
          })
        : ok({ status: "required" }),
    );
    const redirect = await mount(fetcher);

    await act(async () => startButton()!.click());

    expect(redirect).not.toHaveBeenCalled();
    expect(startButton()?.disabled).toBe(false);
  });

  // fetchForOwner 只在 Profile 确认了另一个账号时抛 AbortError；确认进行中它自己等待，
  // 首次加载与重试由 ProfileWorkspace.mounted.test 覆盖。
  it("says nothing when the profile abandons the read for another account", async () => {
    const aborting: Fetcher = async () => {
      throw new DOMException("Account confirmation changed", "AbortError");
    };
    await mount(aborting);
    expect(container.textContent).toBe("");

    // 身份确认后 Profile 交给子组件的是一个新的 fetcher，effect 因此重跑。
    const confirmed: Fetcher = async () => ok({ status: "failed" });
    await mount(confirmed);
    expect(container.textContent).toContain("Verification did not pass");
    expect(container.textContent).not.toContain("Account confirmation changed");
  });

  it("keeps the retry available when starting a session fails", async () => {
    const fetcher = vi.fn<Fetcher>(async (_input, init) =>
      init?.method === "POST"
        ? failure("Verification provider is unavailable.", 500)
        : ok({ status: "failed" }),
    );
    await mount(fetcher);

    await act(async () => startButton()!.click());

    expect(container.textContent).toContain("Verification provider is unavailable.");
    expect(startButton()?.disabled).toBe(false);
  });
});
