// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation } = vi.hoisted(() => ({ adminV2Operation: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

import { CharacterBatchImport } from "./CharacterBatchImport";
import {
  CHARACTER_IMPORT_CONCURRENCY,
  CHARACTER_IMPORT_EXAMPLE,
  parseCharacterImport,
  runWithConcurrency,
} from "./character-batch-import";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (name: string, extra: Record<string, unknown> = {}) => ({
  name, age: 30, gender: "female", characterPromise: "A dry nurse", firstMessage: "Long shift?", stableTraits: ["Dark hair"], ...extra,
});

describe("parseCharacterImport", () => {
  it("accepts its own example", () => {
    const parsed = parseCharacterImport(CHARACTER_IMPORT_EXAMPLE);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.rows.every((item) => item.draft !== null)).toBe(true);
  });

  it("reports structural problems without guessing", () => {
    expect(parseCharacterImport("{not json")).toEqual({ ok: false, error: "invalid_json" });
    expect(parseCharacterImport("{}")).toEqual({ ok: false, error: "not_array" });
    expect(parseCharacterImport("[]")).toEqual({ ok: false, error: "empty" });
    expect(parseCharacterImport(JSON.stringify(Array.from({ length: 101 }, () => ({}))))).toEqual({ ok: false, error: "too_many" });
  });

  it("validates each row with the create contract, including the adult age boundary", () => {
    const parsed = parseCharacterImport(JSON.stringify([row("Valid"), row("Young", { age: 17 }), row("", { stableTraits: [] }), "text"]));
    if (!parsed.ok) throw new Error("expected rows");
    expect(parsed.rows[0]?.draft?.persona.name).toBe("Valid");
    expect(parsed.rows[1]?.draft).toBeNull();
    expect(parsed.rows[1]?.errors).toContain("Age must be a whole number from 18 to 120.");
    expect(parsed.rows[2]?.draft).toBeNull();
    expect(parsed.rows[2]?.errors).toEqual(expect.arrayContaining(["Enter a character name.", "Add at least one feature that never changes."]));
    expect(parsed.rows[3]?.errors).toEqual(["This row must be an object."]);
  });

  it("defaults what the wizard defaults and accepts the nested API shape", () => {
    const parsed = parseCharacterImport(JSON.stringify([{
      persona: { name: "Nested", age: 25, gender: "male", characterPromise: "A quiet owner", firstMessage: "Hello.", detailsMarkdown: "" },
      visualDirection: { stableTraits: ["Glasses"], style: "anime" },
    }]));
    if (!parsed.ok) throw new Error("expected rows");
    expect(parsed.rows[0]?.draft?.visualDirection).toMatchObject({ identityAnchor: "A quiet owner", style: "anime" });
  });
});

describe("runWithConcurrency", () => {
  it("never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    await runWithConcurrency(Array.from({ length: 12 }, (_, index) => index), CHARACTER_IMPORT_CONCURRENCY, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    expect(peak).toBe(CHARACTER_IMPORT_CONCURRENCY);
  });
});

describe("CharacterBatchImport", () => {
  let container: HTMLDivElement;
  let root: Root;
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const button = (text: string) => [...dialog().querySelectorAll("button")].find((node) => node.textContent?.includes(text))!;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Operation.mockReset();
    await act(async () => root.render(<CharacterBatchImport />));
    await act(async () => container.querySelector("button")!.click());
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function paste(value: unknown) {
    const area = dialog().querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(area, JSON.stringify(value));
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("creates only the valid rows, as private draft requests, then retries just the failure with the same intent", async () => {
    adminV2Operation.mockImplementation(async (_id: string, options: { body: { persona: { name: string } } }) => {
      if (options.body.persona.name === "Flaky" && adminV2Operation.mock.calls.filter(([, call]) => call.body.persona.name === "Flaky").length === 1) {
        throw new Error("offline");
      }
      return { deepLink: `/admin/characters/${options.body.persona.name}?tab=assets` };
    });
    await paste([row("Good"), row("Bad", { age: 12 }), row("Flaky")]);
    expect(dialog().textContent).toContain("2 of 3 rows are ready");
    await act(async () => button("Create 2 private drafts").click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(adminV2Operation).toHaveBeenCalledTimes(2);
    expect(adminV2Operation.mock.calls[0]?.[0]).toBe("POST /api/v2/admin/characters");
    expect(adminV2Operation.mock.calls[0]?.[1].body).toMatchObject({ confirmation: "CREATE CHARACTER", reason: { code: "character_batch_import" } });
    expect(dialog().querySelector('a[href="/admin/characters/Good?tab=assets"]')).not.toBeNull();

    await act(async () => button("Retry 1 rows").click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const flaky = adminV2Operation.mock.calls.filter(([, call]) => call.body.persona.name === "Flaky");
    expect(flaky).toHaveLength(2);
    expect(flaky[1]?.[1].intent).toBe(flaky[0]?.[1].intent);
    expect(adminV2Operation.mock.calls.filter(([, call]) => call.body.persona.name === "Good")).toHaveLength(1);
    expect(dialog().textContent).toContain("2 created");
  });
});
