import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { providers } from "@/server/providers";

// SPEC: text moderation and its immutable decision event are one operation.
// INVARIANT: callers may act on the returned decision only after the event is durable.
export async function moderateText(
  targetType: string,
  targetId: string,
  content: string,
  layer: string,
) {
  const result = await providers.moderation.check({
    targetType: "text",
    content,
  });
  if (!result.ok) throw Errors.internal(result.error.message, result.error);

  await prisma.moderationEvent.create({
    data: {
      targetType,
      targetId,
      layer,
      status: result.data.status,
      policyCode: result.data.policyCode,
      confidence: result.data.confidence,
      details: {},
    },
  });

  return result.data;
}
