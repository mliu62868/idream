// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("@/components/admin/api", () => ({ apiGet }));

import { WorkflowsView } from "./WorkflowsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("WorkflowsView diagnostics", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    apiGet.mockReset();
    apiGet.mockImplementation(async (path: string) => path.endsWith("/workflow-1")
      ? {
          workflow: {
            identity: { mode: "reference", maxReferences: 2, acceptedRoles: ["face"], supportsLookReference: true },
            quality: { maxCandidates: 3, evaluatorDimensions: ["identity"] },
            apiPrompt: { "1": { class_type: "Sampler" } },
            comfyWorkflow: { id: "graph-1", name: "Portrait graph" },
          },
        }
      : {
          items: [{
            workflowKey: "workflow-1",
            modelId: "model-1",
            backendKind: "comfyui",
            version: 1,
            capabilities: ["image"],
            inputs: [],
          }],
        });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("loads full workflow authority only on the first expansion", async () => {
    await act(async () => root.render(<WorkflowsView />));
    await waitUntil(() => (container.textContent ?? "").includes("workflow-1"));
    expect(apiGet).toHaveBeenCalledTimes(1);

    const details = [...container.querySelectorAll("details")].find((item) =>
      item.textContent?.includes("Identity, quality, and graph"),
    );
    expect(details).toBeTruthy();
    await toggle(details, true);
    await waitUntil(() => (container.textContent ?? "").includes("Portrait graph"));
    expect(apiGet).toHaveBeenCalledTimes(2);

    await toggle(details, false);
    await toggle(details, true);
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});

async function toggle(details: HTMLDetailsElement | undefined, open: boolean) {
  await act(async () => {
    if (!details) return;
    details.open = open;
    details.dispatchEvent(new Event("toggle", { bubbles: true }));
  });
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw new Error("condition not met");
}
