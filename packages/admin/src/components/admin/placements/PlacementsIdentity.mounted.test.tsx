// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlacementsSection } from "@/components/admin/placements/PlacementsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => <a href={href} {...props}>{children}</a> }));
const placement = (id: string) => ({
  id, mediaAssetId: "artwork", slot: "campaign", targetType: "campaign", targetId: id,
  status: "draft", version: 4, publishedAt: null, verificationState: "pending", managedRunId: null,
  canPublish: true, metadata: { eyebrow: "Featured", title: `Campaign ${id}` },
  asset: { id: "artwork", url: "/artwork.png", thumbnailUrl: "/artwork.png" },
});

describe("placement drafts remain bound to their target and write permission", () => {
  let root: Root;
  let container: HTMLDivElement;
  let writes: { path: string; method: string; body: unknown }[];
  beforeEach(() => {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    writes = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (init?.method !== "GET") {
        writes.push({ path, method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: false, error: { code: "FORBIDDEN", message: "Fixture rejected write", requestId: "adversarial-proof" } }, { status: 403 });
      }
      return Response.json({ ok: true, data: { placement: placement(path.split("/").at(-1)!) } });
    }));
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  const render = async (id: string, canPublish = true) => { await act(async () => root.render(<PlacementsSection canPublish={canPublish} view={{ kind: "detail", id }} />)); await waitFor(() => container.textContent?.includes(`Placement ID: ${id}`) === true); };

  it("never sends an old campaign copy to a different placement", async () => {
    await render("campaign-a");
    await act(async () => button(container, "Edit")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Uncommitted A copy");
    await render("campaign-b");
    // If navigation retains an old editor, exercising it must never issue its
    // command against the new target B.
    const save = button(container, "Save changes");
    if (save) {
      await act(async () => save.click());
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      await change(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Correct A campaign");
      await act(async () => button(dialog, "Save changes")!.click());
    }
    expect(writes).toEqual([]);
    expect(container.querySelector('[aria-label="Campaign title"]')).toBeNull();
  });

  it("removes a pending publication confirmation when write permission is revoked", async () => {
    await render("campaign-a");
    await act(async () => button(container, "Publish")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await change(dialog.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Launch campaign");
    await render("campaign-a", false);
    const remaining = document.querySelector<HTMLElement>('[role="dialog"]');
    if (remaining) await act(async () => button(remaining, "Publish")!.click());
    expect(writes).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render("campaign-a");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button(container, "Publish")).toBeDefined();
  });

  it("does not restore an old campaign copy after permission revoke and regrant", async () => {
    await render("campaign-a");
    await act(async () => button(container, "Edit")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Uncommitted A copy");
    await render("campaign-a", false);
    expect(container.querySelector('[aria-label="Campaign title"]')).toBeNull();
    expect(button(container, "Save changes")).toBeUndefined();
    await render("campaign-a");
    expect(container.querySelector('[aria-label="Campaign title"]')).toBeNull();
    await act(async () => button(container, "Edit")!.click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')?.value).toBe("Campaign campaign-a");
    expect(writes).toEqual([]);
  });

  it("discards a canceled campaign copy before opening a new edit", async () => {
    await render("campaign-a");
    await act(async () => button(container, "Edit")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Canceled A copy");
    await act(async () => button(container, "Cancel")!.click());
    expect(container.querySelector('[aria-label="Campaign title"]')).toBeNull();
    await act(async () => button(container, "Edit")!.click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')?.value).toBe("Campaign campaign-a");
    expect(writes).toEqual([]);
  });

  it("guards navigation away from a dirty campaign copy", async () => {
    await render("campaign-a");
    await act(async () => button(container, "Edit")!.click());
    await change(container.querySelector<HTMLInputElement>('[aria-label="Campaign title"]')!, "Unsaved A copy");
    const back = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(link => link.getAttribute("href") === "/admin/creative/placements")!;
    await act(async () => back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Discard unsaved changes?");
    expect(writes).toEqual([]);
  });
});

function button(target: HTMLElement, text: string) { return [...target.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text); }
async function change(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function waitFor(predicate: () => boolean) { for (let i = 0; i < 100; i++) { if (predicate()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); } throw new Error("Mounted adversarial proof did not settle"); }
