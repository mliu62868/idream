import type { RuntimeChatMessage as ChatMessage } from "@/lib/public-api-contracts";
import { isLocalChatMessageId } from "../chat-message-actions";

// SPEC: Per-tab conveniences for one conversation of one signed-in owner:
//       the unsent composer draft and the last few messages to paint while the
//       first read is in flight. sessionStorage dies with the tab and every
//       key names the owner, so another account in the same tab reads nothing.
// INVARIANT: storage is best effort — private windows and blocked storage
//            throw, and the page must work exactly the same without it.

const CACHED_MESSAGE_LIMIT = 30;
const CACHED_CONTENT_LIMIT = 4_000;
const DRAFT_LIMIT = 20_000;

export type ChatStorageScope = { readonly ownerScope: string | null; readonly groupMode: boolean; readonly id: string };
export type CachedChatMessage = Pick<ChatMessage, "id" | "role" | "content" | "status" | "speakerName">;

function storageKey(kind: "draft" | "recent", scope: ChatStorageScope): string | null {
  if (!scope.ownerScope?.startsWith("user:")) return null;
  return `idream:chat-${kind}:${scope.ownerScope}:${scope.groupMode ? "group" : "single"}:${scope.id}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string | null): string | null {
  if (!key) return null;
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string | null, value: string | null) {
  if (!key) return;
  try {
    const store = storage();
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Quota or privacy mode: the draft simply is not kept.
  }
}

export function readChatDraft(scope: ChatStorageScope): string {
  return read(storageKey("draft", scope)) ?? "";
}

export function writeChatDraft(scope: ChatStorageScope, draft: string) {
  write(storageKey("draft", scope), draft.trim() ? draft.slice(0, DRAFT_LIMIT) : null);
}

export function readCachedChatMessages(scope: ChatStorageScope): CachedChatMessage[] {
  const raw = read(storageKey("recent", scope));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): CachedChatMessage[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.role !== "string" || typeof record.content !== "string") return [];
      return [{
        id: record.id,
        role: record.role,
        content: record.content,
        ...(typeof record.status === "string" ? { status: record.status } : {}),
        ...(typeof record.speakerName === "string" ? { speakerName: record.speakerName } : {}),
      }];
    }).slice(-CACHED_MESSAGE_LIMIT);
  } catch {
    return [];
  }
}

/** Keeps the settled text of the latest messages; media and drafts stay out. */
export function writeCachedChatMessages(scope: ChatStorageScope, messages: readonly ChatMessage[]) {
  const recent = messages
    .filter((message) => !isLocalChatMessageId(message.id) && message.content.trim()
      && message.status !== "generating" && message.status !== "pending")
    .slice(-CACHED_MESSAGE_LIMIT)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, CACHED_CONTENT_LIMIT),
      ...(message.status ? { status: message.status } : {}),
      ...(message.speakerName ? { speakerName: message.speakerName } : {}),
    }));
  write(storageKey("recent", scope), recent.length ? JSON.stringify(recent) : null);
}

/** Forget everything kept for a conversation its owner can no longer open. */
export function clearChatSessionStorage(scope: ChatStorageScope) {
  write(storageKey("draft", scope), null);
  write(storageKey("recent", scope), null);
}
