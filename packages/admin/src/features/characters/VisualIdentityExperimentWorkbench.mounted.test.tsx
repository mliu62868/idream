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

async function openFirstHistoryItem(container: HTMLElement) {
  await waitUntil(
    () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label^="查看第"]',
      ) !== null ||
      [...container.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.includes("未产出图片"),
      ),
  );
  const button =
    container.querySelector<HTMLButtonElement>(
      'button[aria-label^="查看第"]',
    ) ??
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("未产出图片"),
    );
  await act(async () => button?.click());
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
  items: [
    {
      id: "identity-item-1",
      ordinal: 0,
      executionState: "ready",
      asset: {
        id: "identity-asset-1",
        url: "/identity-candidate.webp",
        thumbnailUrl: null,
        automaticComposition: {
          evaluatorVersion: "generated-image-sanity-v2",
          status: "passed",
          reason: "single_continuous_frame_detected",
        },
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
    },
  ],
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
      anchorAssetIds: ["identity-current-asset"],
    },
    anchors: [
      {
        mediaAssetId: "identity-current-asset",
        role: "identity_anchor",
        available: true,
        url: "/mira-current.webp",
        thumbnailUrl: null,
      },
    ],
    references: [],
    activeReferenceSet: null,
    identityCalibration: {
      blocker: null,
      profiles: [
        {
          profileKey: "identity-profile",
          profileVersion: 1,
          label: "Identity profile",
          modelId: "redcraft-krea2-redmix3-fp8",
          workflowKey: "identity-workflow",
          workflowVersion: 1,
          orientation: "4:5",
          allowedOrientations: ["4:5"],
          modes: ["text_to_image", "image_to_image"],
          recommended: true,
        },
      ],
    },
  },
} as unknown as CharacterWorkspaceDetail;

const multiSourceData = {
  ...data,
  visual: {
    ...data.visual,
    references: [
      {
        mediaAssetId: "identity-reference-extra",
        role: "identity_reference",
        available: true,
        url: "/mira-reference-extra.webp",
        thumbnailUrl: null,
        qualityScore: 0.92,
        identityScore: 0.96,
      },
    ],
    activeReferenceSet: {
      id: "reference-set-v2",
      revision: 2,
      status: "active",
      selectorVersion: "admin-visual-workbench-v1",
      snapshotHash: "reference-set-hash",
      createdFrom: "reviewed_identity",
      createdAt: "2026-07-24T12:00:00.000Z",
      references: [
        {
          mediaAssetId: "identity-reference-active",
          role: "primary_face",
          available: true,
          url: "/mira-reference-active.webp",
          thumbnailUrl: null,
          qualityScore: 0.97,
          identityScore: 0.99,
        },
      ],
    },
  },
} as unknown as CharacterWorkspaceDetail;

