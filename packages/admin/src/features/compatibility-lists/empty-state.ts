export type CanonicalListAuthority =
  | "ledger"
  | "subscriptions"
  | "audit"
  | "dead_letter"
  | "chat_sessions"
  | "approvals";

const titles: Record<CanonicalListAuthority, readonly [string, string]> = {
  ledger: ["No ledger entries exist yet", "No ledger entries match these filters"],
  subscriptions: ["No subscriptions exist yet", "No subscriptions match these filters"],
  audit: ["No audit events exist yet", "No audit events match these filters"],
  dead_letter: ["No dead-letter jobs", "No dead-letter jobs match these filters"],
  chat_sessions: ["No chat sessions exist yet", "No chat sessions match these filters"],
  approvals: ["No approval requests are pending", "No approval requests match these filters"],
};

export function canonicalListEmptyTitle(
  authority: CanonicalListAuthority,
  filtered: boolean,
) {
  return titles[authority][filtered ? 1 : 0];
}
