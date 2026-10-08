// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { PricingWorkspace } from "./PricingWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writes: Array<{ path: string; body: unknown }>;
let items: Array<typeof pricingRule>;
const pricingRule = {
  id: "admin-audit-pricing-rule", ruleKey: "admin-audit-price", label: "Controlled pricing draft",
  mode: "image", baseCost: 5, multiplier: 1, status: "draft", version: 2,
  effectiveFrom: null, publishedAt: null, archivedAt: null,
};

beforeEach(() => {
  window.history.replaceState(null, "", "/admin/growth/offers?view=pricing");
  writes = [];
  items = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === "POST" || options?.method === "PATCH") {
      writes.push({ path, body: JSON.parse(String(options.body)) });
      return Response.json({ ok: true, data: {} });
    }
    return Response.json({ ok: true, data: { items: path.startsWith("/api/v2/admin/pricing/rules") ? items : [], pageInfo: { endCursor: null, hasNextPage: false } } });
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

function createButton() {
  const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "Create Draft");
  if (!button) throw new Error("Missing Create Draft button");
  return button;
}

async function fill(label: string, value: string) {
  const field = [...container.querySelectorAll("label")].find((node) => node.firstChild?.textContent === label)?.querySelector("input");
  if (!field) throw new Error(`Missing ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountDraft() {
  await mountWorkspace();
  const summary = [...container.querySelectorAll("summary")].find((node) => node.textContent === "Create Pricing Rule Draft");
  if (!summary) throw new Error("Missing pricing draft disclosure");
  await act(async () => summary.click());
  await fill("Rule Key", "admin-audit-price");
  await fill("Label", "Controlled pricing draft");
  await fill("Reason (≥3)", "Controlled price review");
  await fill("Confirm rule key", "admin-audit-price");
}

async function mountWorkspace() {
  await act(async () => root.render(<AdminI18nProvider locale="en"><PricingWorkspace canWrite /></AdminI18nProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function button(label: string) {
  const target = [...container.querySelectorAll("button")].find((node) => node.textContent === label);
  if (!target) throw new Error(`Missing button ${label}`);
  return target;
}

describe("Pricing draft creation inputs", () => {
  it.each([
    ["Base Cost (coins)", "7.5"],
    ["Base Cost (coins)", "abc"],
    ["Multiplier", "abc"],
  ])("does not create a different price from invalid %s input %s", async (label, input) => {
    await mountDraft();
    await fill(label, input);
    // Click the real control first: the old implementation sends 7, 5, or 1,
    // rather than rejecting the operator's invalid text.
    await act(async () => createButton().click());
    expect(writes).toEqual([]);
    expect(createButton().disabled).toBe(true);
    expect([...container.querySelectorAll("label")].find((node) => node.firstChild?.textContent === label)?.querySelector("input")?.value).toBe(input);
  });

  it("submits a zero-cost draft and a fractional multiplier exactly", async () => {
    await mountDraft();
    await fill("Base Cost (coins)", "0");
    await fill("Multiplier", "1.25");
    expect(createButton().disabled).toBe(false);
    await act(async () => createButton().click());
    expect(writes).toEqual([{ path: "/api/v2/admin/pricing/rules", body: {
      ruleKey: "admin-audit-price", label: "Controlled pricing draft", mode: "image", baseCost: 0,
      multiplier: 1.25, reason: "Controlled price review", confirmation: "admin-audit-price",
    } }]);
  });

  it.each(["Base Cost (coins)", "Multiplier"])("keeps an edit with empty %s unsubmitted and allows an explicit valid price", async (label) => {
    items = [pricingRule];
    await mountWorkspace();
    await act(async () => button("Edit").click());
    await fill(label, "");
    await act(async () => button("Save draft").click());
    expect(writes).toEqual([]);
    expect(button("Save draft").disabled).toBe(true);

    await fill("Base Cost (coins)", "0");
    await fill("Multiplier", "1.25");
    expect(button("Save draft").disabled).toBe(false);
    await act(async () => button("Save draft").click());
    expect(writes).toEqual([{ path: "/api/v2/admin/pricing/rules/admin-audit-pricing-rule", body: {
      label: "Controlled pricing draft", baseCost: 0, multiplier: 1.25,
    } }]);
  });
});
