// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const { apiWrite } = vi.hoisted(() => ({ apiWrite: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiWrite }));
import { AdminI18nProvider } from "@/components/admin/i18n";
import { GenerationProfileEditor } from "./GenerationProfileEditor";
let host: HTMLDivElement;
let root: Root;
const saved = vi.fn();
const source = { id: "current", profileKey: "campaign-image", label: "Campaign", mode: "image", runner: "comfyui", pipelineModel: "text-image", workflowKey: "text-image", runnerConfig: { capabilities: { textToImage: true } }, status: "active", enabled: true, version: 4, rolloutPercent: 75, dryRunSummary: { passed: true } };
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiWrite.mockReset(); saved.mockReset(); apiWrite.mockResolvedValue({ profile: { id: "saved-draft" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount(editing: boolean) { await act(async () => root.render(<AdminI18nProvider locale="en"><GenerationProfileEditor source={editing ? { ...source, status: "draft", enabled: false } : source} editing={editing} onSaved={saved} onCancel={() => {}} /></AdminI18nProvider>)); }
async function submit() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
it("copies configuration into a disabled replacement draft without publishing evidence", async () => {
  await mount(false); await submit();
  expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/generation/model-profiles", "POST", expect.objectContaining({ profileKey: "campaign-image", workflowKey: "text-image", enabled: false, rolloutPercent: 75, runnerConfig: source.runnerConfig }));
  const body = apiWrite.mock.calls[0][2];
  for (const field of ["dryRunSummary", "status", "version", "id"]) expect(body).not.toHaveProperty(field);
  expect(saved).toHaveBeenCalledWith("saved-draft");
});
it("edits a draft in place without trying to enable it", async () => {
  await mount(true); await submit();
  expect(apiWrite).toHaveBeenCalledWith("/api/v2/admin/generation/model-profiles/current", "PATCH", expect.objectContaining({ profileKey: "campaign-image" }));
  expect(apiWrite.mock.calls[0][2]).not.toHaveProperty("enabled");
});
it("retains the draft and shows validation errors without writing malformed runner JSON", async () => {
  await mount(false);
  await act(async () => {
    const textarea = host.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "invalid json");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await submit();
  expect(apiWrite).not.toHaveBeenCalled();
  expect(host.querySelector("textarea")?.value).toBe("invalid json");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});
