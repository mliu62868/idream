import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { incrementCounter, observeHistogram, resetMetricsForTests } from "@idream/shared";
import { prisma } from "@/server/lib/db";
import { adminSloReadiness } from "./admin-slo-readiness";

describe("Admin SLO readiness", () => {
  const prefix = `admin-slo-${randomUUID()}`;

  afterAll(async () => {
    await prisma.mainOutboxEvent.deleteMany({
      where: { id: { startsWith: prefix } },
    });
  });

  it("keeps missing surface evidence explicit and blocks incomplete launch decisions", async () => {
    resetMetricsForTests();
    incrementCounter("admin_command_total", "commands", { type: "test", outcome: "accepted" }, 100);
    observeHistogram("admin_command_duration_seconds", "duration", { type: "test", outcome: "accepted" }, 0.2);
    const report = await adminSloReadiness(new Date());
    expect(report.report.checks.find((check) => check.key === "command_accept_p95")).toMatchObject({ status: "pass" });
    expect(report.report.checks.find((check) => check.key === "list_api_p95")).toMatchObject({ status: "no_data" });
    expect(report.decisionUse).toBe("blocked");
    resetMetricsForTests();
  });

  it("measures owned transport lag without counting local evidence rows", async () => {
    const now = new Date("2026-07-18T09:00:00.000Z");
    await prisma.mainOutboxEvent.createMany({
      data: [
        {
          id: `${prefix}-local-evidence`,
          eventType: "character.release.qualification_stale.v2",
          aggregateType: "character_release",
          aggregateId: `${prefix}-release`,
          payload: {},
          status: "pending",
          createdAt: new Date("2000-01-01T00:00:00.000Z"),
        },
        {
          id: `${prefix}-owned-transport`,
          eventType: "chat.image.failed",
          aggregateType: "chat_effect",
          aggregateId: `${prefix}-attachment`,
          payload: {},
          status: "pending",
          createdAt: new Date(now.getTime() - 30_000),
        },
      ],
    });

    const report = await adminSloReadiness(now);
    const outboxLag = report.report.checks.find((check) => check.key === "outbox_lag_p95");
    expect(outboxLag?.observed).toBeGreaterThanOrEqual(30);
    expect(outboxLag?.observed).toBeLessThan(60 * 60);
  });
});
