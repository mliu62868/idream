// @vitest-environment happy-dom

import type { CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2FormRequest, adminV2Request } = vi.hoisted(() => ({
  adminV2FormRequest: vi.fn(),
  adminV2Request: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", () => ({
  adminV2FormRequest,
  adminV2Request,
}));

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

function setSelectValue(input: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
        modelId: "redcraft-krea2-comfyui",
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

const multiSourceData = {
  ...data,
  visual: {
    ...data.visual,
    references: [{
      mediaAssetId: "identity-reference-extra",
      role: "identity_reference",
      available: true,
      url: "/mira-reference-extra.webp",
      thumbnailUrl: null,
      qualityScore: 0.92,
      identityScore: 0.96,
    }],
    activeReferenceSet: {
      id: "reference-set-v2",
      revision: 2,
      status: "active",
      selectorVersion: "admin-visual-workbench-v1",
      snapshotHash: "reference-set-hash",
      createdFrom: "reviewed_identity",
      createdAt: "2026-07-24T12:00:00.000Z",
      references: [{
        mediaAssetId: "identity-reference-active",
        role: "primary_face",
        available: true,
        url: "/mira-reference-active.webp",
        thumbnailUrl: null,
        qualityScore: 0.97,
        identityScore: 0.99,
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
    adminV2FormRequest.mockReset();
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/image-sources")) return { items: [] };
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

  it("gives every generation selector an explicit accessible name", async () => {
    await act(async () => root.render(
      <VisualIdentityExperimentWorkbench
        canActivate
        canCreate
        canReview
        canUploadSource
        data={data}
        onActivateCandidate={vi.fn(async () => undefined)}
      />,
    ));
    await waitUntil(() =>
      container.querySelectorAll<HTMLSelectElement>("select").length === 5
    );

    expect(
      [...container.querySelectorAll<HTMLSelectElement>("select")]
        .map((select) => select.getAttribute("aria-label")),
    ).toEqual([
      "文生图模型",
      "配置档位",
      "种子策略",
      "构图比例",
      "身份约束",
    ]);
  });

  it("shows the default model without opening advanced settings and switches real models separately from profiles", async () => {
    const multiModelData = {
      ...data,
      visual: {
        ...data.visual,
        identityCalibration: {
          blocker: null,
          profiles: [
            ...data.visual.identityCalibration!.profiles,
            {
              profileKey: "qwen-profile",
              profileVersion: 2,
              label: "Qwen portrait",
              modelId: "qwen-image-edit",
              workflowKey: "qwen-image-workflow",
              workflowVersion: 3,
              orientation: "1:1",
              allowedOrientations: ["1:1", "4:5"],
              modes: ["text_to_image"],
              recommended: false,
            },
          ],
        },
      },
    } as unknown as CharacterWorkspaceDetail;
    await act(async () => root.render(
      <VisualIdentityExperimentWorkbench
        canActivate
        canCreate
        canReview
        canUploadSource
        data={multiModelData}
        onActivateCandidate={vi.fn(async () => undefined)}
      />,
    ));
    await waitUntil(() =>
      container.querySelector<HTMLSelectElement>(
        'select[aria-label="文生图模型"]',
      ) !== null
    );

    const model = container.querySelector<HTMLSelectElement>(
      'select[aria-label="文生图模型"]',
    );
    const profile = container.querySelector<HTMLSelectElement>(
      'select[aria-label="配置档位"]',
    );
    expect(model?.closest("details")).toBeNull();
    expect(model?.value).toBe("redcraft-krea2-comfyui");
    expect(container.textContent).toContain("当前默认");
    expect(container.textContent).toContain("RedCraft Krea2");
    expect(container.textContent).toContain("redcraft-krea2-comfyui");

    await act(async () => {
      if (model) setSelectValue(model, "qwen-image-edit");
    });
    expect(model?.value).toBe("qwen-image-edit");
    expect(profile?.value).toBe("qwen-profile");
    expect(container.textContent).toContain("Qwen Image Edit");
    expect(container.textContent).toContain("qwen-image-workflow v3");
  });

  it("lets operators choose an image-to-image source by visible reference card", async () => {
    adminV2Request.mockImplementation(async (
      path: string,
      options?: { method?: string },
    ) => {
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        return { batch: { id: "identity-run-2" }, replayed: false };
      }
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) return runDetail;
      if (path === "/api/v2/admin/creative/runs/identity-run-2") {
        return { ...runDetail, id: "identity-run-2" };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await act(async () => root.render(
      <VisualIdentityExperimentWorkbench
        canActivate
        canCreate
        canReview
        canUploadSource
        data={multiSourceData}
        onActivateCandidate={vi.fn(async () => undefined)}
      />,
    ));
    await waitUntil(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .some((button) => button.textContent === "图生图")
    );
    const imageToImage = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "图生图");
    await act(async () => imageToImage?.click());
    await waitUntil(() =>
      container.querySelectorAll<HTMLInputElement>(
        'input[name="identity-experiment-source"]',
      ).length === 4
    );

    const sourceFieldset = [...container.querySelectorAll("fieldset")]
      .find((fieldset) => fieldset.textContent?.includes("选择参考图"));
    expect(sourceFieldset).toBeDefined();
    expect(sourceFieldset?.querySelector("select")).toBeNull();
    expect(sourceFieldset?.textContent).toContain("正式参考集 R2");
    expect(sourceFieldset?.textContent).toContain("最近实验");

    const extraReference = sourceFieldset?.querySelector<HTMLInputElement>(
      'input[value="identity-reference-extra"]',
    );
    expect(extraReference).toBeDefined();
    expect(extraReference?.checked).toBe(false);
    await act(async () => extraReference?.click());
    expect(extraReference?.checked).toBe(true);
    expect(
      sourceFieldset?.querySelector<HTMLInputElement>(
        'input[value="identity-reference-active"]',
      )?.checked,
    ).toBe(false);

    const generate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "生成 1 张候选图");
    expect(generate).toBeDefined();
    await act(async () => generate?.click());
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([path, options]) =>
        path === "/api/v2/admin/creative/runs" &&
        options?.method === "POST"
      )
    );
    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/creative/runs",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          count: 1,
          identityExperiment: expect.objectContaining({
            mode: "image_to_image",
            sourceAssetId: "identity-reference-extra",
          }),
        }),
      }),
    );
  });

  it("uploads a local image, selects the persisted asset, and uses it for image-to-image", async () => {
    const uploadedAsset = {
      id: "local-uploaded-source-1",
      url: "/user-content/local-uploaded-source-1/content.png",
      thumbnailUrl: null,
      filename: "mira-local.png",
      contentType: "image/png",
      sizeBytes: 2_048,
      width: 128,
      height: 160,
      createdAt: "2026-07-24T13:00:00.000Z",
    };
    adminV2FormRequest.mockResolvedValue({
      asset: uploadedAsset,
      replayed: false,
    });
    adminV2Request.mockImplementation(async (
      path: string,
      options?: { method?: string },
    ) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        return { batch: { id: "identity-run-2" }, replayed: false };
      }
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) return runDetail;
      if (path === "/api/v2/admin/creative/runs/identity-run-2") {
        return { ...runDetail, id: "identity-run-2" };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    await act(async () => root.render(
      <VisualIdentityExperimentWorkbench
        canActivate
        canCreate
        canReview
        canUploadSource
        data={multiSourceData}
        onActivateCandidate={vi.fn(async () => undefined)}
      />,
    ));
    await waitUntil(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .some((button) => button.textContent === "图生图")
    );
    const imageToImage = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "图生图");
    await act(async () => imageToImage?.click());

    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).toBeDefined();
    const file = new File([new Uint8Array(2_048)], "mira-local.png", {
      type: "image/png",
    });
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      fileInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitUntil(() => adminV2FormRequest.mock.calls.length === 1);

    const [uploadPath, uploadOptions] = adminV2FormRequest.mock.calls[0]!;
    expect(uploadPath).toBe(
      "/api/v2/admin/characters/character-1/image-sources",
    );
    expect(uploadOptions.form.get("purpose")).toBe(
      "identity_experiment_source",
    );
    expect(uploadOptions.form.get("image")).toBe(file);
    await waitUntil(() =>
      container.querySelector<HTMLInputElement>(
        'input[value="local-uploaded-source-1"]',
      )?.checked === true
    );
    expect(container.textContent).toContain("本地上传");

    const generate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "生成 1 张候选图");
    await act(async () => generate?.click());
    await waitUntil(() =>
      adminV2Request.mock.calls.some(([path, options]) =>
        path === "/api/v2/admin/creative/runs" &&
        options?.method === "POST"
      )
    );
    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/creative/runs",
      expect.objectContaining({
        body: expect.objectContaining({
          count: 1,
          identityExperiment: expect.objectContaining({
            mode: "image_to_image",
            sourceAssetId: "local-uploaded-source-1",
          }),
        }),
      }),
    );
  });

  it("turns a reviewed candidate into an explicit activation command", async () => {
    const onActivateCandidate = vi.fn(async () => undefined);
    await act(async () => root.render(
      <VisualIdentityExperimentWorkbench
        canActivate
        canCreate
        canReview
        canUploadSource
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
      if (path.endsWith("/image-sources")) return { items: [] };
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
        canUploadSource
        data={data}
        onActivateCandidate={vi.fn(async () => undefined)}
      />,
    ));
    await waitUntil(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .some((button) =>
          button.textContent?.includes("评审这张候选图") &&
          !button.disabled
        )
    );
    const open = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("评审这张候选图"));
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
      .find((label) => label.textContent?.includes("评审说明"))
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
      .find((button) => button.textContent?.includes("完成检查后继续"));
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
    await waitUntil(() =>
      container.textContent?.includes("激活新的视觉身份版本") === true
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

  it("offers an executable rejection path when a candidate fails visible quality", async () => {
    let reviewPosted = false;
    adminV2Request.mockImplementation(async (
      path: string,
      options?: { method?: string },
    ) => {
      if (options?.method === "POST") {
        reviewPosted = true;
        return {};
      }
      if (path.endsWith("/image-sources")) return { items: [] };
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
            review: reviewPosted
              ? {
                  ...item.review,
                  decision: "rejected",
                  quality: {
                    artifactFree: true,
                    singleSubject: false,
                    intentMatch: false,
                    noVisibleText: true,
                  },
                  reason: "Multiple people and the identity intent does not match",
                }
              : null,
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
        canUploadSource
        data={data}
        onActivateCandidate={vi.fn(async () => undefined)}
      />,
    ));
    await waitUntil(() =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .some((button) =>
          button.textContent?.includes("评审这张候选图") &&
          !button.disabled
        )
    );
    const open = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("评审这张候选图"));
    await act(async () => open?.click());

    const panel = [...container.querySelectorAll("div")]
      .find((element) =>
        element.querySelector("h4")?.textContent === "确认候选身份评审"
      );
    expect(panel).toBeDefined();
    const reason = [...panel!.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("评审说明"))
      ?.querySelector<HTMLInputElement>("input");
    const artifactFree = [...panel!.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("无明显瑕疵"))
      ?.querySelector<HTMLInputElement>("input");
    const noVisibleText = [...panel!.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("画面没有可见文字"))
      ?.querySelector<HTMLInputElement>("input");
    const confirmed = [...panel!.querySelectorAll("label")]
      .find((label) =>
        label.textContent?.includes("以上逐项判断将作为不可变评审证据")
      )
      ?.querySelector<HTMLInputElement>("input");
    await act(async () => {
      if (reason) {
        setInputValue(
          reason,
          "Multiple people and the identity intent does not match",
        );
      }
      artifactFree?.click();
      noVisibleText?.click();
      confirmed?.click();
    });

    expect(panel?.textContent).toContain(
      "2 项未通过，这张图不能进入身份激活",
    );
    const reject = [...panel!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) =>
        button.textContent?.includes("记录不采用并继续调整")
      );
    expect(reject?.disabled).toBe(false);
    await act(async () => reject?.click());
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
          decision: "rejected",
          identityConsistency: "unscored",
          quality: {
            artifactFree: true,
            singleSubject: false,
            intentMatch: false,
            noVisibleText: true,
          },
        }),
      }),
    );
  });
});
