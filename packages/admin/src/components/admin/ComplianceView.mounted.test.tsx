// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { navItems, type SectionContext } from "./nav-config";
import { AdminI18nProvider, type AdminLocale } from "./i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ageRow = { id: "verification-A", userId: "account-A", provider: "manual", status: "pending", jurisdiction: null, verifiedAt: null, createdAt: "2026-10-01T00:00:00.000Z" };
const exported = (userId: string) => Response.json({ ok: true, data: { export: { user: { id: userId }, marker: `evidence-${userId}` } } });
const unavailable = () => Response.json({ ok: false, error: { code: "unavailable", message: "Authority unavailable", requestId: "request-compliance-503" } }, { status: 503 });

describe("Compliance operator target and permission boundaries", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fetchMock = vi.fn(async input => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.endsWith("/account-deletions")) return Response.json({ ok: true, data: { items: [], pastDueCount: 0 } });
      if (url.pathname.endsWith("/age-verifications")) return Response.json({ ok: true, data: { items: [ageRow] } });
      if (url.pathname.endsWith("/export")) return exported(url.pathname.split("/").at(-2)!);
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(canWrite = true, locale: AdminLocale = "en") {
    const permissions = new Set<AdminPermissionKey>(["compliance.read", ...(canWrite ? ["compliance.write" as const] : [])]);
    const context: SectionContext = { permissions, canCreateCharacters: false, actorId: "operator", canRead: true, view: { kind: "list" }, workMode: "support" };
    await act(async () => root.render(<AdminI18nProvider locale={locale}>{navItems.find(item => item.id === "compliance")!.render(context)}</AdminI18nProvider>));
    await waitFor(() => container.textContent?.includes(ageRow.userId) === true);
  }
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label);
  const input = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const click = async (label: string) => { await act(async () => button(label)!.click()); };
  const requests = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(suffix));
  async function prepareErase() {
    await changeInput(input("User ID"), "account-A");
    await click("Erase");
    await changeInput(input("Erase reason"), "Controlled erasure request");
    await changeInput(input("Erase confirmation"), "account-A");
  }

  it("removes an old export and download when the account changes, including a failed replacement", async () => {
    await render();
    await changeInput(input("User ID"), "account-A");
    await click("Export");
    expect(container.querySelector("pre")?.textContent).toContain("evidence-account-A");
    await changeInput(input("User ID"), "account-B");
    expect(button("Download JSON")).toBeUndefined();
    expect(container.querySelector("pre")).toBeNull();
    fetchMock.mockImplementationOnce(async () => unavailable());
    await click("Export");
    expect(button("Download JSON")).toBeUndefined();
    expect(container.textContent).not.toContain("evidence-account-A");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Retry to load the latest data");
  });

  it("ignores a slow export for the previous account and keeps the newer request pending", async () => {
    await render();
    let finishA!: (response: Response) => void;
    let finishB!: (response: Response) => void;
    await changeInput(input("User ID"), "account-A");
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }));
    await click("Export");
    await changeInput(input("User ID"), "account-B");
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishB = resolve; }));
    await click("Export");
    await act(async () => finishA(exported("account-A")));
    expect(button("Download JSON")).toBeUndefined();
    expect(button("Export")!.disabled).toBe(true);
    expect(container.textContent).not.toContain("evidence-account-A");
    await act(async () => finishB(exported("account-B")));
    expect(container.querySelector("pre")?.textContent).toContain("evidence-account-B");
    expect(container.querySelector("h3")?.textContent).toContain("account-B");
  });

  it("ignores a late failure for the previous account instead of attaching its retry to the new account", async () => {
    await render();
    let finishA!: (response: Response) => void;
    await changeInput(input("User ID"), "account-A");
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve; }));
    await click("Export");
    await changeInput(input("User ID"), "account-B");
    await click("Export");
    await act(async () => finishA(unavailable()));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("evidence-account-B");
    expect(requests("/account-B/export")).toHaveLength(1);
  });

  it("retries the displayed failed export for its original account and clears that error on target change", async () => {
    await render();
    await changeInput(input("User ID"), "account-A");
    fetchMock.mockImplementationOnce(async () => unavailable());
    await click("Export");
    await click("Retry");
    expect(requests("/account-A/export")).toHaveLength(2);
    expect(container.querySelector("pre")?.textContent).toContain("evidence-account-A");
    fetchMock.mockImplementationOnce(async () => unavailable());
    await click("Export");
    await changeInput(input("User ID"), "account-B");
    expect(button("Retry")).toBeUndefined();
    expect(button("Download JSON")).toBeUndefined();
  });

  it("discards an erasure confirmation when its target changes", async () => {
    await render();
    await prepareErase();
    await changeInput(input("User ID"), "account-B");
    expect(button("Confirm erase")).toBeUndefined();
    expect(input("Erase reason")).toBeNull();
    expect(requests("/erase")).toHaveLength(0);
  });

  it("freezes the erasure target and payload until the answer, preserving a failed retry", async () => {
    await render();
    await prepareErase();
    let finishErase!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishErase = resolve; }));
    await click("Confirm erase");
    expect(input("User ID").disabled).toBe(true);
    expect(input("Erase reason").disabled).toBe(true);
    expect(input("Erase confirmation").disabled).toBe(true);
    expect(button("Cancel")!.disabled).toBe(true);
    await click("Cancel");
    expect(input("Erase reason").value).toBe("Controlled erasure request");
    await act(async () => finishErase(unavailable()));
    expect(input("User ID").disabled).toBe(false);
    expect(input("Erase reason").value).toBe("Controlled erasure request");
    fetchMock.mockImplementationOnce(async () => Response.json({ ok: true, data: { erased: false, idempotent: true, deletion: { graceEndsAt: "2026-10-10T00:00:00.000Z" } } }));
    await click("Retry");
    const writes = requests("/account-A/erase");
    expect(writes).toHaveLength(2);
    expect(writes[1][1]?.body).toBe(writes[0][1]?.body);
    expect(new Headers(writes[1][1]?.headers).get("idempotency-key")).toBe(new Headers(writes[0][1]?.headers).get("idempotency-key"));
  });

  it("keeps reads available without exposing erasure or verification writes to a compliance reader", async () => {
    await render(false);
    expect(container.querySelector('[title="compliance.write"]')).not.toBeNull();
    for (const label of ["Erase", "Verify", "Fail", "Confirm erase", "Confirm override"]) expect(button(label)).toBeUndefined();
    await changeInput(input("User ID"), "account-A");
    await click("Export");
    expect(container.querySelector("pre")?.textContent).toContain("evidence-account-A");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("removes open write confirmations when compliance.write is revoked", async () => {
    await render();
    await prepareErase();
    await click("Verify");
    expect(button("Confirm override")).toBeDefined();
    await render(false);
    expect(button("Confirm erase")).toBeUndefined();
    expect(button("Confirm override")).toBeUndefined();
    await render(true);
    expect(button("Confirm erase")).toBeUndefined();
    expect(button("Confirm override")).toBeUndefined();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("does not let a failed erasure retry silently replay a reason the operator has changed", async () => {
    await render();
    await prepareErase();
    fetchMock.mockImplementationOnce(async () => unavailable());
    await click("Confirm erase");
    expect(button("Retry")).toBeDefined();
    await changeInput(input("Erase reason"), "Corrected erasure request");
    expect(button("Retry")).toBeUndefined();
    fetchMock.mockImplementationOnce(async () => Response.json({ ok: true, data: { idempotent: true, deletion: { graceEndsAt: "2026-10-10T00:00:00.000Z" } } }));
    await click("Confirm erase");
    expect(JSON.parse(String(requests("/account-A/erase").at(-1)![1]?.body)).reason).toBe("Corrected erasure request");
  });

  it("does not resurrect an erased permission's pending confirmation or retry when the grant returns", async () => {
    await render();
    await prepareErase();
    let finishErase!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishErase = resolve; }));
    await click("Confirm erase");
    await render(false);
    await act(async () => finishErase(unavailable()));
    await render(true);
    expect(button("Confirm erase")).toBeUndefined();
    expect(button("Retry")).toBeUndefined();
    expect(requests("/erase")).toHaveLength(1);
  });

  it("keeps selected queue scopes when the language changes", async () => {
    await render();
    const [erasureScope, ageStatus] = [...container.querySelectorAll<HTMLSelectElement>("select")];
    await act(async () => { erasureScope.value = "all"; erasureScope.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { ageStatus.value = "verified"; ageStatus.dispatchEvent(new Event("change", { bubbles: true })); });
    await render(true, "zh");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(new URL(String(requests("/account-deletions").at(-1)![0]), window.location.origin).searchParams.get("scope")).toBe("all");
    expect(new URL(String(requests("/age-verifications?").at(-1)![0]), window.location.origin).searchParams.get("status")).toBe("verified");
    expect(erasureScope.value).toBe("all");
    expect(ageStatus.value).toBe("verified");
  });

  it("downloads the JSON belonging to the explicit export target", async () => {
    await render();
    await changeInput(input("User ID"), "account-A");
    await click("Export");
    let downloadedName = "";
    let downloadedBlob: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { downloadedBlob = blob as Blob; return "blob:compliance-export"; });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { downloadedName = this.download; });
    await click("Download JSON");
    expect(downloadedName).toBe("dsar-export-account-A.json");
    expect(await downloadedBlob!.text()).toContain("evidence-account-A");
    expect(container.querySelector("h3")?.textContent).toContain("account-A");
  });

  it("freezes an age override and retains structured write-failure evidence", async () => {
    await render();
    await click("Verify");
    await changeInput(input("Override reason"), "Controlled review decision");
    await changeInput(input("Override confirmation"), ageRow.id);
    let finishOverride!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishOverride = resolve; }));
    await click("Confirm override");
    expect(input("Override reason").disabled).toBe(true);
    expect(input("Override confirmation").disabled).toBe(true);
    expect(button("Cancel")!.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLSelectElement>("select")].at(-1)!.disabled).toBe(true);
    await act(async () => finishOverride(unavailable()));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("whether the write landed is unknown");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("request-compliance-503");
  });
});

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  throw new Error("Condition did not become true");
}
