// SPEC: 把 chat 服务的错误码翻译成一句读者看得懂、且下一步是对的话。
// INTENT: chat 服务分得出 30 个错误码，界面却只按 HTTP 状态分支，最终全部坍缩成
//   "Message failed to send. Please try again." 之类的四句话。问题不只是笼统 ——
//   **有些情况下「请重试」是错的建议**：角色已下架、账号被限制、消息已不可编辑，
//   重试永远不会成功，用户只会一直点。
// INVARIANT: 查不到的码回落到调用方给的那句通用文案，**不回落成裸错误码** ——
//   这里和 generation-failure-copy 的取舍不同：生成任务的码（provider_timeout）
//   对用户还有点线索价值，聊天的码（message_version_drift）纯属内部黑话，
//   给了不如不给。
const CHAT_FAILURE_COPY: Readonly<Record<string, string>> = {
  // Main owns these routes and reports standard AppError codes.
  gone: "This chat is no longer active. Start a new chat to continue.",
  not_found: "This chat or message no longer exists. Reload your chats.",
  // —— 角色侧：重试无用，得换个角色 ——
  character_not_found: "This character is no longer available.",
  character_unavailable: "This character isn't available right now. Try another one.",
  character_underage: "This character can't be used.",

  // —— 账号侧：重试无用 ——
  user_inactive: "Your account isn't active, so this couldn't be sent.",
  restricted: "Your account doesn't have access to this.",
  forbidden: "You don't have access to this chat.",
  age_gate_required: "Confirm you're over 18 to continue.",

  // —— 等一下就好 ——
  rate_limited: "You're sending a bit fast. Wait a moment and try again.",
  reply_in_progress: "Wait for the current reply to finish, then send again.",
  service_not_ready: "Chat is still starting up. Try again in a few seconds.",
  memory_updating: "Still updating this Character's memory. Try again in a few seconds.",
  // Chat never picked up the pending reply; the turn is kept for a new attempt.
  admission_expired: "This reply didn't start in time. Your message is saved — regenerate to try again.",

  // —— 用户可以自己改的 ——
  message_too_long: "That message is too long. Shorten it and send again.",
  empty_message: "Type something before sending.",

  // —— 会话 / 消息状态：重试无用 ——
  session_not_found: "This chat no longer exists.",
  session_not_active: "This chat has been archived. Start a new one to keep talking.",
  message_not_found: "That message no longer exists.",
  message_generating: "That reply is still being written. Wait for it to finish.",
  message_not_editable: "That message can't be edited any more.",
  message_not_regenerable: "That reply can't be regenerated.",
  message_version_drift: "This chat moved on while you were editing. Reload and try again.",
  message_version_ambiguous: "This chat moved on while you were editing. Reload and try again.",
  missing_user_turn: "That reply has no message to regenerate from.",

  // —— Main `conflict` reasons (details.reason / details.blocker) ——
  chat_send_deleted: "That message was deleted. Send again to make a new request.",
  chat_send_protocol_required: "This send request expired. Review your draft and send it again.",
  edit_attempt_changed: "This reply changed elsewhere. Reopen the editor to use the latest message.",
  edit_attempt_required: "This reply changed elsewhere. Reopen the editor to use the latest message.",
  edit_key_conflict: "This edit changed while it was being saved. Reopen the editor and save again.",
  version_mismatch: "This changed elsewhere. Reload and try again.",
  viewer_changed: "Your account changed. Reload to continue.",
  group_conversation: "Open this conversation from its group chat.",

  // —— 图片附件 ——
  attachment_not_found: "That image request no longer exists.",
  attachment_not_confirmable: "That image request can't be confirmed any more.",
  voice_quote_required: "Press Play to review and confirm the voice price first.",
  voice_quote_stale: "This voice quote expired or changed. Press Play to review a new price.",
  voice_quote_limit_exceeded: "This clip would exceed the accepted voice price. It has not been delivered at a higher price.",
};

/**
 * 从 chat 的错误响应体里取出可展示的一句话。
 * `fallback` 是各调用点原有的通用文案，认不出的码一律用它。
 */
// INVARIANT: a `conflict` is shown only through its machine-readable reason.
//   Main's conflict *messages* mix reader guidance with internal invariants and
//   change wording freely, so matching their text is never a contract; an
//   unrecognised conflict gets the caller's own sentence.
export function chatFailureCopy(payload: unknown, fallback: string): string {
  const code = chatFailureCode(payload);
  if (!code || code === "conflict") return fallback;
  return CHAT_FAILURE_COPY[code] ?? fallback;
}

/** Main's product errors and Chat's stream errors use distinct envelopes. */
export function chatFailureCode(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) {
    return error.trim() === "conflict" ? conflictReason((payload as { details?: unknown }).details) : error.trim();
  }
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code === "conflict") return conflictReason((error as { details?: unknown }).details);
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return null;
}

function conflictReason(details: unknown): string {
  const record = details && typeof details === "object" ? details as { reason?: unknown; blocker?: unknown } : {};
  if (typeof record.reason === "string" && Object.hasOwn(CHAT_FAILURE_COPY, record.reason)) return record.reason;
  if (record.blocker === "version_mismatch") return "version_mismatch";
  return "conflict";
}