describe("Visual Identity experiment activation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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
    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await waitUntil(
      () =>
        container.querySelector<HTMLSelectElement>(
          'select[aria-label="生成方式"]',
        ) !== null,
    );

    const labels = [
      ...container.querySelectorAll<HTMLSelectElement>("select"),
    ].map((select) => select.getAttribute("aria-label"));
    expect(labels.every(Boolean)).toBe(true);
    expect(labels).toEqual(
      expect.arrayContaining([
        "文生图模型",
        "配置档位",
        "种子策略",
        "生成方式",
        "高级构图比例",
        "高级身份约束",
      ]),
    );
  });

  it("keeps the first generation screen limited to prompt, negative prompt, seed, and generate", async () => {
    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await waitUntil(
      () =>
        container.querySelector<HTMLInputElement>(
          'input[aria-label="种子"]',
        ) !== null,
    );

    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="描述这次想要的画面"]',
    );
    const negativePrompt = container.querySelector<HTMLInputElement>(
      'input[aria-label="负向提示词"]',
    );
    const seed = container.querySelector<HTMLInputElement>(
      'input[aria-label="种子"]',
    );
    const generate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 1 张候选图"]',
    );
    const advanced = [...container.querySelectorAll("summary")].find(
      (summary) => summary.textContent === "高级设置",
    )?.parentElement as HTMLDetailsElement | undefined;

    expect(container.textContent).toContain("当前形象");
    expect(prompt?.value).toBe("");
    expect(negativePrompt?.value).toContain("different person");
    expect(seed?.value).not.toBe("");
    expect(generate?.textContent).toBe("生成");
    expect(generate?.disabled).toBe(true);
    expect(container.textContent).toContain("历史创作");
    expect(container.textContent).toContain("打开任意图片");
    expect(advanced?.open).toBe(false);

    await act(async () => {
      if (prompt) setTextAreaValue(prompt, "A calm editorial portrait");
    });
    expect(generate?.disabled).toBe(false);
  });

  it("shows historical images as a gallery and lets an older image be selected again", async () => {
    const olderRun = {
      ...run,
      id: "identity-run-older",
      createdAt: "2026-07-20T12:00:00.000Z",
    };
    const olderDetail = {
      ...runDetail,
      ...olderRun,
      reviewContext: {
        ...runDetail.reviewContext,
        experiment: {
          ...runDetail.reviewContext.experiment,
          baseSeed: "99",
          positivePrompt: "Older identity portrait",
        },
      },
      items: [
        {
          ...runDetail.items[0],
          id: "identity-item-older",
          asset: {
            ...runDetail.items[0]!.asset,
            id: "identity-asset-older",
            url: "/identity-candidate-older.webp",
          },
          review: null,
          lineage: { seed: "99" },
        },
      ],
    };
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run, olderRun],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) return runDetail;
      if (path === `/api/v2/admin/creative/runs/${olderRun.id}`) {
        return olderDetail;
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await waitUntil(
      () =>
        container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label^="查看第"]',
        ).length === 2,
    );

    const older = container.querySelector<HTMLButtonElement>(
      'button[aria-label="查看第 1 次创作的候选图 1"]',
    );
    await act(async () => older?.click());

    expect(
      container
        .querySelector<HTMLImageElement>('img[alt="所选历史视觉身份候选"]')
        ?.getAttribute("src"),
    ).toContain("identity-candidate-older.webp");
    expect(container.textContent).toContain("Older identity portrait");
    expect(container.textContent).toContain("99");
    expect(container.textContent).toContain("从这张继续调整");
  });

  it("summarizes the default model in a collapsed route disclosure and keeps model selection working", async () => {
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
    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={multiModelData}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await waitUntil(
      () =>
        container.querySelector<HTMLSelectElement>(
          'select[aria-label="文生图模型"]',
        ) !== null,
    );

    const model = container.querySelector<HTMLSelectElement>(
      'select[aria-label="文生图模型"]',
    );
    const profile = container.querySelector<HTMLSelectElement>(
      'select[aria-label="配置档位"]',
    );
    const routeSettings = model?.closest("details");
    expect(routeSettings).not.toBeNull();
    expect(routeSettings?.hasAttribute("open")).toBe(false);
    expect(model?.value).toBe("redcraft-krea2-redmix3-fp8");
    expect(container.textContent).toContain("（默认）");
    expect(container.textContent).toContain("RedCraft Krea2");
    expect(
      model?.querySelector('option[value="redcraft-krea2-redmix3-fp8"]'),
    ).not.toBeNull();

    await act(async () => {
      if (model) setSelectValue(model, "qwen-image-edit");
    });
    expect(model?.value).toBe("qwen-image-edit");
    expect(profile?.value).toBe("qwen-profile");
    expect(container.textContent).toContain("Qwen Image Edit");
    expect(profile?.value).toBe("qwen-profile");
  });

  it("lets operators choose an image-to-image source by visible reference card", async () => {
    adminV2Request.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (
          path === "/api/v2/admin/creative/runs" &&
          options?.method === "POST"
        ) {
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
      },
    );
    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={multiSourceData}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    const mode = container.querySelector<HTMLSelectElement>(
      'select[aria-label="生成方式"]',
    );
    expect(mode).toBeDefined();
    await act(async () => {
      if (mode) setSelectValue(mode, "image_to_image");
    });
    await waitUntil(
      () =>
        container.querySelectorAll<HTMLInputElement>(
          'input[name="identity-experiment-source"]',
        ).length === 4,
    );

    const sourceFieldset = [...container.querySelectorAll("fieldset")].find(
      (fieldset) => fieldset.textContent?.includes("参考图"),
    );
    expect(sourceFieldset).toBeDefined();
    expect(sourceFieldset?.querySelector("select")).toBeNull();
    expect(sourceFieldset?.textContent).toContain("主角色肖像");
    expect(sourceFieldset?.textContent).toContain("实验候选 1");

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

    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="描述这次想要的画面"]',
    );
    await act(async () => {
      if (prompt) setTextAreaValue(prompt, "A calm editorial portrait");
    });

    const generate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 1 张候选图"]',
    );
    expect(generate).toBeDefined();
    await act(async () => generate?.click());
    await waitUntil(() =>
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/creative/runs" && options?.method === "POST",
      ),
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
    adminV2Request.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path.endsWith("/image-sources")) return { items: [] };
        if (
          path === "/api/v2/admin/creative/runs" &&
          options?.method === "POST"
        ) {
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
      },
    );
    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={multiSourceData}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    const mode = container.querySelector<HTMLSelectElement>(
      'select[aria-label="生成方式"]',
    );
    expect(mode).toBeDefined();
    await act(async () => {
      if (mode) setSelectValue(mode, "image_to_image");
    });

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
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
    await waitUntil(
      () =>
        container.querySelector<HTMLInputElement>(
          'input[value="local-uploaded-source-1"]',
        )?.checked === true,
    );
    expect(container.textContent).toContain("mira-local.png");

    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="描述这次想要的画面"]',
    );
    await act(async () => {
      if (prompt) setTextAreaValue(prompt, "A calm editorial portrait");
    });

    const generate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="生成 1 张候选图"]',
    );
    await act(async () => generate?.click());
    await waitUntil(() =>
      adminV2Request.mock.calls.some(
        ([path, options]) =>
          path === "/api/v2/admin/creative/runs" && options?.method === "POST",
      ),
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
    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={onActivateCandidate}
        />,
      ),
    );
    await openFirstHistoryItem(container);
    await waitUntil(
      () => container.textContent?.includes("设为当前形象") === true,
    );
    const open = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "设为当前形象");
    await act(async () => open?.click());

    const activationPanel = container.querySelector<HTMLDivElement>(
      "#identity-candidate-activation",
    );
    expect(activationPanel).toBeDefined();
    const labels = [...activationPanel!.querySelectorAll("label")];
    const reason = labels
      .find((label) => label.textContent?.includes("变更理由"))
      ?.querySelector<HTMLInputElement>("input");
    const faceTraits = labels
      .find((label) => label.textContent?.includes("脸部特征"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const hairTraits = labels
      .find((label) => label.textContent?.includes("头发特征"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const bodyTraits = labels
      .find((label) => label.textContent?.includes("身形特征"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const confirmed = labels
      .find((label) =>
        label.textContent?.includes("我确认要创建新的视觉身份版本"),
      )
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
    const confirm = [
      ...activationPanel!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("确认设为当前形象"));
    expect(confirm).toBeDefined();
    expect(confirm?.disabled).toBe(false);
    await act(async () => confirm?.click());
    await waitUntil(() => onActivateCandidate.mock.calls.length === 1);

    expect(onActivateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
    );
  });

  it("requires a compact single-frame confirmation before adopting an identity image", async () => {
    let reviewPosted = false;
    adminV2Request.mockImplementation(
      async (path: string, options?: { method?: string }) => {
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
      },
    );
    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await openFirstHistoryItem(container);
    await waitUntil(
      () => container.textContent?.includes("采用这张图") === true,
    );
    expect(container.textContent).toContain("实际种子");
    expect(container.textContent).toContain(
      "我已确认人物、画面和图片质量，可将它作为视觉身份",
    );

    const adopt = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "采用这张图");
    const qualityConfirmation = [...container.querySelectorAll("label")]
      .find((label) =>
        label.textContent?.includes("我已确认人物、画面和图片质量"),
      )
      ?.querySelector<HTMLInputElement>("input");
    expect(qualityConfirmation).toBeDefined();
    expect(adopt?.disabled).toBe(true);

    await act(async () => qualityConfirmation?.click());
    expect(adopt?.disabled).toBe(false);
    await act(async () => adopt?.click());
    await waitUntil(() =>
      adminV2Request.mock.calls.some(
        ([, options]) => options?.method === "POST",
      ),
    );
    await waitUntil(
      () => container.textContent?.includes("设为当前形象") === true,
    );
    expect(adminV2Request).toHaveBeenCalledWith(
      `/api/v2/admin/creative/runs/${run.id}/items/identity-item-1/decisions`,
      expect.objectContaining({
        method: "POST",
        body: {
          entityVersion: runDetail.version,
          decision: "approved",
          identityConsistency: "unscored",
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          reason: "已确认候选图为单人单画面并符合视觉身份要求",
        },
      }),
    );
  });

  it("does not let an old candidate without system composition evidence be adopted", async () => {
    const unverifiedDetail = {
      ...runDetail,
      items: runDetail.items.map((item) => ({
        ...item,
        asset: item.asset
          ? { ...item.asset, automaticComposition: undefined }
          : null,
        review: null,
      })),
    };
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) {
        return unverifiedDetail;
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await openFirstHistoryItem(container);
    await waitUntil(
      () =>
        container.textContent?.includes("缺少可采用的构图检查记录") === true,
    );

    const adopt = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "采用这张图");
    expect(adopt).toBeUndefined();
    expect(
      [...container.querySelectorAll("label")].some((label) =>
        label.textContent?.includes("我已确认人物、画面和图片质量"),
      ),
    ).toBe(false);
  });

  it("does not let a historically approved candidate bypass system evidence during activation", async () => {
    const historicallyApprovedDetail = {
      ...runDetail,
      items: runDetail.items.map((item) => ({
        ...item,
        asset: item.asset
          ? { ...item.asset, automaticComposition: undefined }
          : null,
      })),
    };
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) {
        return historicallyApprovedDetail;
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await openFirstHistoryItem(container);
    await waitUntil(
      () =>
        container.textContent?.includes("缺少可采用的构图检查记录") === true,
    );

    const activate = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "设为当前形象");
    expect(activate).toBeUndefined();
  });

  it("explains when the system blocks a failed composite candidate", async () => {
    const failedDetail = {
      ...runDetail,
      executionOutcome: "failed",
      items: runDetail.items.map((item) => ({
        ...item,
        executionState: "failed",
        status: "failed",
        asset: null,
        review: null,
        failure: {
          errorCode: "asset_quality_failed",
          operatorGuidance:
            "系统质量检查未通过；合图、空白图或损坏图片不会进入候选。请载入本轮参数，修改提示词后重新生成。",
        },
      })),
    };
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [{ ...run, executionOutcome: "failed" }],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) {
        return failedDetail;
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={data}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await openFirstHistoryItem(container);
    await waitUntil(
      () =>
        container.textContent?.includes(
          "合图、空白图或损坏图片不会进入候选",
        ) === true,
    );
    expect(container.textContent).toContain("asset_quality_failed");
  });
});
