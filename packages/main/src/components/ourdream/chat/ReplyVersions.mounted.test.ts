// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeChatMessage } from "@/lib/public-api-contracts";
import { ChatMessageItem, type ChatAttachmentContext, type ChatMessageHandlers } from "./ChatMessageItem";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const noop = () => {};
function handlers(selectVersion: ChatMessageHandlers["selectVersion"]): ChatMessageHandlers {
  return {
    beginEdit: noop, cancelEdit: noop, saveEdit: noop, changeEdit: noop, report: noop, remove: noop, regenerate: noop,
    selectVersion, play: noop, confirmVoice: noop, dismissVoice: noop, retryAttachment: async () => {},
    refreshAttachments: async () => {}, addToIdentity: noop, identityFeedback: noop, moreLikeThis: noop, animate: noop,
    continueReply: noop,
  };
}

const attachmentContext = {} as ChatAttachmentContext;

async function render(message: RuntimeChatMessage, selectVersion = vi.fn()) {
  await act(async () => {
    root.render(createElement(ChatMessageItem, {
      message, groupMode: false, canEdit: false, canRegenerate: true, canDelete: false, canContinue: false,
      deleteConfirm: false, actionsPending: false, voiceConfirmation: null, editing: null, attachmentContext,
      handlers: handlers(selectVersion),
    }));
  });
  return selectVersion;
}

function text() {
  return container.querySelector("[data-chat-text]")?.textContent ?? "";
}
function button(label: string) {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`${label} missing`);
  return found;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("reply versions", () => {
  it("browses versions locally and adopts one with the observed attempt", async () => {
    const selectVersion = await render({
      id: "reply-1", role: "assistant", content: "Third.", status: "sent", attempt: 3,
      replyVersions: [
        { ordinal: 1, content: "First.", current: false },
        { ordinal: 2, content: "Second.", current: false },
        { ordinal: 3, content: "Third.", current: true },
      ],
    });
    expect(container.textContent).toContain("3 / 3");
    expect(container.querySelector('[data-testid="chat-use-reply-version"]')).toBeNull();

    await click(button("Previous version"));
    expect(text()).toBe("Second.");
    expect(container.textContent).toContain("2 / 3");
    await click(button("Previous version"));
    expect(text()).toBe("First.");
    expect(button("Previous version").disabled).toBe(true);

    await click(container.querySelector<HTMLButtonElement>('[data-testid="chat-use-reply-version"]')!);
    expect(selectVersion).toHaveBeenCalledWith("reply-1", 1, 3);

    // Returning to the current version hides the adopt action again.
    await click(button("Next version"));
    await click(button("Next version"));
    expect(text()).toBe("Third.");
    expect(container.querySelector('[data-testid="chat-use-reply-version"]')).toBeNull();
  });

  it("offers earlier versions after a regenerate that failed", async () => {
    await render({
      id: "reply-2", role: "assistant", content: "", status: "failed", attempt: 2,
      replyVersions: [{ ordinal: 1, content: "Earlier reply.", current: false }],
    });
    expect(container.textContent).toContain("2 / 2");
    expect(container.textContent).toContain("Reply unavailable");
    await click(button("Previous version"));
    expect(text()).toBe("Earlier reply.");
    expect(container.querySelector('[data-testid="chat-use-reply-version"]')).not.toBeNull();
  });
});
