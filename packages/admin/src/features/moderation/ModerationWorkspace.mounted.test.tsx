// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiWrite: vi.fn<
    (
      path: string,
      method: "POST" | "PATCH" | "PUT",
      body: Record<string, unknown>,
      headers?: Record<string, string>,
    ) => Promise<unknown>
  >(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

import { ToastProvider } from "@/components/admin/ui/Toast";
import { ModerationWorkspace } from "./ModerationWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mediaId = "media-review-pending-1";
const characterId = "character-review-1";
const idempotencyKey = "11111111-1111-4111-8111-111111111111";
const mediaRow = {
  id: mediaId,
  characterId,
  ownerId: "owner-review-1",
  safetyStatus: "unknown",
  thumbnailUrl: `/user-content/${mediaId}/thumbnail.webp`,
  url: `/user-content/${mediaId}/content.webp`,
  sourceAssetId: "source-media-1",
  reviewKind: "duplicate_identity",
  createdAt: "2026-07-17T12:00:00.000Z",
};
const pageInfo = { endCursor: null, hasNextPage: false };

describe("ModerationWorkspace media-review interaction", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mediaReads: number;

  beforeEach(() => {
    window.history.replaceState(null, "", "/admin/moderation");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mediaReads = 0;
    apiGet.mockReset();
    apiWrite.mockReset();
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(idempotencyKey);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it.each([
    {
      actionLabel: "Approve image",
      decision: "passed",
    },
    {
      actionLabel: "Block image",
      decision: "blocked",
    },
  ] as const)(
    "confirms $actionLabel with exact authority payload and refreshes the queue",
    async ({ actionLabel, decision }) => {
      apiGet.mockImplementation(async (path) => {
        if (path.includes("scope=media")) {
          mediaReads += 1;
          return {
            mediaReview: mediaReads === 1 ? [mediaRow] : [],
            pageInfo: { mediaReview: pageInfo },
          };
        }
        if (path.includes("scope=reports")) {
          return { reports: [], pageInfo: { reports: pageInfo } };
        }
        if (path.includes("scope=appeals")) {
          return { appeals: [], pageInfo: { appeals: pageInfo } };
        }
        throw new Error(`Unexpected moderation request: ${path}`);
      });
      apiWrite.mockResolvedValue({ id: mediaId, safetyStatus: decision });

      await act(async () => {
        root.render(
          <ToastProvider>
            <ModerationWorkspace canDecide />
          </ToastProvider>,
        );
      });
      await waitUntil(() => mediaPreview() !== null);

      expect(container.textContent).toContain(
        "independently pending Character images",
      );
      expect(container.textContent).toContain("Media Review");
      expect(container.textContent).toContain("unknown");
      expect(container.textContent).toContain("Duplicate of source-media-1");
      expect(mediaPreview()?.getAttribute("src")).toBe(mediaRow.thumbnailUrl);
      expect(
        container.querySelector(
          `a[href="/admin/characters/${characterId}?tab=assets"]`,
        ),
      ).not.toBeNull();

      await click(findButton(actionLabel, container));
      const dialog = await waitForDialog();
      expect(dialog.textContent).toContain(
        `${actionLabel} Character image ${mediaId}`,
      );
      const submit = findButton("Confirm", dialog);
      expect(submit?.disabled).toBe(true);

      await enter(
        dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]'),
        `${actionLabel} after independent image review`,
      );
      await enter(
        dialog.querySelector<HTMLInputElement>(
          'input[aria-label="Confirmation"]',
        ),
        mediaId,
      );
      expect(submit?.disabled).toBe(false);
      await click(submit);

      await waitUntil(() => apiWrite.mock.calls.length === 1);
      await waitUntil(() => mediaReads === 2);
      await waitUntil(() => document.querySelector('[role="dialog"]') === null);

      expect(apiWrite).toHaveBeenCalledWith(
        `/api/v2/admin/moderation/media/${mediaId}/decision`,
        "POST",
        {
          decision,
          reason: `${actionLabel} after independent image review`,
          confirmation: mediaId,
        },
        { "idempotency-key": idempotencyKey },
      );
      expect(actionToast()?.textContent).toContain(
        `Decision recorded for ${mediaId}`,
      );
      expect(actionToast()?.getAttribute("data-tone")).toBe("success");
      expect(mediaPreview()).toBeNull();
      expect(container.textContent).toContain(
        "No Character images await independent review",
      );
    },
  );

  it("keeps the pending image and dialog error when a Block decision fails", async () => {
    apiGet.mockImplementation(async (path) => {
      if (path.includes("scope=media")) {
        mediaReads += 1;
        return {
          mediaReview: [mediaRow],
          pageInfo: { mediaReview: pageInfo },
        };
      }
      if (path.includes("scope=reports")) {
        return { reports: [], pageInfo: { reports: pageInfo } };
      }
      if (path.includes("scope=appeals")) {
        return { appeals: [], pageInfo: { appeals: pageInfo } };
      }
      throw new Error(`Unexpected moderation request: ${path}`);
    });
    apiWrite.mockRejectedValue(
      new Error("Media authority changed before this decision"),
    );

    await act(async () => {
      root.render(
        <ToastProvider>
          <ModerationWorkspace canDecide />
        </ToastProvider>,
      );
    });
    await waitUntil(() => mediaPreview() !== null);
    await click(findButton("Block image", container));
    const dialog = await waitForDialog();
    await enter(
      dialog.querySelector<HTMLInputElement>('input[aria-label="Reason"]'),
      "Block after independent image review",
    );
    await enter(
      dialog.querySelector<HTMLInputElement>(
        'input[aria-label="Confirmation"]',
      ),
      mediaId,
    );
    await click(findButton("Confirm", dialog));
    await waitUntil(() =>
      Boolean(
        dialog
          .querySelector('[role="alert"]')
          ?.textContent?.includes("This action did not complete."),
      ),
    );
    // 原文一个字都不能丢——它折在「技术详情」里，工程要拿它对日志。
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "Media authority changed before this decision",
    );

    expect(apiWrite).toHaveBeenCalledWith(
      `/api/v2/admin/moderation/media/${mediaId}/decision`,
      "POST",
      {
        decision: "blocked",
        reason: "Block after independent image review",
        confirmation: mediaId,
      },
      { "idempotency-key": idempotencyKey },
    );
    expect(mediaReads).toBe(1);
    expect(mediaPreview()).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(actionToast()).toBeNull();
  });

  function actionToast() {
    return document.body.querySelector('[data-testid="admin-action-status"]');
  }

  function mediaPreview() {
    return container.querySelector<HTMLImageElement>(
      `img[alt="Character image ${mediaId}"]`,
    );
  }
});

function findButton(label: string, root: ParentNode = document) {
  return (
    [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.getAttribute("aria-label") === label ||
        button.textContent?.trim() === label,
    ) ?? null
  );
}

async function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function enter(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    if (!input) return;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForDialog() {
  await waitUntil(() => document.querySelector('[role="dialog"]') !== null);
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Moderation confirmation dialog did not mount");
  return dialog;
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for ModerationWorkspace state");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
