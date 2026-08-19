// @vitest-environment happy-dom

// SPEC: 停一个线上实验此前是"点一下就停"，审计里留下的是机器写死的英文
//       `stop from Admin experiment workspace`。本用例锁住：点按钮不写、必须确认、
//       且进审计的 reason 是运营手打的那句。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperimentsView } from "./ExperimentsView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const runningExperiment = {
  id: "experiment-1",
  key: "community.character-ranking.v1",
  version: 2,
  hypothesis: "Relationship-first ranking increases qualified conversations",
  eligibility: {},
  variants: [
    { key: "control", allocationBps: 5_000 },
    { key: "relationship_first", allocationBps: 5_000 },
  ],
  metrics: {
    primary: "relationship.qce_activation.v1",
    controlVariant: "control",
    minimumMaturePerArm: 100,
    guardrails: [],
  },
  status: "running",
  stateVersion: 7,
};

describe("ExperimentsView lifecycle commands", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("requires a confirmation and carries the operator's own reason into the audit payload", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/commands/stop")) {
        return Response.json({ ok: true, data: { experiment: runningExperiment } });
      }
      if (path.includes("/flag-monitoring")) {
        return Response.json({ ok: true, data: { items: [] } });
      }
      return Response.json({ ok: true, data: { items: [runningExperiment] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(<ExperimentsView />);
    });
    await waitFor(() => container.textContent?.includes("community.character-ranking.v1") ?? false);

    const stop = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Stop",
    );
    expect(stop).toBeDefined();

    await act(async () => {
      stop?.click();
    });
    expect(stopCalls(fetchMock)).toHaveLength(0);

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // 后果必须在敲确认串之前就读得到，且说清楚不可逆（management.ts:158 —— stopped 回不到 running）。
    expect(dialog?.textContent).toContain("cannot be restarted");
    expect(dialog?.textContent).toContain("needs a new version");

    const inputs = Array.from(dialog?.querySelectorAll("input") ?? []);
    expect(inputs).toHaveLength(2);
    await changeInput(inputs[0], "guardrail regression on support contacts");
    await changeInput(inputs[1], "community.character-ranking.v1");

    await act(async () => {
      dialogButton(dialog, "Stop")?.click();
    });
    await waitFor(() => stopCalls(fetchMock).length === 1);

    const body = JSON.parse(String(stopCalls(fetchMock)[0][1]?.body));
    expect(body).toMatchObject({
      expectedStateVersion: 7,
      reason: "guardrail regression on support contacts",
    });
    expect(body.reason).not.toContain("Admin experiment workspace");
  });
});

function stopCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes("/commands/stop")) as [
    string,
    RequestInit | undefined,
  ][];
}

function dialogButton(dialog: HTMLElement | null, label: string) {
  return Array.from(dialog?.querySelectorAll("button") ?? []).find(
    (button) => button.textContent?.trim() === label,
  );
}

async function changeInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Condition did not become true");
}
