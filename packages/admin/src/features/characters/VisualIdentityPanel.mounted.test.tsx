// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation, apiWrite } = vi.hoisted(() => ({ adminV2Operation: vi.fn(), apiWrite: vi.fn() }));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
vi.mock("@/components/admin/api", () => ({ apiWrite }));
vi.mock("./VisualIdentityExperimentWorkbench", () => ({ VisualIdentityExperimentWorkbench: () => null }));
vi.mock("next/image", () => ({ default: ({ alt = "" }: { alt?: string }) => <span data-image-alt={alt} /> }));
vi.mock("@/components/admin/i18n", () => {
  const context = { t: (value: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((text, [key, replacement]) => text.replaceAll(`{${key}}`, String(replacement)), value) };
  return { useAdminI18n: () => context, AdminText: ({ text }: { text: string }) => <>{text}</> };
});

import { VisualIdentityPanel, type VisualIdentityPanelData } from "./VisualIdentityPanel";
import { characterWorkspaceDetail } from "./character-workspace-fixture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asset = (id: string): VisualIdentityPanelData["visual"]["anchors"][number] => ({ mediaAssetId: id, role: "identity_anchor", available: true, url: `/${id}.webp`, thumbnailUrl: null, qualityScore: null, identityScore: null });
const data = characterWorkspaceDetail({ visual: {
  activeIdentity: {
    id: "identity-1", version: 1, status: "active", style: "realistic", identityPrompt: "Original identity prompt", negativeIdentityPrompt: "", defaultSeed: "42",
    traits: { face: {}, hair: {}, body: {}, signature: {}, style: {} }, immutableHash: "identity-hash", evidenceState: "candidate", anchorAssetIds: ["anchor-1"], createdFrom: "admin_passport_edit", createdAt: "2026-07-12T12:00:00.000Z",
  },
  anchors: [asset("anchor-1"), asset("anchor-2")],
  activeReferenceSet: { id: "references-1", revision: 1, status: "active", selectorVersion: "test", snapshotHash: "references-hash", references: [asset("anchor-1")], createdFrom: "test", createdAt: "2026-07-12T12:00:00.000Z" },
} });

describe("Visual identity drafts", () => {
  let container: HTMLDivElement;
  let root: Root;
  let actorId: string;
  let sequence = 0;
  const runCommittedMutation = vi.fn(async ({ commit, afterRefresh }) => {
    const result = await commit();
    afterRefresh?.();
    return { result, refreshed: true };
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    actorId = `visual-draft-test-${++sequence}`;
    window.sessionStorage.clear();
    adminV2Operation.mockReset().mockResolvedValue({});
    apiWrite.mockReset().mockResolvedValue({});
    runCommittedMutation.mockClear();
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(next: VisualIdentityPanelData = data, canWrite = true) {
    await act(async () => root.render(<VisualIdentityPanel actorId={actorId} data={next} permissions={{ writeVisual: canWrite, evaluateRoute: false }} runCommittedMutation={runCommittedMutation} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  function reference(id: string) {
    return [...container.querySelectorAll("label")].find((label) => label.textContent?.includes(id))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  }
  function input(label: string) {
    return [...container.querySelectorAll("label")].find((node) => node.textContent?.startsWith(label))!.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea")!;
  }
  async function type(label: string, value: string) {
    const field = input(label);
    await act(async () => {
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!;
  }

  it("preserves edited references through an unchanged authority refresh", async () => {
    await render();
    await act(async () => reference("anchor-2").click());
    expect(reference("anchor-2").checked).toBe(true);
    await render(structuredClone(data));
    expect(reference("anchor-2").checked).toBe(true);
    expect(container.textContent).toContain("2 of 2 images selected");
    expect(container.textContent).toContain("Unsaved draft");
  });

  it("restores identity and reference edits after leaving and returning to the panel", async () => {
    await render();
    await type("Identity lock", "My unsaved identity description");
    await act(async () => reference("anchor-2").click());
    await act(async () => root.render(null));
    await render();
    expect(input("Identity lock").value).toBe("My unsaved identity description");
    expect(reference("anchor-2").checked).toBe(true);
  });

  it("keeps stale drafts visible and blocks publication until explicitly discarded", async () => {
    await render();
    await type("Identity lock", "My unsaved identity description");
    await type("Change reason", "Identity refinement");
    await act(async () => input("Activate this as a new identity version.").click());
    await act(async () => reference("anchor-2").click());
    await type("Publication reason", "Reference refinement");
    await act(async () => input("Publish a new immutable reference snapshot").click());
    const next = structuredClone(data);
    next.visual.activeIdentity = { ...next.visual.activeIdentity!, id: "identity-2", version: 2, identityPrompt: "New authority prompt" };
    await render(next);
    expect(input("Identity lock").value).toBe("My unsaved identity description");
    expect(reference("anchor-2").checked).toBe(true);
    expect(container.textContent).toContain("Draft is based on an older version");
    expect(button("Create & activate version").disabled).toBe(true);
    expect(button("Publish Reference Set").disabled).toBe(true);
    await act(async () => button("Discard draft").click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((node) => node.textContent?.trim() === "Discard draft")!;
    await act(async () => confirm.click());
    expect(input("Identity lock").value).toBe("New authority prompt");
    expect(reference("anchor-2").checked).toBe(false);
    expect(container.textContent).not.toContain("Unsaved draft");
    expect(adminV2Operation).not.toHaveBeenCalled();
    expect(apiWrite).not.toHaveBeenCalled();
  });

  it("does not discard unfinished identity text after publishing references", async () => {
    await render();
    await type("Identity lock", "My unfinished identity description");
    await act(async () => reference("anchor-2").click());
    await type("Publication reason", "Reference refinement");
    await act(async () => input("Publish a new immutable reference snapshot").click());
    await act(async () => button("Publish Reference Set").click());
    expect(adminV2Operation).toHaveBeenCalledTimes(1);
    expect(input("Identity lock").value).toBe("My unfinished identity description");
    expect(container.textContent).toContain("Unsaved draft");
  });

  it("submits the identity draft's baseline pin and retains its text after a concurrency rejection", async () => {
    await render();
    await type("Identity lock", "My unsaved identity description");
    await type("Change reason", "Identity refinement");
    await act(async () => input("Activate this as a new identity version.").click());
    apiWrite.mockRejectedValueOnce(new Error("The active Visual Identity changed before this edit was saved."));
    await act(async () => button("Create & activate version").click());
    expect(apiWrite).toHaveBeenCalledWith(expect.any(String), "POST", expect.objectContaining({
      expectedActiveIdentityId: "identity-1", expectedActiveIdentityVersion: 1, identityPrompt: "My unsaved identity description",
    }));
    expect(input("Identity lock").value).toBe("My unsaved identity description");
    expect(container.textContent).toContain("Unsaved draft");
    expect(container.textContent).toContain("The active Visual Identity changed");
  });

  it("makes reference selection read-only without visual write permission", async () => {
    await render(data, false);
    expect(reference("anchor-1").disabled).toBe(true);
    expect(reference("anchor-2").disabled).toBe(true);
  });
});
