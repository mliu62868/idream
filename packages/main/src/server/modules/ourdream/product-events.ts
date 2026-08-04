import { prisma } from "@/server/lib/db";
import { createClassifiedAnalyticsEvent } from "@/server/modules/admin-v2/metrics/classified-event-writer";

type ProductEventActor = { userId?: string; anonymousId?: string };

export async function trackEvent(
  name: string,
  props: unknown,
  ctx: ProductEventActor,
) {
  return createClassifiedAnalyticsEvent(prisma, {
    userId: ctx.userId,
    anonymousId: ctx.anonymousId,
    name,
    props,
  });
}

export async function trackEventOnce(
  name: string,
  props: unknown,
  ctx: ProductEventActor,
  sourceEventId: string,
) {
  return createClassifiedAnalyticsEvent(prisma, {
    userId: ctx.userId,
    anonymousId: ctx.anonymousId,
    name,
    props,
    sourceEventId,
  });
}
