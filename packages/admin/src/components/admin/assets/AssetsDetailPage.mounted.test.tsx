// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentAsset } from "@idream/shared/admin";
import { AssetsSection } from "./AssetsSection";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => <span /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const auditAsset: ContentAsset = {
  id: "audit-asset-a", type: "image", url: "/uploads/audit-asset-a.png", thumbnailUrl: "/uploads/audit-asset-a.png",
  contentType: "image/png", width: 512, height: 512, safetyStatus: "safe", sourceJobId: null,
  isSynthetic: false, customerPublishable: false, publishabilityReasons: [], promptSummary: null,
  metadata: {}, createdAt: "2026-10-05T00:00:00.000Z", platformStatus: "approved", purpose: "campaign",
  targetType: null, targetId: null, tags: ["audit"], description: "Operator description",
  sourceJob: null, sourceBatch: null, placements: [], authorityDependencies: [],
};

describe("AssetsSection detail write authority", () => {
  let root: Root;
  let container: HTMLDivElement;
  let fetchMock: ReturnType<typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;

  beforeEach(() => {
    window.history.replaceState(null, "", `/admin/creative/library/${auditAsset.id}`);
    container = document.createElement("div");
    container.id = "admin-shell-background";
    document.body.append(container);
    root = createRoot(container);
    let currentAsset = auditAsset;
    fetchMock = vi.fn(async (input, init) => {
      expect(new URL(String(input), window.location.origin).pathname).toBe(`/api/v2/admin/assets/${auditAsset.id}`);
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        currentAsset = { ...currentAsset,
          ...(body.tags === undefined ? {} : { tags: body.tags }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.status === undefined ? {} : { platformStatus: body.status }),
        };
      }
      return Response.json({ ok: true, data: { asset: currentAsset } });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(canReview = true) {
    await act(async () => root.render(<AssetsSection canReview={canReview} view={{ kind: "detail", id: auditAsset.id }} />));
  }
  function button(label: string, scope: ParentNode = document) {
    const result = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
    expect(result, `Missing button: ${label}`).toBeDefined();
    return result!;
  }
  function dialog() { return document.querySelector<HTMLDivElement>('[role="dialog"]'); }
  async function waitFor(predicate: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    throw new Error("Expected asset detail state did not appear");
  }
  async function fill(input: HTMLInputElement, text: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("reloads asset details through shell refresh while retaining its metadata and confirmation", async () => {
    await render();
    await waitFor(() => container.textContent?.includes("Operator description") === true);
    const description = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(description, "Unfinished asset description");
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Save", container).click());
    await fill(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Retain this asset reason");
    const confirmation = dialog();
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Unfinished asset description");
    expect(dialog()).toBe(confirmation);
    expect(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("Retain this asset reason");
    await act(async () => finish(Response.json({ ok: true, data: { asset: auditAsset } })));
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Unfinished asset description");
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it.each(["Save", "Archive"])("discards the %s confirmation on review revocation and does not revive its reason after regrant", async (action) => {
    await render();
    await waitFor(() => container.textContent?.includes("Operator description") === true);
    await act(async () => button(action, container).click());
    expect(dialog()).not.toBeNull();
    await fill(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Audit permission boundary");
    if (action === "Archive") await fill(dialog()!.querySelector<HTMLInputElement>('[aria-label="Type the name to confirm"]')!, "audit-as");
    expect(button(action, dialog()!).disabled).toBe(false);
    await render(false);
    expect(dialog()).toBeNull();
    expect([...container.querySelectorAll("button")].some((item) => item.textContent?.trim() === action)).toBe(false);
    await render();
    expect(dialog()).toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    await act(async () => button(action, container).click());
    expect(button(action, dialog()!).disabled).toBe(true);
    expect(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("");
  });

  it("does not let a late pre-revocation save close a new confirmation or refresh over its context", async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { finish = resolve; });
    const initialFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => init?.method === "PATCH" ? response : initialFetch(input, init));
    await render();
    await waitFor(() => container.textContent?.includes("Operator description") === true);
    await act(async () => button("Save", container).click());
    await fill(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Old authorized save");
    await act(async () => button("Save", dialog()!).click());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    await render(false);
    expect(dialog()).toBeNull();
    await render();
    await act(async () => button("Save", container).click());
    await fill(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "New explicitly confirmed save");
    const nextDialog = dialog();
    await act(async () => finish(Response.json({ ok: true, data: { asset: auditAsset } })));
    expect(dialog()).toBe(nextDialog);
    expect(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!.value).toBe("New explicitly confirmed save");
    expect(container.textContent).not.toContain("Saved. Tags and description are searchable for chat reuse now.");
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(1);
  });

  it.each(["Save", "Archive"])("preserves an authorized %s write with its reason, exact target and refreshed result", async (action) => {
    await render();
    await waitFor(() => container.textContent?.includes("Operator description") === true);
    await act(async () => button(action, container).click());
    expect(button(action, dialog()!).disabled).toBe(true);
    await fill(dialog()!.querySelector<HTMLInputElement>('[aria-label="Reason (≥3)"]')!, "Retire or organize audit upload");
    if (action === "Archive") await fill(dialog()!.querySelector<HTMLInputElement>('[aria-label="Type the name to confirm"]')!, "audit-as");
    await act(async () => button(action, dialog()!).click());
    await waitFor(() => dialog() === null && container.querySelector("textarea") !== null);
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(new Headers(writes[0][1]?.headers).get("idempotency-key")).toBeTruthy();
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual(action === "Archive"
      ? { status: "archived", reason: "Retire or organize audit upload", confirmation: auditAsset.id }
      : { tags: ["audit"], description: "Operator description", reason: "Retire or organize audit upload", confirmation: auditAsset.id });
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(2);
    expect(container.textContent).toContain(action === "Archive"
      ? "Archived. audit-as is out of the library and cannot be placed."
      : "Saved. Tags and description are searchable for chat reuse now.");
  });
});
