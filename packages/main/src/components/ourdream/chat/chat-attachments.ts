const ACTIVE_CHAT_ATTACHMENT_STATUSES = new Set([
  "requesting",
  "accepted",
  "queued",
  "running",
]);

export function chatAttachmentIsActive(status: string, errorCode?: string | null): boolean {
  return ACTIVE_CHAT_ATTACHMENT_STATUSES.has(status) && errorCode !== "provider_outcome_unknown";
}

// The sweeper can settle an unconfirmed result while nobody is sending anything.
export function chatAttachmentIsUnconfirmed(status: string, errorCode?: string | null): boolean {
  return errorCode === "provider_outcome_unknown" && ACTIVE_CHAT_ATTACHMENT_STATUSES.has(status);
}

// SPEC: 聊天里出的图，在它还在跑和交付之后都要能看到扣了多少币。
// INTENT: 语音有一张完整的报价确认卡，图片是模型按用户的话直接下单的，用户此前
//   在聊天里看不到任何金额，只能事后去 Profile 对账。失败/退款态不报这个数——
//   这里拿不到实际退回多少，说「8 coins」会变成谎话。
export function chatAttachmentCostLabel(attachment: {
  costDreamcoins?: number | null;
  status: string;
}): string | null {
  const cost = attachment.costDreamcoins;
  if (typeof cost !== "number" || cost <= 0) return null;
  if (!chatAttachmentIsActive(attachment.status) && attachment.status !== "completed") {
    return null;
  }
  return `${cost} ${cost === 1 ? "coin" : "coins"}`;
}
