// @vitest-environment happy-dom

import { act } from "react";
import { creativeRunCreateRequestSchema } from "@idream/shared/admin";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/admin-v2-api")>(),
  adminV2Request,
}));

import { readActiveDurableMutationIntent } from "@/lib/durable-mutation-intent";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { VisualIdentityExperimentWorkbench } from "./VisualIdentityExperimentWorkbench";
import { ADMIN_WORKSPACE_REFRESH_EVENT } from "@/features/workspace-refresh";
import {
  characterWorkspaceDetail,
  withCharacterWorkspaceDetail,
} from "./character-workspace-fixture";

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
        'button[aria-label^="View candidate"]',
      ) !== null ||
      [...container.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent?.includes("no images produced"),
      ),
  );
  const button =
    container.querySelector<HTMLButtonElement>(
      'button[aria-label^="View candidate"]',
    ) ??
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("no images produced"),
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

function createdDetail(body: unknown) {
  const request = creativeRunCreateRequestSchema.parse(body);
  if (!request.identityExperiment) throw new Error("Missing experiment");
  return {
    ...runDetail,
    id: "identity-run-2",
    title: request.title,
    target: { type: request.targetType, id: request.targetId },
    reviewContext: {
      ...runDetail.reviewContext,
      orientation: request.orientation,
      profile: { key: request.profileId },
      experiment: {
        ...request.identityExperiment,
        positivePrompt: request.brief,
        sourceAssetId: request.identityExperiment.sourceAssetId ?? null,
        baseSeed: request.identityExperiment.baseSeed ?? null,
      },
    },
  };
}

const data = characterWorkspaceDetail({
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
        qualityScore: null,
        identityScore: null,
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
});

