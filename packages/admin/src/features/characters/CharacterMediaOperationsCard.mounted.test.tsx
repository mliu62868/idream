// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { characterMediaOperationsProjectionSchema } from "@idream/shared/admin";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/admin/i18n", () => ({
  AdminText: ({ children }: { children: unknown }) => children,
  adminDateLocale: () => undefined,
  useAdminI18n: () => ({
    locale: "en" as const,
    t: (value: string) => value,
  }),
}));

import { CharacterMediaOperationsCard } from "./CharacterMediaOperationsCard";

const requestId = "voice-request-expired-1";
const confirmation = `RECLAIM VOICE ${requestId}`;
const unavailable = (modality: "image" | "video", tab: string) => ({
  modality,
  requestId: null,
  status: null,
  attempt: null,
  provider: null,
  timing: null,
  costDreamcoins: null,
  output: null,
  recoverability: {
    state: "unavailable" as const,
    reason: "No operation evidence exists for this Character.",
  },
  studioHref: `/admin/characters/character-1?tab=${tab}`,
  operationsHref: null,
});
const projection = characterMediaOperationsProjectionSchema.parse({
  projectionVersion: 1,
  asOf: "2026-08-02T05:00:00.000Z",
  operations: [
    unavailable("image", "assets"),
    unavailable("video", "video"),
    {
      modality: "voice",
      requestId,
      status: "running",
      attempt: {
        id: null,
        number: 3,
        status: "running",
        errorCode: null,
        retryability: null,
        operatorGuidance: null,
      },
      provider: { key: "fish_audio", requestId: null },
      timing: {
        requestedAt: "2026-08-02T04:00:00.000Z",
        startedAt: "2026-08-02T04:00:01.000Z",
        finishedAt: null,
        latencyMs: null,
      },
      costDreamcoins: null,
      output: null,
      recoverability: {
        state: "operator_action",
        reason: "The Voice synthesis lease expired.",
        actionHref:
          `/api/v2/admin/characters/character-1/voice-clips/${requestId}/commands/reclaim`,
        actionConfirmation: confirmation,
      },
      studioHref: "/admin/characters/character-1?tab=voice",
      operationsHref: null,
    },
  ],
});

describe("Character Voice reclaim confirmation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  it("opens a typed confirmation gate and submits the operator reason", async () => {
    const onReclaimVoice = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <CharacterMediaOperationsCard
          canReclaimVoice
          onReclaimVoice={onReclaimVoice}
          projection={projection}
        />,
      );
    });

    const open = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Reclaim Voice request")
    );
    expect(open).toBeTruthy();
    await act(async () => open?.click());
    expect(onReclaimVoice).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(requestId);
    expect(document.body.textContent).toContain("Attempt 3");
    expect(document.body.textContent).toContain("fish_audio");
    expect(document.body.textContent).toContain(
      "reuses the pinned provider request and idempotency key",
    );

    const reason = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Operational reason (≥3)"]',
    );
    const target = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Type the projected Voice reclaim confirmation"]',
    );
    expect(reason).toBeTruthy();
    expect(target).toBeTruthy();
    await act(async () => {
      setInput(reason!, "Recover after verified worker crash");
      setInput(target!, confirmation);
    });
    const submit = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Reclaim Voice request") &&
        button !== open,
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => submit?.click());
    await waitUntil(() => onReclaimVoice.mock.calls.length === 1);
    // SPEC: 投影里的 actionHref 只回答「这条请求可不可以由运营回收」；回收走哪条路由由
    //       manifest 决定，不再从投影里读回来当 URL 用。
    expect(onReclaimVoice).toHaveBeenCalledWith({
      requestId,
      confirmation,
      reason: "Recover after verified worker crash",
    });
  });

  // 「Retry available」此前是一行没有去处的字：只有 voice 能就地回收（契约 superRefine
  // 禁止非 voice 投递 actionHref），图片/视频的重跑在运维作业队列里。
  it("points a retryable image run at the operations queue", async () => {
    const retryable = characterMediaOperationsProjectionSchema.parse({
      ...projection,
      operations: [
        {
          ...projection.operations[0],
          requestId: "image-job-1",
          status: "failed",
          recoverability: {
            state: "retryable",
            reason: "The provider rejected the request and the job is retryable.",
            actionHref: null,
            actionConfirmation: null,
          },
          operationsHref: "/admin/ops/jobs?view=dead-letter&search=image-job-1",
        },
        projection.operations[1],
        projection.operations[2],
      ],
    });

    await act(async () => {
      root.render(<CharacterMediaOperationsCard projection={retryable} />);
    });

    const requeue = [...container.querySelectorAll("a")].find((link) =>
      link.textContent?.includes("Requeue in operations")
    );
    expect(requeue?.getAttribute("href")).toBe(
      "/admin/ops/jobs?view=dead-letter&search=image-job-1",
    );
  });
});

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reclaim");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
