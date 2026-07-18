import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "@/server/lib/env";
import { toInputJson } from "../shared/prisma-json";
import { classifyMetricSubject } from "./event-classification";

type Db = PrismaClient | Prisma.TransactionClient;

export async function createClassifiedAnalyticsEvent(
  db: Db,
  input: {
    readonly userId?: string | null;
    readonly anonymousId?: string | null;
    readonly name: string;
    readonly props: unknown;
    readonly occurredAt?: Date;
    readonly sourceService?: string;
    readonly sourceEventId?: string;
    readonly trustClass?: string;
  },
) {
  const classification = await classifyMetricSubject(db, {
    userId: input.userId ?? null,
    anonymousId: input.anonymousId ?? null,
  });
  const data = {
    userId: input.userId ?? null,
    anonymousId: input.anonymousId ?? null,
    name: input.name,
    props: toInputJson(input.props),
    sourceService: input.sourceService ?? "web",
    sourceEventId: input.sourceEventId ?? null,
    occurredAt: input.occurredAt ?? new Date(),
    environment: env.APP_ENV,
    dataClass: classification.dataClass,
    trustClass: input.trustClass ?? "client_untrusted",
    actor: toInputJson(classification.actor),
  };
  if (!input.sourceEventId) {
    return db.analyticsEvent.create({ data });
  }
  try {
    return await db.analyticsEvent.upsert({
      where: {
        sourceService_sourceEventId: {
          sourceService: data.sourceService,
          sourceEventId: input.sourceEventId,
        },
      },
      update: {},
      create: data,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    return db.analyticsEvent.findUniqueOrThrow({
      where: {
        sourceService_sourceEventId: {
          sourceService: data.sourceService,
          sourceEventId: input.sourceEventId,
        },
      },
    });
  }
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
