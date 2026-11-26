import type { RuntimeChatMessage as ChatMessage, RuntimeChatSession as ChatSession } from "@/lib/public-api-contracts";
import { isLocalChatMessageId } from "../chat-message-actions";

// SPEC: Main returns the latest page of Turns by default and pages backwards
//       with `beforeTurnId`. A read without page metadata is the complete
//       conversation (older servers, group reads).
export type ChatSessionPage = { readonly hasEarlier: boolean; readonly earliestTurnId: string | null };

export const COMPLETE_CHAT_SESSION_PAGE: ChatSessionPage = { hasEarlier: false, earliestTurnId: null };
export const CHAT_EARLIER_PAGE_LIMIT = 50;

export function parseChatSessionPage(value: unknown): ChatSessionPage {
  if (!value || typeof value !== "object") return COMPLETE_CHAT_SESSION_PAGE;
  const record = value as { hasEarlier?: unknown; earliestTurnId?: unknown };
  const earliestTurnId = typeof record.earliestTurnId === "string" && record.earliestTurnId ? record.earliestTurnId : null;
  // Without a cursor there is nothing to ask for, whatever the flag says.
  return { hasEarlier: record.hasEarlier === true && earliestTurnId !== null, earliestTurnId };
}

/** Page metadata may sit beside the session or inside it; accept either. */
export function chatSessionPageFromPayload(payload: unknown): ChatSessionPage {
  const data = (payload as { data?: { page?: unknown; session?: { page?: unknown } } } | null)?.data;
  return parseChatSessionPage(data?.page ?? data?.session?.page);
}

export function chatSessionPage(session: ChatSession): ChatSessionPage {
  return parseChatSessionPage((session as { page?: unknown }).page);
}

// SPEC: Apply Main's snapshot of the latest page without losing what the
//       reader already holds:
//       - earlier messages paged in above a partial page stay in place;
//       - an optimistic local turn stays until Main's snapshot carries the same
//         request key (then the canonical turn replaces it, never both).
// INVARIANT: a complete snapshot (no earlier page) is the whole conversation,
//            so messages it no longer lists are dropped.
export function mergeChatSessionSnapshot(
  current: readonly ChatMessage[],
  snapshot: readonly ChatMessage[],
  page: ChatSessionPage,
): ChatMessage[] {
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  const snapshotKeys = new Set(snapshot.flatMap((message) => message.requestKey ? [message.requestKey] : []));
  let earlier: ChatMessage[] = [];
  if (page.hasEarlier) {
    const overlap = current.findIndex((message) => snapshotIds.has(message.id));
    if (overlap > 0) {
      earlier = current.slice(0, overlap).filter((message) => !isLocalChatMessageId(message.id));
    }
  }
  const local = current.filter((message) => isLocalChatMessageId(message.id)
    && !(message.requestKey && snapshotKeys.has(message.requestKey)));
  return [...earlier, ...snapshot, ...local];
}

/** Older messages go above the current list; ids already present win. */
export function prependEarlierMessages(
  current: readonly ChatMessage[],
  earlier: readonly ChatMessage[],
): ChatMessage[] {
  const present = new Set(current.map((message) => message.id));
  return [...earlier.filter((message) => !present.has(message.id)), ...current];
}