const multiSourceData = withCharacterWorkspaceDetail(data, {
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
});

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
    window.localStorage.clear();
    adminV2Request.mockReset();
    adminV2Request.mockImplementation(async (path: string) => {
      if (new URL(path, "http://admin.test").pathname.endsWith("/image-sources")) return { items: [] };
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
    vi.restoreAllMocks();
  });

  it("reloads uploaded sources and the current experiment through shell refresh while retaining prompt input", async () => {
    await act(async () => root.render(<VisualIdentityExperimentWorkbench canActivate canCreate canReview canUploadSource
      data={data} onActivateCandidate={vi.fn(async () => undefined)} />));
    await waitUntil(() => adminV2Request.mock.calls.some(([path]) => path === `/api/v2/admin/creative/runs/${run.id}`));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => setTextAreaValue(textarea, "Unfinished identity prompt"));
    const before = adminV2Request.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)); });
    const refreshed = adminV2Request.mock.calls.slice(before).map(([path]) => String(path));
    expect(refreshed.filter(path => new URL(path, "http://admin.test").pathname.endsWith("/image-sources"))).toHaveLength(1);
    expect(refreshed.filter(path => path.includes("/creative/runs?"))).toHaveLength(1);
    expect(refreshed.filter(path => path === `/api/v2/admin/creative/runs/${run.id}`)).toHaveLength(1);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Unfinished identity prompt");
  });

  // SPEC: 历史只含视觉身份校准 —— 用途必须由服务端筛，否则最近 30 条别的用途会把它挤空。
  it("asks the authority for identity-calibration runs only", async () => {
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
    const listCall = () =>
      adminV2Request.mock.calls.find(([path]) =>
        String(path).includes("/api/v2/admin/creative/runs?"),
      );
    await waitUntil(() => listCall() !== undefined);
    const query = new URL(String(listCall()![0]), "http://admin.test").searchParams;
    expect(query.get("purpose")).toBe("identity_calibration");
  });

  it.each([false, true])("restores another instance's experiment snapshot and refreshes after a late failure (readback fails: %s)", async (readbackFails) => {
    const brief = "A quiet museum portrait with a blue coat";
    const negative = "No windows or other people";
    const creates: Array<{ key: unknown; body: unknown }> = [];
    let failFirst!: () => void;
    let failReadback = false;
    const current = () => ({ ...createdDetail(creates[0].body), executionOutcome: "running", items: [{ ...runDetail.items[0], asset: null, executionState: "generating" }] });
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/creative/runs?")) {
        if (failReadback) throw new Error("Current experiment list unavailable");
        return { items: creates.length ? [current(), run] : [run], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        creates.push({ key: options.idempotencyKey, body: options.body });
        if (creates.length === 1) return new Promise((_resolve, reject) => { failFirst = () => reject(new TypeError("First response lost")); });
        return { batch: { id: "identity-run-2" }, replayed: true };
      }
      if (path.endsWith("/identity-run-2")) return current();
      if (path.endsWith(`/${run.id}`)) return runDetail;
      throw new Error(`Unexpected request: ${path}`);
    });
    const other = document.createElement("div");
    document.body.append(other);
    const otherRoot = createRoot(other);
    const generate = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('button[aria-label="Generate 1 candidate image"]');
    const render = (target: Root) => target.render(<VisualIdentityExperimentWorkbench actorId="shared-experiment" canActivate canCreate canReview canUploadSource data={data} />);
    try {
      await act(async () => render(root));
      await waitUntil(() => container.querySelector('button[aria-label^="View candidate"]') !== null);
      await act(async () => {
        setTextAreaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe the look you want"]')!, brief);
        setInputValue(container.querySelector<HTMLInputElement>('input[aria-label="Negative prompt"]')!, negative);
        setInputValue(container.querySelector<HTMLInputElement>('input[aria-label="Seed"]')!, "12345");
        setSelectValue(container.querySelector<HTMLSelectElement>('select[aria-label="Advanced identity constraint"]')!, "creative");
      });
      await act(async () => generate(container)!.click());
      await waitUntil(() => creates.length === 1);
      await act(async () => render(otherRoot));
      const prompt = other.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe the look you want"]')!;
      expect.soft(prompt.value).toBe(brief);
      expect.soft(prompt.disabled).toBe(true);
      expect.soft(other.querySelector<HTMLInputElement>('input[aria-label="Negative prompt"]')?.value).toBe(negative);
      expect.soft(other.querySelector<HTMLInputElement>('input[aria-label="Seed"]')?.value).toBe("12345");
      expect.soft(other.querySelector<HTMLSelectElement>('select[aria-label="Advanced identity constraint"]')?.value).toBe("creative");
      expect.soft(other.querySelector<HTMLSelectElement>('select[aria-label="Generation mode"]')?.closest("fieldset")?.disabled).toBe(true);
      await openFirstHistoryItem(other);
      expect.soft([...other.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Reuse these parameters")?.disabled).toBe(true);
      expect.soft([...other.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Keep adjusting from this one")?.disabled).toBe(true);
      await act(async () => other.querySelector<HTMLButtonElement>('button[aria-label="Resume saved experiment"]')!.click());
      const scope = "identity-experiment:create:shared-experiment:character-1";
      await waitUntil(() => readActiveDurableMutationIntent({ scope }) === null);
      expect(creates[1]).toEqual(creates[0]);
      failReadback = readbackFails;
      await act(async () => failFirst());
      await waitUntil(() => generate(container)?.textContent?.includes("Generating") === false);
      if (readbackFails) {
        expect.soft(generate(container)?.disabled).toBe(true);
        expect.soft(container.textContent).toContain("Current experiment list unavailable");
        failReadback = false;
        await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
      }
      expect.soft(container.querySelector('article[aria-labelledby="selected-history-candidate-title"]')?.textContent).toContain("A quiet museum portrait with a blue coat");
      expect(readActiveDurableMutationIntent({ scope })).toBeNull();
      expect(creates).toHaveLength(2);
    } finally {
      await act(async () => otherRoot.unmount());
      other.remove();
    }
  });

  it("keeps a committed receipt across remount and verifies the exact run without another POST", async () => {
    let body: unknown;
    let readbackMode: "failed" | "wrong-target" | "correct" = "failed";
    adminV2Request.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/creative/runs?")) return { items: [], pageInfo: { hasNextPage: false, endCursor: null } };
      if (options?.method === "POST" && path === "/api/v2/admin/creative/runs") {
        body = options.body;
        return { batch: { id: "identity-run-2" }, replayed: false };
      }
      if (path.endsWith("/identity-run-2")) {
        if (readbackMode === "failed") throw new Error("Read temporarily unavailable");
        const detail = createdDetail(body);
        return readbackMode === "correct" ? detail : { ...detail, target: { type: "character", id: "another-character" } };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const render = () => root.render(<VisualIdentityExperimentWorkbench actorId="operator-1" canActivate canCreate canReview canUploadSource data={data} />);
    await act(async () => render());
    await act(async () => setTextAreaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe the look you want"]')!, "Original experiment portrait"));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Generate 1 candidate image"]')!.click());
    await waitUntil(() => container.textContent?.includes("The experiment was committed.") === true);
    const scope = "identity-experiment:create:operator-1:character-1";
    expect(readActiveDurableMutationIntent({ scope })).toMatchObject({ status: "committed_projection_pending", committedTargetId: "identity-run-2" });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    readbackMode = "wrong-target";
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Resume saved experiment"]')!.click());
    expect(readActiveDurableMutationIntent({ scope })?.committedTargetId).toBe("identity-run-2");
    readbackMode = "correct";
    await act(async () => setTextAreaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe the look you want"]')!, "A changed draft must not change the committed request"));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Resume saved experiment"]')!.click());
    await waitUntil(() => readActiveDurableMutationIntent({ scope }) === null);
    expect(adminV2Request.mock.calls.filter(([path, options]) => path === "/api/v2/admin/creative/runs" && options?.method === "POST")).toHaveLength(1);
    expect(body).toMatchObject({ brief: "Original experiment portrait" });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Generate 1 candidate image"]')).not.toBeNull();
  });

  it("keeps an unknown experiment intent after a conflicting replay and recovers the original request", async () => {
    const scope = "identity-experiment:create:operator-replay:character-1";
    const creates: Array<{ key: string; body: unknown }> = [];
    adminV2Request.mockImplementation(async (path, options) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/creative/runs?")) return { items: [], pageInfo: { hasNextPage: false, endCursor: null } };
      if (path === "/api/v2/admin/creative/runs" && options?.method === "POST") {
        creates.push({ key: options.idempotencyKey, body: options.body });
        if (creates.length === 1) throw new TypeError("Response ended after server commit");
        if (creates.length === 2) throw new AdminV2RequestError("Current policy rejects this replay", 409, "conflict");
        return { batch: { id: "identity-run-2" }, replayed: true };
      }
      if (path.endsWith("/identity-run-2")) return createdDetail(creates[0].body);
      throw new Error(`Unexpected request: ${path}`);
    });
    const render = async () => {
      await act(async () => root.render(
        <VisualIdentityExperimentWorkbench actorId="operator-replay" canActivate canCreate canReview canUploadSource data={data} />,
      ));
    };
    await render();
    await act(async () => setTextAreaValue(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe the look you want"]')!,
      "Original experiment request that must remain recoverable",
    ));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Generate 1 candidate image"]')!.click());
    expect(readActiveDurableMutationIntent({ scope })).toMatchObject({ status: "outcome_unknown", idempotencyKey: creates[0].key });

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Resume saved experiment"]')!.click());
    expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual(creates[0]);
    expect(readActiveDurableMutationIntent({ scope })?.idempotencyKey).toBe(creates[0].key);
    expect(container.querySelector('button[aria-label="Generate 1 candidate image"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Resume saved experiment"]')).not.toBeNull();

    // Editing the visible draft never replaces an unresolved request's frozen payload.
    await act(async () => setTextAreaValue(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe the look you want"]')!,
      "Changed draft must wait for the earlier request",
    ));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Resume saved experiment"]')!.click());
    await waitUntil(() => readActiveDurableMutationIntent({ scope }) === null);
    expect(creates).toHaveLength(3);
    expect(creates[2]).toEqual(creates[0]);
    expect(container.querySelector('button[aria-label="Generate 1 candidate image"]')).not.toBeNull();
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
          'select[aria-label="Generation mode"]',
        ) !== null,
    );

    const labels = [
      ...container.querySelectorAll<HTMLSelectElement>("select"),
    ].map((select) => select.getAttribute("aria-label"));
    expect(labels.every(Boolean)).toBe(true);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Text to image model",
        "Profile tier",
        "Seed strategy",
        "Generation mode",
        "Advanced aspect ratio",
        "Advanced identity constraint",
      ]),
    );
  });

  it.each([null, "/previously-published-portrait.webp"])(
    "shows the active reference as Current look when the candidate pool changes and the public portrait is %s",
    async (imageUrl) => {
      const currentLookData = withCharacterWorkspaceDetail(multiSourceData, {
        character: { ...multiSourceData.character, imageUrl },
        visual: {
          ...multiSourceData.visual,
          anchors: [{
            ...data.visual.anchors[0],
            mediaAssetId: "unadopted-experiment-candidate",
            url: "/unadopted-experiment-candidate.webp",
          }, ...data.visual.anchors],
        },
      });
      await act(async () => root.render(
        <VisualIdentityExperimentWorkbench canActivate canCreate canReview canUploadSource data={currentLookData} />,
      ));

      expect(container.querySelector('img[alt="Active visual identity baseline"]')?.getAttribute("src"))
        .toBe("/mira-reference-active.webp");
    },
  );

  it.each(["not_activated", "missing_reference_set", "reference_unavailable"])(
    "does not label a public portrait or candidate as Current look when %s",
    async (state) => {
      const currentLookData = withCharacterWorkspaceDetail(multiSourceData, {
        visual: {
          ...multiSourceData.visual,
          activeIdentity: state === "not_activated" ? null : multiSourceData.visual.activeIdentity,
          activeReferenceSet: state === "reference_unavailable"
            ? {
              ...multiSourceData.visual.activeReferenceSet!,
              references: multiSourceData.visual.activeReferenceSet!.references.map((reference) => ({ ...reference, available: false })),
            }
            : null,
        },
      });
      await act(async () => root.render(
        <VisualIdentityExperimentWorkbench canActivate canCreate canReview canUploadSource data={currentLookData} />,
      ));

      expect(container.querySelector('img[alt="Active visual identity baseline"]')).toBeNull();
      expect(container.textContent).toContain("No current look yet");
    },
  );

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
          'input[aria-label="Seed"]',
        ) !== null,
    );

    const prompt = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Describe the look you want"]',
    );
    const negativePrompt = container.querySelector<HTMLInputElement>(
      'input[aria-label="Negative prompt"]',
    );
    const seed = container.querySelector<HTMLInputElement>(
      'input[aria-label="Seed"]',
    );
    const generate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Generate 1 candidate image"]',
    );
    const advanced = [...container.querySelectorAll("summary")].find(
      (summary) => summary.textContent === "Advanced settings",
    )?.parentElement as HTMLDetailsElement | undefined;

    expect(container.textContent).toContain("Current look");
    expect(prompt?.value).toBe("");
    expect(negativePrompt?.value).toContain("different person");
    expect(seed?.value).not.toBe("");
    expect(generate?.textContent).toBe("Generate");
    expect(generate?.disabled).toBe(true);
    expect(container.textContent).toContain("Creation history");
    expect(container.textContent).toContain("Open any image");
    expect(advanced?.open).toBe(false);

    await act(async () => {
      if (prompt) setTextAreaValue(prompt, "A calm editorial portrait");
    });
    expect(generate?.disabled).toBe(false);
  });

  it("starts with a numeric generation seed and changes it on every randomize click", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const opaqueIdentitySeedData = withCharacterWorkspaceDetail(data, {
      visual: {
        ...data.visual,
        activeIdentity: {
          ...data.visual.activeIdentity!,
          defaultSeed: "character:character-1:visual:1",
        },
      },
    });

    await act(async () =>
      root.render(
        <VisualIdentityExperimentWorkbench
          canActivate
          canCreate
          canReview
          canUploadSource
          data={opaqueIdentitySeedData}
          onActivateCandidate={vi.fn(async () => undefined)}
        />,
      ),
    );
    await waitUntil(
      () =>
        container.querySelector<HTMLInputElement>('input[aria-label="Seed"]') !==
        null,
    );

    const seed = container.querySelector<HTMLInputElement>(
      'input[aria-label="Seed"]',
    );
    const randomize = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Randomize",
    );
    const initialSeed = seed?.value;
    await act(async () => randomize?.click());
    const firstRandomSeed = seed?.value;
    await act(async () => randomize?.click());
    const secondRandomSeed = seed?.value;

    expect.soft(initialSeed).toMatch(/^\d+$/);
    expect.soft(firstRandomSeed).not.toBe(initialSeed);
    expect.soft(secondRandomSeed).not.toBe(firstRandomSeed);
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
    let lateRefresh: ((value: unknown) => void) | null = null;
    let delayRefresh = false;
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.endsWith("/image-sources")) return { items: [] };
      if (path.includes("/api/v2/admin/creative/runs?")) {
        return {
          items: [run, olderRun],
          pageInfo: { endCursor: null, hasNextPage: false },
        };
      }
      if (path === `/api/v2/admin/creative/runs/${run.id}`) {
        if (delayRefresh) return new Promise((resolve) => { lateRefresh = resolve; });
        return runDetail;
      }
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
          'button[aria-label^="View candidate"]',
        ).length === 2,
    );

    delayRefresh = true;
    await act(async () => window.dispatchEvent(new Event(ADMIN_WORKSPACE_REFRESH_EVENT)));
    await waitUntil(() => lateRefresh !== null);
    const older = container.querySelector<HTMLButtonElement>(
      'button[aria-label="View candidate 1 from run 1"]',
    );
    await act(async () => older?.click());
    await act(async () => lateRefresh?.({ ...runDetail, version: 3 }));

    expect(
      container
        .querySelector<HTMLImageElement>('img[alt="Selected visual identity candidate"]')
        ?.getAttribute("src"),
    ).toContain("identity-candidate-older.webp");
    expect(container.textContent).toContain("Older identity portrait");
    expect(container.textContent).toContain("99");
    expect(container.textContent).toContain("Keep adjusting from this one");
  });

  it("summarizes the default model in a collapsed route disclosure and keeps model selection working", async () => {
    const multiModelData = withCharacterWorkspaceDetail(data, {
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
              modelId: "redqw21-image-edit",
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
    });
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
          'select[aria-label="Text to image model"]',
        ) !== null,
    );

    const model = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Text to image model"]',
    );
    const profile = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Profile tier"]',
    );
    const routeSettings = model?.closest("details");
    expect(routeSettings).not.toBeNull();
    expect(routeSettings?.hasAttribute("open")).toBe(false);
    expect(model?.value).toBe("redcraft-krea2-redmix3-fp8");
    expect(container.textContent).toContain("(default)");
    expect(container.textContent).toContain("RedCraft Krea2");
    expect(
      model?.querySelector('option[value="redcraft-krea2-redmix3-fp8"]'),
    ).not.toBeNull();

    await act(async () => {
      if (model) setSelectValue(model, "redqw21-image-edit");
    });
    expect(model?.value).toBe("redqw21-image-edit");
    expect(profile?.value).toBe("qwen-profile");
    expect(container.textContent).toContain("REDQW21");
    expect(profile?.value).toBe("qwen-profile");
  });

  it("lets operators choose an image-to-image source by visible reference card", async () => {
    adminV2Request.mockImplementation(
      async (path: string, options?: { method?: string; body?: unknown }) => {
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
          const post = adminV2Request.mock.calls.find(([url, options]) => url === "/api/v2/admin/creative/runs" && options?.method === "POST");
          return createdDetail(post?.[1].body);
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
      'select[aria-label="Generation mode"]',
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
      (fieldset) => fieldset.textContent?.includes("Reference images"),
    );
    expect(sourceFieldset).toBeDefined();
    expect(sourceFieldset?.querySelector("select")).toBeNull();
    expect(sourceFieldset?.textContent).toContain("Primary portrait");
    expect(sourceFieldset?.textContent).toContain("Experiment candidate 1");

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
      'textarea[aria-label="Describe the look you want"]',
    );
    await act(async () => {
      if (prompt) setTextAreaValue(prompt, "A calm editorial portrait");
    });

    const generate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Generate 1 candidate image"]',
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
    adminV2Request.mockImplementation(
      async (path: string, options?: { method?: string; body?: unknown }) => {
        if (path.endsWith("/image-sources")) {
          return options?.method === "POST"
            ? { asset: uploadedAsset, replayed: false }
            : { items: [] };
        }
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
          const post = adminV2Request.mock.calls.find(([url, options]) => url === "/api/v2/admin/creative/runs" && options?.method === "POST");
          return createdDetail(post?.[1].body);
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
      'select[aria-label="Generation mode"]',
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
    await waitUntil(() =>
      adminV2Request.mock.calls.some(
        ([, options]) => options?.method === "POST" && options?.form,
      ),
    );

    const [uploadPath, uploadOptions] = adminV2Request.mock.calls.find(
      ([, options]) => options?.method === "POST" && options?.form,
    )!;
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
      'textarea[aria-label="Describe the look you want"]',
    );
    await act(async () => {
      if (prompt) setTextAreaValue(prompt, "A calm editorial portrait");
    });

    const generate = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Generate 1 candidate image"]',
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
      () => container.textContent?.includes("Set as current look") === true,
    );
    const open = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Set as current look");
    await act(async () => open?.click());

    const activationPanel = container.querySelector<HTMLDivElement>(
      "#identity-candidate-activation",
    );
    expect(activationPanel).toBeDefined();
    const labels = [...activationPanel!.querySelectorAll("label")];
    const reason = labels
      .find((label) => label.textContent?.includes("Reason for change"))
      ?.querySelector<HTMLInputElement>("input");
    const faceTraits = labels
      .find((label) => label.textContent?.includes("Face traits"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const hairTraits = labels
      .find((label) => label.textContent?.includes("Hair traits"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const bodyTraits = labels
      .find((label) => label.textContent?.includes("Body traits"))
      ?.querySelector<HTMLTextAreaElement>("textarea");
    const confirmed = labels
      .find((label) =>
        label.textContent?.includes("I confirm creating a new visual identity version"),
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
    ].find((button) => button.textContent?.includes("Confirm current look"));
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
      async (path: string, options?: { method?: string; body?: unknown }) => {
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
      () => container.textContent?.includes("Adopt this image") === true,
    );
    expect(container.textContent).toContain("Actual seed");
    expect(container.textContent).toContain(
      "I have checked the subject, framing, and image quality, and this image can serve as the visual identity",
    );

    const adopt = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Adopt this image");
    const qualityConfirmation = [...container.querySelectorAll("label")]
      .find((label) =>
        label.textContent?.includes("I have checked the subject, framing"),
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
      () => container.textContent?.includes("Set as current look") === true,
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
        container.textContent?.includes("has no usable composition check on record") === true,
    );

    const adopt = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Adopt this image");
    expect(adopt).toBeUndefined();
    expect(
      [...container.querySelectorAll("label")].some((label) =>
        label.textContent?.includes("I have checked the subject, framing"),
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
        container.textContent?.includes("has no usable composition check on record") === true,
    );

    const activate = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Set as current look");
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

  // SPEC: 这个工作台整页曾是硬编码中文，英文环境下打开「视觉」tab 第一屏全是中文。
  // 锁住两件事：英文环境不再漏中文，中文环境每个键都真的查得到译文（漏键会回落成英文）。
  it("renders locale-appropriate copy in both English and Chinese", async () => {
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
      () => container.textContent?.includes("Creation history") === true,
    );
    expect(container.textContent).not.toMatch(/[㐀-鿿]/u);
    expect(
      container.querySelector('textarea[aria-label="Describe the look you want"]'),
    ).not.toBeNull();

    await act(async () =>
      root.render(
        <AdminI18nProvider locale="zh">
          <VisualIdentityExperimentWorkbench
            canActivate
            canCreate
            canReview
            canUploadSource
            data={data}
            onActivateCandidate={vi.fn(async () => undefined)}
          />
        </AdminI18nProvider>,
      ),
    );
    await waitUntil(() => container.textContent?.includes("历史创作") === true);
    expect(container.textContent).toContain("当前形象");
    expect(container.textContent).toContain("想让 Mira 变成什么样？");
    expect(container.textContent).toContain("高级设置");
    expect(
      container.querySelector('textarea[aria-label="描述这次想要的画面"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="生成 1 张候选图"]'),
    ).not.toBeNull();
  });
});
