// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { ToastProvider } from "@/components/admin/ui/Toast";
import { PricingWorkspace } from "./PricingWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Write = { path: string; body: unknown; key: string | null };
let container: HTMLDivElement;
let root: Root;
let writes: Write[];
let writeResponse: () => Promise<Response>;
let draftId: string;
let activeId: string;

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/growth/offers?view=pricing");
  draftId = `pricing-draft-${crypto.randomUUID()}`;
  activeId = `pricing-active-${crypto.randomUUID()}`;
  writes = [];
  writeResponse = async () => Response.json({ ok: true, data: {} });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === "POST" || init?.method === "PATCH") {
      writes.push({ path, body: JSON.parse(String(init.body)), key: new Headers(init.headers).get("idempotency-key") });
      return writeResponse();
    }
    const common = { mode: "image", baseCost: 5, multiplier: 1, effectiveFrom: null, publishedAt: null, archivedAt: null };
    const items = path.startsWith("/api/v2/admin/pricing/rules") ? [
      { ...common, id: draftId, ruleKey: "controlled-draft", label: "Controlled draft", status: "draft", version: 2 },
      { ...common, id: activeId, ruleKey: "controlled-active", label: "Controlled active", status: "active", version: 1 },
    ] : [];
    return Response.json({ ok: true, data: { items, pageInfo: { endCursor: null, hasNextPage: false } } });
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(canWrite: boolean) {
  await act(async () => root.render(<AdminI18nProvider locale="en"><ToastProvider><PricingWorkspace canWrite={canWrite} /></ToastProvider></AdminI18nProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function findButton(label: string, scope: ParentNode = container) {
  return [...scope.querySelectorAll("button")].find((node) => node.textContent === label);
}

async function click(label: string, scope: ParentNode = container) {
  const target = findButton(label, scope);
  if (!target) throw new Error(`Missing ${label} button`);
  await act(async () => target.click());
}

async function fill(label: string, value: string, scope: ParentNode = container) {
  const field = [...scope.querySelectorAll("label")].find((node) => node.firstChild?.textContent === label)?.querySelector("input");
  if (!field) throw new Error(`Missing ${label} field`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Pricing write permission and intent lifecycle", () => {
  it("discards a revoked edit instead of making it writable again on regrant", async () => {
    await render(true);
    await click("Edit");
    const editor = container.querySelector('[aria-labelledby="pricing-edit-title"]')!;
    await fill("Label", "Revoked edit", editor);
    await fill("Base Cost (coins)", "0", editor);
    await render(false);
    await render(true);
    const revived = findButton("Save draft");
    if (revived) await act(async () => revived.click());
    expect(writes).toEqual([]);
    expect(container.querySelector('[aria-labelledby="pricing-edit-title"]')).toBeNull();
    await click("Edit");
    const freshEditor = container.querySelector('[aria-labelledby="pricing-edit-title"]')!;
    const label = [...freshEditor.querySelectorAll("label")].find((node) => node.firstChild?.textContent === "Label")?.querySelector("input");
    expect(label?.value).toBe("Controlled draft");
    await click("Save draft");
    expect(writes).toEqual([expect.objectContaining({ path: `/api/v2/admin/pricing/rules/${draftId}`, body: { label: "Controlled draft", baseCost: 5, multiplier: 1 } })]);
  });

  it.each(["Publish", "Rollback"])("requires fresh confirmation after %s permission is revoked and regranted", async (action) => {
    const name = action === "Publish" ? "Controlled draft" : "Controlled active";
    const id = action === "Publish" ? draftId : activeId;
    await render(true);
    await click(action);
    const dialog = document.querySelector('[role="dialog"]')!;
    await fill("Reason (≥3)", "Revoked price decision", dialog);
    await fill("Type the name to confirm", name, dialog);
    await render(false);
    await render(true);
    const revived = document.querySelector('[role="dialog"]');
    if (revived) await click(action, revived);
    expect(writes).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(action);
    const fresh = document.querySelector('[role="dialog"]')!;
    expect(findButton(action, fresh)?.disabled).toBe(true);
    await fill("Reason (≥3)", "Fresh price decision", fresh);
    await fill("Type the name to confirm", name, fresh);
    await click(action, fresh);
    expect(writes).toEqual([expect.objectContaining({ path: `/api/v2/admin/pricing/rules/${id}/${action.toLowerCase()}`, body: { reason: "Fresh price decision", confirmation: id } })]);
  });

  it("keeps a fresh edit when the pre-revocation save finishes later", async () => {
    let finishOld!: (response: Response) => void;
    writeResponse = () => new Promise((resolve) => { finishOld = resolve; });
    await render(true);
    await click("Edit");
    await click("Save draft");
    expect(writes).toHaveLength(1);
    await render(false);
    await render(true);
    await click("Edit");
    const fresh = container.querySelector('[aria-labelledby="pricing-edit-title"]')!;
    await fill("Label", "Fresh regranted edit", fresh);
    await act(async () => finishOld(Response.json({ ok: true, data: {} })));
    const retained = container.querySelector('[aria-labelledby="pricing-edit-title"]');
    expect(retained).not.toBeNull();
    const label = [...retained!.querySelectorAll("label")].find((node) => node.firstChild?.textContent === "Label")?.querySelector("input");
    expect(label?.value).toBe("Fresh regranted edit");
    expect(findButton("Save draft")?.disabled).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it.each(["Publish", "Rollback"])("keeps a new dialog and query when the pre-revocation %s succeeds later", async (action) => {
    let finishOld!: (response: Response) => void;
    writeResponse = () => new Promise((resolve) => { finishOld = resolve; });
    await render(true);
    await click(action);
    const oldDialog = document.querySelector('[role="dialog"]')!;
    await fill("Reason (≥3)", "Previous price decision", oldDialog);
    await fill("Type the name to confirm", action === "Publish" ? "Controlled draft" : "Controlled active", oldDialog);
    await click(action, oldDialog);
    expect(writes).toHaveLength(1);
    await render(false);
    await render(true);
    await act(async () => {
      window.history.replaceState(null, "", "/admin/growth/offers?view=pricing&pricingSearch=current-scope");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const nextAction = action === "Publish" ? "Rollback" : "Publish";
    await click(nextAction);
    const newDialog = document.querySelector('[role="dialog"]')!;
    await fill("Reason (≥3)", "Current price decision", newDialog);
    await act(async () => finishOld(Response.json({ ok: true, data: {} })));
    expect(document.querySelector('[role="dialog"]')).toBe(newDialog);
    expect(newDialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')?.value).toBe("Current price decision");
    expect(new URL(window.location.href).searchParams.get("pricingSearch")).toBe("current-scope");
    expect(writes).toHaveLength(1);
  });

  it.each(["Save draft", "Publish", "Rollback"])("preserves the restored query when an older %s completes with write permission unchanged", async (action) => {
    window.history.replaceState(null, "", "/admin/growth/offers?view=pricing&pricingSearch=previous-scope");
    let finishOld!: (response: Response) => void;
    writeResponse = () => new Promise((resolve) => { finishOld = resolve; });
    await render(true);
    let scope: ParentNode = container;
    if (action === "Save draft") {
      await click("Edit");
      scope = container.querySelector('[aria-labelledby="pricing-edit-title"]')!;
      await fill("Label", "Previous query edit", scope);
    } else {
      await click(action);
      scope = document.querySelector('[role="dialog"]')!;
      await fill("Reason (≥3)", "Previous query price decision", scope);
      await fill("Type the name to confirm", action === "Publish" ? "Controlled draft" : "Controlled active", scope);
    }
    await click(action, scope);
    expect(writes).toHaveLength(1);
    await act(async () => {
      window.history.replaceState(null, "", "/admin/growth/offers?view=pricing&pricingSearch=restored-scope&pricingStatus=draft&pricingCursor=restored-opaque");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const restoredUrl = window.location.href;
    const searchValue = () => [...container.querySelectorAll("label")].find((node) => node.firstChild?.textContent === "Search prices")?.querySelector<HTMLInputElement>("input")?.value;
    expect(new URL(restoredUrl).searchParams.get("pricingSearch")).toBe("restored-scope");
    expect(new URL(restoredUrl).searchParams.get("pricingCursor")).toBe("restored-opaque");
    expect(searchValue()).toBe("restored-scope");
    await act(async () => finishOld(Response.json({ ok: true, data: {} })));
    expect(window.location.href).toBe(restoredUrl);
    expect(searchValue()).toBe("restored-scope");
    expect(writes).toHaveLength(1);
  });

  it.each(["Save draft", "Publish", "Rollback"])("preserves the input and unknown-outcome idempotency key for a deliberate %s retry", async (action) => {
    let attempts = 0;
    writeResponse = async () => ++attempts === 1
      ? Response.json({ ok: false, error: { code: "upstream_unavailable", message: "Pricing authority temporarily unavailable" } }, { status: 503, headers: { "x-request-id": "pricing-unknown-outcome" } })
      : Response.json({ ok: true, data: {} });
    await render(true);
    let scope: ParentNode = container;
    if (action === "Save draft") {
      await click("Edit");
      scope = container.querySelector('[aria-labelledby="pricing-edit-title"]')!;
      await fill("Label", "Deliberate edit retry", scope);
    } else {
      await click(action);
      scope = document.querySelector('[role="dialog"]')!;
      await fill("Reason (≥3)", "Deliberate price retry", scope);
      await fill("Type the name to confirm", action === "Publish" ? "Controlled draft" : "Controlled active", scope);
    }
    await click(action, scope);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.key).toBeTruthy();
    if (action === "Save draft") {
      expect(container.querySelector('[aria-labelledby="pricing-edit-title"]')).toBe(scope);
      const label = [...scope.querySelectorAll("label")].find((node) => node.firstChild?.textContent === "Label")?.querySelector("input");
      expect(label?.value).toBe("Deliberate edit retry");
    } else {
      expect(document.querySelector('[role="dialog"]')).toBe(scope);
      expect(scope.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')?.value).toBe("Deliberate price retry");
      expect(scope.querySelector<HTMLInputElement>('[aria-label="Type the name to confirm"]')?.value).toBe(action === "Publish" ? "Controlled draft" : "Controlled active");
    }
    await click(action, scope);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
  });
});
