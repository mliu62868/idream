import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_TRANSFER_TTL_MS,
  claimDraftTransfer,
  draftTransferPath,
  stashDraftTransfer,
} from "./draft-transfer";

const ANONYMOUS = "anonymous:visitor-1";
const USER = "user:account-1";

function createSessionStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

function installBrowser(initialHref = "https://app.test/create") {
  const sessionStorage = createSessionStorage();
  const current = { href: initialHref };
  vi.stubGlobal("window", {
    get location() {
      const url = new URL(current.href);
      return {
        hash: url.hash,
        href: url.href,
        pathname: url.pathname,
        search: url.search,
      };
    },
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        current.href = new URL(url, current.href).toString();
      },
    },
    sessionStorage,
  });
  return {
    current,
    sessionStorage,
    navigateTo(returnUrl: string) {
      current.href = new URL(returnUrl, current.href).toString();
    },
  };
}

describe("draft transfer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hands a stashed draft to the signed-in viewer and scrubs the nonce", () => {
    const browser = installBrowser();
    const returnUrl = stashDraftTransfer("create", {
      payload: { name: "Nova", step: 2 },
      sourceScope: ANONYMOUS,
    });

    expect(returnUrl).toMatch(/^\/create\?draftResume=/);
    browser.navigateTo(returnUrl ?? "/create");

    expect(claimDraftTransfer("create", { targetScope: USER })).toEqual({
      payload: { name: "Nova", step: 2 },
      sourceScope: ANONYMOUS,
    });
    expect(browser.current.href).toBe("https://app.test/create");
  });

  it("is one-shot — a replayed return URL claims nothing", () => {
    const browser = installBrowser();
    const returnUrl = stashDraftTransfer("helpdesk", {
      payload: { kind: "support" },
      sourceScope: ANONYMOUS,
    });
    browser.navigateTo(returnUrl ?? "/helpdesk");

    expect(claimDraftTransfer("helpdesk", { targetScope: USER })).not.toBeNull();
    browser.navigateTo(returnUrl ?? "/helpdesk");
    expect(claimDraftTransfer("helpdesk", { targetScope: USER })).toBeNull();
  });

  it("keeps other query parameters when scrubbing the nonce", () => {
    const browser = installBrowser("https://app.test/helpdesk?tab=appeals#appeals");
    const returnUrl = stashDraftTransfer("helpdesk", {
      payload: { kind: "appeal" },
      sourceScope: ANONYMOUS,
    });
    const nonce = new URL(returnUrl ?? "", "https://app.test").searchParams.get("resume");
    browser.navigateTo(`/helpdesk?tab=appeals&resume=${nonce}#appeals`);

    expect(claimDraftTransfer("helpdesk", { targetScope: USER })).not.toBeNull();
    expect(browser.current.href).toBe("https://app.test/helpdesk?tab=appeals#appeals");
  });

  it("drops a transfer that outlived its TTL", () => {
    const browser = installBrowser("https://app.test/generate");
    const returnUrl = stashDraftTransfer("generatorPreset", {
      payload: { label: "Night market" },
      sourceScope: ANONYMOUS,
    });
    browser.navigateTo(returnUrl ?? "/generate");

    vi.setSystemTime(Date.now() + DRAFT_TRANSFER_TTL_MS + 1);

    expect(claimDraftTransfer("generatorPreset", { targetScope: USER })).toBeNull();
    expect(browser.sessionStorage.entries.size).toBe(0);
  });

  it("rejects a nonce that does not match, without burning the pending transfer", () => {
    const browser = installBrowser();
    const returnUrl = stashDraftTransfer("create", {
      payload: { name: "Nova" },
      sourceScope: ANONYMOUS,
    });
    browser.navigateTo("/create?draftResume=not-the-nonce");

    expect(claimDraftTransfer("create", { targetScope: USER })).toBeNull();

    browser.navigateTo(returnUrl ?? "/create");
    expect(claimDraftTransfer("create", { targetScope: USER })).not.toBeNull();
  });

  it("returns null when nothing was stashed", () => {
    const browser = installBrowser();
    browser.navigateTo("/create?draftResume=orphan-nonce");
    expect(claimDraftTransfer("create", { targetScope: USER })).toBeNull();
  });

  it("returns null when the URL carries no nonce", () => {
    const browser = installBrowser();
    stashDraftTransfer("create", { payload: { name: "Nova" }, sourceScope: ANONYMOUS });
    expect(claimDraftTransfer("create", { targetScope: USER })).toBeNull();
    expect(browser.sessionStorage.entries.size).toBe(1);
  });

  it("only an anonymous scope may stash and only a user scope may claim", () => {
    const browser = installBrowser();
    expect(
      stashDraftTransfer("create", { payload: { name: "Nova" }, sourceScope: USER }),
    ).toBeNull();

    const returnUrl = stashDraftTransfer("create", {
      payload: { name: "Nova" },
      sourceScope: ANONYMOUS,
    });
    browser.navigateTo(returnUrl ?? "/create");
    expect(claimDraftTransfer("create", { targetScope: ANONYMOUS })).toBeNull();
    expect(claimDraftTransfer("create", { targetScope: USER })).not.toBeNull();
  });

  it("keeps channels isolated", () => {
    const browser = installBrowser();
    const returnUrl = stashDraftTransfer("create", {
      payload: { name: "Nova" },
      sourceScope: ANONYMOUS,
    });
    browser.navigateTo(returnUrl ?? "/create");

    expect(claimDraftTransfer("helpdesk", { targetScope: USER })).toBeNull();
    expect(claimDraftTransfer("generatorPreset", { targetScope: USER })).toBeNull();
    expect(claimDraftTransfer("create", { targetScope: USER })).not.toBeNull();
  });

  it("discards a tampered envelope instead of trusting its scope", () => {
    const browser = installBrowser();
    const returnUrl = stashDraftTransfer("create", {
      payload: { name: "Nova" },
      sourceScope: ANONYMOUS,
    });
    const storageKey = [...browser.sessionStorage.entries.keys()][0] ?? "";
    const envelope = JSON.parse(browser.sessionStorage.entries.get(storageKey) ?? "{}");
    browser.sessionStorage.setItem(
      storageKey,
      JSON.stringify({ ...envelope, sourceScope: "user:someone-else" }),
    );
    browser.navigateTo(returnUrl ?? "/create");

    expect(claimDraftTransfer("create", { targetScope: USER })).toBeNull();
    expect(browser.sessionStorage.entries.size).toBe(0);
  });

  it("degrades to null when session storage throws", () => {
    installBrowser();
    vi.stubGlobal("window", {
      location: { hash: "", href: "https://app.test/create", pathname: "/create", search: "" },
      history: { replaceState: () => {} },
      sessionStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {},
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });

    expect(
      stashDraftTransfer("create", { payload: { name: "Nova" }, sourceScope: ANONYMOUS }),
    ).toBeNull();
    expect(claimDraftTransfer("create", { targetScope: USER })).toBeNull();
  });

  it("does nothing when rendered without a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(
      stashDraftTransfer("create", { payload: { name: "Nova" }, sourceScope: ANONYMOUS }),
    ).toBeNull();
    expect(claimDraftTransfer("create", { targetScope: USER })).toBeNull();
  });

  it("exposes the plain return route for each channel", () => {
    expect(draftTransferPath("create")).toBe("/create");
    expect(draftTransferPath("generatorPreset")).toBe("/generate");
    expect(draftTransferPath("helpdesk")).toBe("/helpdesk");
  });
});
