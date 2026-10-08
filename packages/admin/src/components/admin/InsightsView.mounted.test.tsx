// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import { AdminI18nProvider } from "./i18n";
import { navItems } from "./nav-config";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const profileA = { id: "profile-fixture-a", label: "Fixture image A", profileKey: "fixture-image-a", version: 6, status: "active" };
const profileB = { id: "profile-fixture-b", label: "Fixture image B", profileKey: "fixture-image-b", version: 2, status: "active" };
type Write = { path: string; body: Record<string, unknown>; key: string | null };
let container: HTMLDivElement;
let root: Root;
let profiles: typeof profileA[];
let writes: Write[];
let writeResponse: (write: Write) => Promise<Response>;
let healthResponse: (path: string) => Promise<Response>;
function verdict(status: "pass" | "fail" = "pass") {
  return Response.json({ ok: true, data: { dryRun: {
    status, passed: status === "pass" ? 2 : 1, total: 2, sampleCount: 2,
    configurationPassRate: status === "pass" ? 1 : 0.5,
    samples: [
      { useCase: "character", orientation: "portrait", ok: true, issues: [] },
      { useCase: "freeplay", orientation: "landscape", ok: status === "pass", issues: status === "pass" ? [] : ["runnerConfig fixture backend is unavailable", "pipelineModel must be configured"] },
    ],
  } } });
}
function health(total: number) {
  return Response.json({ ok: true, data: { metrics: { total, completed: total, failed: 0, blocked: 0,
    successRate: 100, blockedRate: 0, refundRate: 0, latencyP50Ms: 12, latencyP95Ms: 20 } } });
}
beforeEach(() => {
  vi.useFakeTimers();
  profiles = [
    { ...profileA, id: `profile-a-${crypto.randomUUID()}` },
    { ...profileB, id: `profile-b-${crypto.randomUUID()}` },
  ];
  writes = [];
  writeResponse = async () => verdict();
  healthResponse = async () => health(17);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST") {
      const write = { path, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") };
      writes.push(write);
      return writeResponse(write);
    }
    if (path === "/api/v2/admin/generation/model-profiles?limit=100") return Response.json({ ok: true, data: { items: profiles } });
    if (path.endsWith("/health")) return healthResponse(path);
    throw new Error(`Unexpected request ${path}`);
  }));
  container = document.createElement("div");
  container.id = "admin-shell-background";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function mount(locale: "en" | "zh" = "en", canWrite = true) {
  const workspace = navItems.find((item) => item.id === "insights")!;
  const permissions = new Set<AdminPermissionKey>(["generation.config.read"]);
  if (canWrite) permissions.add("generation.config.write");
  await act(async () => root.render(<AdminI18nProvider locale={locale}>{workspace.render({
    permissions,
    canCreateCharacters: false,
    canRead: true,
    workMode: "admin",
    actorId: "configuration-operator",
    view: { kind: "list" },
  })}</AdminI18nProvider>));
  await act(async () => vi.advanceTimersByTimeAsync(1));
}
function button(label: string, scope: ParentNode = document) {
  const item = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!item) throw new Error(`Missing button ${label}`);
  return item;
}
async function select(index: number, label = "Model profile") {
  const selector = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  expect(selector.disabled).toBe(false);
  expect(container.inert).toBe(false);
  await act(async () => { selector.value = profiles[index]!.id; selector.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function confirm(reason = "Controlled configuration validation") {
  await act(async () => button("Configuration check", container).click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(container.inert).toBe(true);
  const input = dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, reason);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Confirm configuration check", dialog).click());
  return dialog;
}
function result(label = "Configuration check") {
  return container.querySelector<HTMLElement>(`[role="region"][aria-label="${label}"]`);
}

describe("Profile Diagnostics configuration receipt", () => {
  it("reloads profiles and the displayed health through shell refresh while retaining the selected profile", async () => {
    await mount();
    await select(0);
    await act(async () => button("Health", container).click());
    healthResponse = async () => health(29);
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/v2/admin/generation/model-profiles?limit=100")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/health"))).toHaveLength(2);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Model profile"]')!.value).toBe(profiles[0]!.id);
    const total = [...container.querySelectorAll("p")].find((item) => item.textContent === "Total")!;
    expect(total.nextElementSibling?.textContent).toBe("29");
    expect(writes).toHaveLength(0);
  });

  it("keeps a configuration confirmation and its command gate intact during shell refresh", async () => {
    await mount();
    await select(0);
    await act(async () => button("Health", container).click());
    await act(async () => button("Configuration check", container).click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const reason = dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(reason, "Retain the pending diagnostic command");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(reason.value).toBe("Retain the pending diagnostic command");
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith("/health"))).toHaveLength(1);
    expect(writes).toHaveLength(0);
    await act(async () => button("Confirm configuration check", dialog).click());
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ reason: "Retain the pending diagnostic command", confirmation: profiles[0]!.id });
    expect(result()?.textContent).toContain("Configuration check pass:");
  });

  it("keeps configuration checks unavailable for a read-only configuration grant while health remains usable", async () => {
    await mount("en", false);
    await select(0);
    const check = button("Configuration check", container);
    expect(check.disabled).toBe(true);
    expect(container.querySelector('[title="generation.config.write"]')).not.toBeNull();
    await act(async () => check.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(writes).toHaveLength(0);
    expect(button("Health", container).disabled).toBe(false);
    await act(async () => button("Health", container).click());
    const total = [...container.querySelectorAll("p")].find((item) => item.textContent === "Total")!;
    expect(total.nextElementSibling?.textContent).toBe("17");
  });

  it("retires an open configuration confirmation when write access is revoked and regranted", async () => {
    await mount();
    await select(0);
    await act(async () => button("Configuration check", container).click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await mount("en", false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await mount();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(writes).toHaveLength(0);
    await select(0);
    await confirm();
    expect(writes).toHaveLength(1);
    expect(result()?.textContent).toContain("Configuration check pass:");
  });

  it("keeps the failed verdict and each returned sample issue visible with the submitted selection context", async () => {
    writeResponse = async () => verdict("fail");
    await mount();
    await select(0);
    await confirm();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("runnerConfig fixture backend is unavailable");
    expect(container.textContent).toContain("pipelineModel must be configured");
    expect(result()?.textContent).toContain("Configuration check fail: 1/2 configuration cases passed. No provider call was made.");
    expect(result()?.textContent).toContain(profiles[0]!.id);
    expect(result()?.textContent).toContain("Fixture image A");
    expect(result()?.textContent).toContain("fixture-image-a");
    expect(result()?.textContent).toContain("Version: 6");
    expect(result()?.textContent).toContain("freeplay");
    expect(result()?.textContent).toContain("landscape");
    expect(writes).toEqual([{ path: `/api/v2/admin/generation/model-profiles/${profiles[0]!.id}/commands/dry-run`,
      body: { reason: "Controlled configuration validation", confirmation: profiles[0]!.id }, key: expect.any(String) }]);
  });

  it("retains the completed result after the transient feedback window without sending another command", async () => {
    await mount();
    await select(0);
    await confirm();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(container.textContent).toContain("Configuration check pass: 2/2 configuration cases passed. No provider call was made.");
    expect(result()?.textContent).toContain("Fixture image A");
    expect(writes).toHaveLength(1);
  });

  it("clears the previous configuration result when the operator selects another profile", async () => {
    await mount();
    await select(0);
    await confirm();
    await select(1);
    expect(result()).toBeNull();
    expect(container.textContent).not.toContain("Configuration check pass:");
    writeResponse = async () => verdict("fail");
    await confirm("Validate the newly selected profile");
    expect(result()?.textContent).toContain(profiles[1]!.id);
    expect(result()?.textContent).not.toContain(profiles[0]!.id);
    expect(result()?.textContent).toContain("Version: 2");
    expect(writes[1]!.body.confirmation).toBe(profiles[1]!.id);
  });

  it("does not put a late health response for A under the normally selectable profile B", async () => {
    let finishA!: (response: Response) => void;
    healthResponse = (path) => path.includes(profiles[0]!.id)
      ? new Promise((resolve) => { finishA = resolve; }) : Promise.resolve(health(17));
    await mount();
    await select(0);
    await act(async () => button("Health", container).click());
    await select(1);
    await act(async () => finishA(health(347)));
    expect(container.textContent).not.toContain("347");
    expect(button("Health", container).disabled).toBe(false);
    await act(async () => button("Health", container).click());
    const total = [...container.querySelectorAll("p")].find((item) => item.textContent === "Total")!;
    expect(total.nextElementSibling?.textContent).toBe("17");
  });

  it("keeps an unknown response explicit and retries only on operator confirmation with the same key", async () => {
    writeResponse = async () => { if (writes.length === 1) throw new TypeError("Controlled unknown response"); return verdict(); };
    await mount();
    await select(0);
    const dialog = await confirm("Keep this reason on explicit retry");
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(result()).toBeNull();
    expect(dialog.querySelector('[role="alert"]')).not.toBeNull();
    expect(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("Keep this reason on explicit retry");
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(writes).toHaveLength(1);
    await act(async () => button("Confirm configuration check", dialog).click());
    expect(writes).toHaveLength(2);
    expect(writes[0]!.key).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(result()?.textContent).toContain("Configuration check pass:");
  });

  it("does not display a success verdict for an answered 503 or incomplete success response", async () => {
    writeResponse = async () => writes.length === 1
      ? Response.json({ ok: false, error: { code: "service_unavailable", message: "Controlled configuration service unavailable" } }, { status: 503 })
      : writes.length === 2 ? Response.json({ ok: true, data: { dryRun: { status: "pass", passed: 2, total: 2 } } }) : verdict();
    await mount();
    await select(0);
    const dialog = await confirm();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(result()).toBeNull();
    expect(container.textContent).not.toContain("Configuration check pass:");
    await act(async () => button("Confirm configuration check", dialog).click());
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(result()).toBeNull();
    expect(container.textContent).not.toContain("Configuration check pass:");
    expect(writes).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(writes).toHaveLength(2);
    await act(async () => button("Confirm configuration check", dialog).click());
    expect(writes).toHaveLength(3);
    expect(writes[0]!.key).toBeTruthy();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[2]).toEqual(writes[0]);
    expect(result()?.textContent).toContain("Configuration check pass:");
  });

  it("renders the retained raw verdict with the current locale without rerunning configuration validation", async () => {
    writeResponse = async () => verdict("fail");
    await mount();
    await select(0);
    await confirm();
    await mount("zh");
    expect(result("配置检查")?.textContent).toContain("配置检查 失败：1/2");
    expect(result("配置检查")?.textContent).toContain("已选配置");
    expect(result("配置检查")?.textContent).toContain("版本: 6");
    expect(result("配置检查")?.textContent).toContain("runnerConfig fixture backend is unavailable");
    await mount();
    expect(result()?.textContent).toContain("Configuration check fail:");
    expect(writes).toHaveLength(1);
  });

  it("does not let a receipt from an unmounted page replace the next page's profile verdict", async () => {
    let finishOld!: (response: Response) => void;
    writeResponse = (write) => write.path.includes(profiles[0]!.id)
      ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(verdict("fail"));
    await mount();
    await select(0);
    await confirm();
    // Actual route navigation unmounts InsightsView; it does not edit the inert background selector.
    await act(async () => root.render(<div>Another admin route</div>));
    await mount();
    await select(1);
    await confirm();
    await act(async () => finishOld(verdict()));
    expect(result()?.textContent).toContain(profiles[1]!.id);
    expect(result()?.textContent).not.toContain(profiles[0]!.id);
    expect(result()?.textContent).toContain("Configuration check fail:");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(writes).toHaveLength(2);
  });
});
