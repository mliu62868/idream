import type { RuntimeChatSession as ChatSession } from "@/lib/public-api-contracts";

export type ChatContinuation = NonNullable<ChatSession["continuation"]>;

// SPEC: The conversation header, composer gates and drawers all read one
//       snapshot of session metadata. Main's session read is its only writer,
//       apart from the few local confirmations below.
export type ChatSessionMetadata = {
  readonly title: string;
  readonly characterId: string | null;
  readonly group: ChatSession["group"];
  readonly archived: boolean;
  readonly continuation: ChatContinuation;
  readonly canUpdateIdentity: boolean;
  readonly characterImage: string | null;
  readonly memberImages: Readonly<Record<string, string>>;
  readonly memoryEnabled: boolean;
  readonly proactiveEnabled: boolean;
};

export type ChatSessionMetadataAction =
  | { readonly type: "reset" }
  | { readonly type: "session"; readonly session: ChatSession }
  | { readonly type: "archived" }
  | { readonly type: "continuation"; readonly continuation: ChatContinuation }
  | { readonly type: "memory"; readonly enabled: boolean }
  | { readonly type: "proactive"; readonly enabled: boolean };

export const INITIAL_CHAT_SESSION_METADATA: ChatSessionMetadata = {
  title: "Chat",
  characterId: null,
  group: undefined,
  archived: false,
  continuation: "available",
  canUpdateIdentity: false,
  characterImage: null,
  memberImages: {},
  memoryEnabled: true,
  proactiveEnabled: false,
};

export function chatSessionMetadataReducer(
  state: ChatSessionMetadata,
  action: ChatSessionMetadataAction,
): ChatSessionMetadata {
  switch (action.type) {
    case "reset":
      return INITIAL_CHAT_SESSION_METADATA;
    case "session": {
      const { session } = action;
      return {
        // 角色行可能已经不存在了（创作者注销会硬删他的角色，且不通知 chat）。
        // BFF 在那种情况下把 name 兜成空串，直接用会渲染出一个无名会话头。
        title: session.title || session.character.name || "Unavailable character",
        characterId: session.characterId || state.characterId,
        group: session.group,
        archived: session.status === "archived",
        continuation: session.continuation ?? "available",
        canUpdateIdentity: Boolean(session.character.canUpdateIdentity),
        characterImage: session.character.image ?? null,
        memberImages: session.memberImages ?? {},
        memoryEnabled: typeof session.memoryEnabled === "boolean" ? session.memoryEnabled : state.memoryEnabled,
        proactiveEnabled: session.proactiveEnabled === true,
      };
    }
    case "archived":
      return state.archived ? state : { ...state, archived: true };
    case "continuation":
      return state.continuation === action.continuation ? state : { ...state, continuation: action.continuation };
    case "memory":
      return state.memoryEnabled === action.enabled ? state : { ...state, memoryEnabled: action.enabled };
    case "proactive":
      return state.proactiveEnabled === action.enabled ? state : { ...state, proactiveEnabled: action.enabled };
  }
}

export function chatSessionIsReadOnly(metadata: Pick<ChatSessionMetadata, "archived" | "continuation">): boolean {
  return metadata.archived || metadata.continuation !== "available";
}
