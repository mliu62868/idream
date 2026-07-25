// @vitest-environment happy-dom

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", () => ({ adminV2Request }));

import { VisualIdentityExperimentWorkbench } from "./VisualIdentityExperimentWorkbench";

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for visual identity experiment");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextAreaValue(input: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const run = {
  id: "identity-run-1",
  purpose: "identity_calibration",
  createdAt: "2026-07-24T12:00:00.000Z",
  executionOutcome: "succeeded",
  counts: { total: 1 },
};

const runDetail = {
  ...run,
  version: 2,
  reviewContext: {
    orientation: "4:5",
    experiment: {
      mode: "text_to_image",
      positivePrompt: "Controlled identity portrait",
      negativePrompt: "different person",
      seedStrategy: "locked",
      baseSeed: "42",
      sourceAssetId: null,
      strength: 0.65,
    },
  },
  items: [{
    id: "identity-item-1",
    ordinal: 0,
    executionState: "ready",
    asset: {
      id: "identity-asset-1",
      url: "/identity-candidate.webp",
      thumbnailUrl: null,
    },
    review: {
      id: "identity-review-1",
      decision: "approved",
      identityConsistency: "unscored",
      score: null,
      quality: {
        artifactFree: true,
        singleSubject: true,
        intentMatch: true,
        noVisibleText: true,
      },
      reason: "Chosen identity definition",
    },
    lineage: { seed: "42" },
  }],
};

const data = {
  character: {
    id: "character-1",
    name: "Mira",
    style: "realistic",
    imageUrl: "/mira-current.webp",
  },
  visual: {
    activeIdentity: {
      id: "identity-v1",
      version: 1,
      identityPrompt: "Current Mira identity",
      negativeIdentityPrompt: "different person",
      defaultSeed: "7",
    },
    anchors: [{
      mediaAssetId: "identity-current-asset",
      role: "identity_anchor",
      available: true,
      url: "/mira-current.webp",
      thumbnailUrl: null,
    }],
    references: [],
    activeReferenceSet: null,
    identityCalibration: {
      blocker: null,
      profiles: [{
        profileKey: "identity-profile",
        profileVersion: 1,
        label: "Identity profile",
        workflowKey: "identity-workflow",
        workflowVersion: 1,
        orientation: "4:5",
        allowedOrientations: ["4:5"],
        modes: ["text_to_image", "image_to_image"],
        recommended: true,
      }],
    },
  },
} as unknown as CharacterWorkspaceDetail;

