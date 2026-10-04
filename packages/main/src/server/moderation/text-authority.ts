import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";

// Release validation records this decision in its own immutable check results.
export async function checkTextModeration(content: string) {
  const result = await providers.moderation.check({
    targetType: "text",
    content,
  });
  if (!result.ok) throw Errors.internal(result.error.message, result.error);
  return result.data;
}

// SPEC: text moderation and its immutable decision event are one operation.
// INVARIANT: callers may act on the returned decision only after the event is durable.
export async function moderateText(
  targetType: string,
  targetId: string,
  content: string,
  layer: string,
) {
  const decision = await checkTextModeration(content);

  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer,
      status: decision.status,
      policyCode: decision.policyCode,
      confidence: decision.confidence,
      details: {},
    },
  });

  return decision;
}
