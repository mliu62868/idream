import { prisma } from "@/server/lib/db";
import { logger } from "@/server/lib/logger";
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

// INTENT: legacy product telemetry must never turn a committed authentication
// or age-authority transition into a user-visible failure. Canonical signup
// evidence remains transactional; this helper makes only the secondary event
// explicitly best-effort and observable.
export async function trackEventBestEffort(
  name: string,
  props: unknown,
  ctx: ProductEventActor,
) {
  try {
    return await trackEvent(name, props, ctx);
  } catch (error) {
    logger.error(
      {
        error,
        eventName: name,
        userId: ctx.userId ?? null,
        anonymousId: ctx.anonymousId ?? null,
      },
      "non-blocking product telemetry write failed",
    );
    return null;
  }
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