describe("Visual Identity experiment activation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) return runDetail;
      throw new Error(`Unexpected request: ${path}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("turns a reviewed candidate into an explicit activation command", async () => {
    const onActivateCandidate = vi.fn(async () => undefined);
    await act(async () => root.render(
      <VisualIdentityExperimentWorkbench
        canActivate
        canCreate
        canReview
        data={data}
        onActivateCandidate={onActivateCandidate}
      />,
    ));
    await waitUntil(() =>
      container.textContent?.includes("激活为新视觉身份") === true
    );
    const open = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("激活为新视觉身份"));
    await act(async () => open?.click());

    const activationPanel = [...container.querySelectorAll("div")]
      .find((element) =>
        element.querySelector("h4")?.textContent === "激活新的视觉身份版本"
      );
    expect(activationPanel).toBeDefined();
    const labels = [...activationPanel!.querySelectorAll("label")];
    const reason = labels
      .find((label) => label.textContent?.includes("激活理由"))
      ?.querySelector<HTMLInputElement>("input");
    const faceTraits = labels
      .find((label) => label.textContent?.includes("脸部稳定特征"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const hairTraits = labels
      .find((label) => label.textContent?.includes("头发稳定特征"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const bodyTraits = labels
      .find((label) => label.textContent?.includes("身形稳定特征"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const confirmed = labels
      .find((label) => label.textContent?.includes("我确认这段文字只描述人物身份"))
      ?.querySelector<HTMLInputElement>("input");
    expect(reason).toBeDefined();
    expect(faceTraits).toBeDefined();
    expect(hairTraits).toBeDefined();
    expect(bodyTraits).toBeDefined();
    expect(confirmed).toBeDefined();
    await act(async () => {
      if (reason) {
        setInputValue(reason, "Adopt the reviewed identity candidate");
      }
      if (faceTraits) setTextAreaValue(faceTraits, "oval face\nblue eyes");
      if (hairTraits) setTextAreaValue(hairTraits, "dark wavy hair");
      if (bodyTraits) {
        setTextAreaValue(bodyTraits, "balanced adult proportions");
      }
      confirmed?.click();
    });
    const confirm = [...activationPanel!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("确认激活新身份"));
    expect(confirm).toBeDefined();
    expect(confirm?.disabled).toBe(false);
    await act(async () => confirm?.click());
    await waitUntil(() => onActivateCandidate.mock.calls.length === 1);

    expect(onActivateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      identityPrompt: expect.stringContaining(
        "Preserve the exact same adult person shown in the canonical identity portrait",
      ),
      faceTraits: {
        canonicalPortraitAuthority: true,
        stableTraits: ["oval face", "blue eyes"],
      },
      hairTraits: { stableTraits: ["dark wavy hair"] },
      bodyTraits: { stableTraits: ["balanced adult proportions"] },
      confirmation: "character-1:visual-profile",
      candidateAuthority: {
        runId: "identity-run-1",
        itemId: "identity-item-1",
        assetId: "identity-asset-1",
        reviewDecisionId: "identity-review-1",
      },
    }));
  });

  it("records each visible quality judgment before accepting an identity candidate", async () => {
    let reviewPosted = false;
    adminV2Request.mockImplementation(async (
      path: string,
      options?: { method?: string },
    ) => {
      if (options?.method === "POST") {
        reviewPosted = true;
        return {};
      }
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) {
        return {
          ...runDetail,
          items: runDetail.items.map((item) => ({
            ...item,
            review: reviewPosted ? item.review : null,
          })),
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await act(async () => root.render(
      <VisualIdentityExperimentWorkbench
        canActivate
        canCreate
        canReview
        data={data}
        onActivateCandidate={vi.fn(async () => undefined)}
      />,
    ));
    await waitUntil(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .some((button) =>
          button.textContent?.includes("提交候选身份") &&
          !button.disabled
        )
    );
    const open = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("提交候选身份"));
    expect(open?.disabled).toBe(false);
    await act(async () => open?.click());
    await waitUntil(() =>
      container.textContent?.includes("确认候选身份评审") === true
    );

    const panel = [...container.querySelectorAll("div")]
      .find((element) =>
        element.querySelector("h4")?.textContent === "确认候选身份评审"
      );
    expect(panel).toBeDefined();
    const reason = [...panel!.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("决策理由"))
      ?.querySelector<HTMLInputElement>("input");
    const evidenceChecks = [
      "无明显瑕疵",
      "只有一个主体",
      "符合本轮身份设计意图",
      "画面没有可见文字",
    ].map((label) =>
      [...panel!.querySelectorAll("label")]
        .find((element) => element.textContent?.includes(label))
        ?.querySelector<HTMLInputElement>("input")
    );
    const confirmed = [...panel!.querySelectorAll("label")]
      .find((label) =>
        label.textContent?.includes("以上逐项判断将作为不可变评审证据")
      )
      ?.querySelector<HTMLInputElement>("input");
    const submit = [...panel!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("确认提交候选"));
    expect(reason).toBeDefined();
    expect(evidenceChecks.every(Boolean)).toBe(true);
    expect(confirmed).toBeDefined();
    expect(submit?.disabled).toBe(true);

    await act(async () => {
      if (reason) setInputValue(reason, "Visible evidence reviewed");
      evidenceChecks.forEach((checkbox) => checkbox?.click());
      confirmed?.click();
    });
    expect(submit?.disabled).toBe(false);
    await act(async () => submit?.click());
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([, options]) =>
        options?.method === "POST"
      )
    );
    expect(adminV2Request).toHaveBeenCalledWith(
      `/api/v2/admin/creative/runs/${run.id}/items/identity-item-1/decisions`,
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          identityConsistency: "unscored",
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
        }),
      }),
    );
  });
});
