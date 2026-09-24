// SPEC: 角色发布新版本（Release）后，钉在旧版本上的会话只读；在里面发消息，Main 回
//   410 + details.reason="character_release_changed"。页面据此打开该角色的当前会话，
//   把没发出去的那句话带过去预填，而不是报一句「聊天不可用」。
// INTENT: 只预填、不自动代发 —— 角色刚换了人设，让用户看一眼再发最不意外；410 发生在
//   Turn 与额度记账之前，所以这里没有任何需要补偿或去重的扣费。
// INVARIANT: 草稿经 sessionStorage 交接（同一标签页、不进 URL/历史）；存不进去时调用方
//   不跳转，留在原页把话留在输入框里并如实说明。

const HANDOFF_PREFIX = "idream:chat-release-handoff:";

/** The Character whose update made this chat read-only, or null for any other failure. */
export function chatReleaseChangedCharacterId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const envelope = payload as { error?: unknown; details?: unknown };
  // Chat façade: { error: code, details }; Main envelope: { error: { code, details } }.
  const details = envelope.details ?? (
    envelope.error && typeof envelope.error === "object"
      ? (envelope.error as { details?: unknown }).details
      : undefined
  );
  if (!details || typeof details !== "object") return null;
  const { reason, characterId } = details as { reason?: unknown; characterId?: unknown };
  return reason === "character_release_changed" && typeof characterId === "string" && characterId
    ? characterId
    : null;
}

export function stashChatReleaseHandoff(sessionId: string, draft: string): boolean {
  try {
    window.sessionStorage.setItem(`${HANDOFF_PREFIX}${sessionId}`, draft);
    return true;
  } catch {
    return false;
  }
}

/** Reads the handed-over draft once; a reload of the new chat does not refill it. */
export function takeChatReleaseHandoff(sessionId: string): string | null {
  try {
    const key = `${HANDOFF_PREFIX}${sessionId}`;
    const draft = window.sessionStorage.getItem(key);
    if (draft !== null) window.sessionStorage.removeItem(key);
    return draft;
  } catch {
    return null;
  }
}
