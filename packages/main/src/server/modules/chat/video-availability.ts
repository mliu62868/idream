import { Errors } from "@/server/lib/errors";
import { featureFlagEnabled } from "@/server/modules/ourdream/generation-profile-catalog";
import { entitlementMap } from "@/server/modules/ourdream/subscription-lifecycle";

export async function chatVideoCapability(userId: string) {
  const [chatEnabled, videoEnabled, entitlements] = await Promise.all([
    featureFlagEnabled("chat_video"), featureFlagEnabled("video_gen"), entitlementMap(userId),
  ]);
  return {
    enabled: chatEnabled && videoEnabled,
    // INVARIANT: report exactly what quote/create admission enforces. The request
    // requires the user's motion text, which the shared quote gates behind
    // premium_controls; subscriptions derive both, a lone video grant does not.
    entitled: Boolean(entitlements.video_generation && entitlements.premium_controls),
    requiredEntitlement: "video_generation" as const,
    requiresSourceImage: true as const,
  };
}

// This product gate is independent of the shared video renderer. Historical
// attachments are read through the Turn Ledger and never call this admission gate.
export async function assertChatVideoAvailable(userId: string) {
  const capability = await chatVideoCapability(userId);
  if (!capability.enabled) throw Errors.forbidden("New Chat videos are currently unavailable. Your earlier videos remain in this chat.");
  if (!capability.entitled) throw Errors.paymentRequired("Chat video requires Deluxe video access", { entitlement: capability.requiredEntitlement });
}
