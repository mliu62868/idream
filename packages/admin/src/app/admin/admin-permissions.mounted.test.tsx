// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin/permissions";
import type { ContentAsset } from "@idream/shared/admin";
import { AdminConsoleClient } from "@/components/admin/AdminConsoleClient";
import { DEFAULT_ADMIN_SHELL_PREFERENCES } from "@/components/admin/shell-preferences";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("next/image", () => ({ default: () => <span /> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const review: AdminPermissionKey[] = ["admin.approval.review"];
const signals = {
  environment: "test" as const, dataClass: "fixture" as const, fixtureState: "included" as const,
  productTimezone: "UTC", freshness: { state: "reported" as const, label: "2026-10-25T00:00:00Z" },
};
const approval = {
  id: "approval-permission-test", action: "audit.fixture.read_only", permissionKey: "dashboard.read",
  targetType: "audit_fixture", targetId: "fixture", requestedById: "another-operator", approvedById: null,
  reason: "Read-only fixture", payload: {}, status: "pending", createdAt: "2026-10-25T00:00:00Z", decidedAt: null,
};
const asset: ContentAsset = {
  id: "asset-permission-test", type: "image", url: "/uploads/permission.png", thumbnailUrl: "/uploads/permission.png",
  contentType: "image/png", width: 512, height: 512, safetyStatus: "safe", sourceJobId: null,
  isSynthetic: false, customerPublishable: false, publishabilityReasons: [], promptSummary: null, metadata: {},
  createdAt: "2026-10-25T00:00:00Z", platformStatus: "approved", purpose: "campaign", targetType: null,
  targetId: null, tags: [], description: "Retained readable asset", sourceJob: null, sourceBatch: null,
  placements: [], authorityDependencies: [],
};
function bootstrap(permissions: AdminPermissionKey[]) {
  return Response.json({ ok: true, data: { bootstrap: {
    actor: { id: "operator-1", role: "admin" }, permissions, canReadDashboard: false, canCreateCharacters: false,
    devLogin: { enabled: false, accounts: [] }, shellSignals: signals,
  } } });
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
function button(label: string, scope: ParentNode = document) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}; page: ${document.body.textContent}`);
  return result;
}
async function click(node: HTMLElement) { await act(async () => node.click()); }
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("shell permission authority through actual workspace HTTP requests", () => {
  let root: Root;
  let container: HTMLDivElement;
  let bootstrapRead: () => Promise<Response>;
  let write: () => Promise<Response>;
  let bootstrapCalls: number;
  let listReads: number;
  let writes: number;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/system/approvals");
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    bootstrapCalls = listReads = writes = 0;
    bootstrapRead = async () => bootstrap([]);
    write = async () => Response.json({ ok: false, error: {
      code: "forbidden", message: "Missing admin permission", details: { permission: "admin.approval.review" },
    } }, { status: 403 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/v2/admin/bootstrap") { bootstrapCalls += 1; return bootstrapRead(); }
      if (init?.method === "POST" && (url.endsWith("/approve") || url.endsWith("/assets/bulk"))) { writes += 1; return write(); }
      if (url.startsWith("/api/v2/admin/approvals?")) {
        listReads += 1;
        return Response.json({ ok: true, data: { items: [approval], pageInfo: { endCursor: null, hasNextPage: false } } });
      }
      if (url.endsWith("/assets/bulk/preflight")) return Response.json({ ok: true, data: { assetIds: [asset.id], blockers: [] } });
      if (url.startsWith("/api/v2/admin/assets?")) return Response.json({ ok: true, data: {
        items: [asset], pageInfo: { endCursor: null, hasNextPage: false, totalCount: 1 },
      } });
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  async function mount(permissions = review, section = "system/approvals") {
    await act(async () => root.render(<AdminConsoleClient actor={{ id: "operator-1", role: "admin" }}
      initialAccess initialPermissions={permissions} initialSection={section}
      preferences={DEFAULT_ADMIN_SHELL_PREFERENCES} shellSignals={signals} />));
    const label = section === "system/approvals" ? "Approve" : "Select page";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ([...container.querySelectorAll("button")].some(node => node.textContent === label)) break;
      await settle();
    }
    expect(button(label)).toBeDefined();
  }
  async function confirm() {
    await click(button("Approve"));
    const dialog = document.querySelector('[role="dialog"]')!;
    const inputs = dialog.querySelectorAll<HTMLInputElement>("input");
    await enter(inputs[0]!, "Verify current permission");
    await enter(inputs[1]!, approval.id);
    await click(button("Confirm", dialog));
  }

  it("retires a rejected confirmation before the new permission snapshot returns", async () => {
    const pending = deferred();
    bootstrapRead = () => pending.promise;
    await mount();
    await confirm();
    expect(writes).toBe(1);
    expect(bootstrapCalls).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="admin-section-permission-denied"]')).not.toBeNull();
    await act(async () => pending.resolve(bootstrap([])));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(writes).toBe(1);
  });

  it("refreshes permissions before workspace data and removes revoked navigation", async () => {
    await mount();
    const readsBefore = listReads;
    await click(button("Refresh"));
    await settle();
    expect(bootstrapCalls).toBe(1);
    expect(listReads).toBe(readsBefore);
    expect(document.querySelector('[data-testid="admin-section-permission-denied"]')).not.toBeNull();
    expect(document.querySelector('aside a[href="/admin/system/approvals"]')).toBeNull();
  });

  it("retires the rejected intent even if a fast bootstrap already sees regranted permission", async () => {
    bootstrapRead = async () => bootstrap(review);
    await mount();
    await confirm();
    expect(bootstrapCalls).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await settle();
    expect(button("Approve")).toBeDefined();
    expect(writes).toBe(1);
  });

  it("ignores an older grant response after a newer permission refresh denied access", async () => {
    const older = deferred();
    const newer = deferred();
    bootstrapRead = () => bootstrapCalls === 1 ? older.promise : newer.promise;
    await mount();
    await click(button("Refresh"));
    await click(button("Refresh"));
    expect(bootstrapCalls).toBe(2);
    await act(async () => newer.resolve(bootstrap([])));
    expect(document.querySelector('[data-testid="admin-section-permission-denied"]')).not.toBeNull();
    await act(async () => older.resolve(bootstrap(review)));
    expect(document.querySelector('[data-testid="admin-section-permission-denied"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["network", "malformed", "unauthorized"])("fails closed on a %s permission refresh and requires a fresh intent after retry", async (failure) => {
    bootstrapRead = async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "unauthorized") return Response.json({ ok: false, error: { code: "unauthorized", message: "Session expired" } }, { status: 401 });
      return Response.json({ ok: true, data: { bootstrap: { permissions: review } } });
    };
    await mount();
    await click(button("Refresh"));
    await settle();
    expect(bootstrapCalls).toBe(1);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect([...document.querySelectorAll("button")].some(node => node.textContent === "Approve")).toBe(false);
    bootstrapRead = async () => bootstrap(review);
    await click(button("Refresh"));
    await settle();
    expect(bootstrapCalls).toBe(2);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Approve")).toBeDefined();
    expect(writes).toBe(0);
    await click(button("Approve"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("retains a business-policy rejection when fresh permissions are unchanged", async () => {
    bootstrapRead = async () => bootstrap(review);
    write = async () => Response.json({ ok: false, error: {
      code: "forbidden", message: "Approval is unbound, expired, or invalid; request a new approval",
      details: { recovery: "request_new_approval", action: "billing.ledger.adjust", targetId: "user-7" },
    } }, { status: 403 });
    await mount();
    await confirm();
    expect(bootstrapCalls).toBe(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("This approval must be requested again.");
    expect(writes).toBe(1);
  });

  it("retires an asset archive and selection through a real 403 while preserving allowed reads", async () => {
    window.history.replaceState(null, "", "/admin/creative/library");
    const allowed: AdminPermissionKey[] = ["creative.asset.read", "content.asset.review"];
    const pending = deferred();
    bootstrapRead = () => pending.promise;
    write = async () => Response.json({ ok: false, error: {
      code: "forbidden", message: "Missing admin permission", details: { permission: "content.asset.review" },
    } }, { status: 403 });
    await mount(allowed, "creative/library");
    await click(button("Select page"));
    await click(button("Archive selected"));
    const dialog = document.querySelector('[role="dialog"]')!;
    await enter(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Retire fixture");
    await enter(dialog.querySelector<HTMLInputElement>('[aria-label="Paste exact asset IDs to confirm"]')!, asset.id);
    await click(button("Archive selected", dialog));
    expect(writes).toBe(1);
    expect(bootstrapCalls).toBe(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain(asset.id);
    expect(container.querySelector('[aria-label="Bulk archive"]')).toBeNull();
    await act(async () => pending.resolve(bootstrap(["creative.asset.read"])));
    bootstrapRead = async () => bootstrap(allowed);
    await click(button("Refresh"));
    await settle();
    expect(container.textContent).toContain("0 selected");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(button("Select page"));
    await click(button("Archive selected"));
    const fresh = document.querySelector('[role="dialog"]')!;
    expect(fresh.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("");
    expect(button("Archive selected", fresh).disabled).toBe(true);
    expect(writes).toBe(1);
  });
});
