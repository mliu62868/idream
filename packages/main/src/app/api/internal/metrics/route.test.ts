import { describe, expect, it } from "vitest";
import { incrementCounter, resetMetricsForTests } from "@idream/shared";
import { env } from "@/server/lib/env";
import { GET } from "./route";

describe("Main metrics exporter", () => {
  it("requires the internal token and renders process metrics", async () => {
    resetMetricsForTests();
    expect((await GET(new Request("http://main.local/api/internal/metrics"))).status).toBe(401);
    incrementCounter("main_inbound_events_total", "Inbound events", { outcome: "persisted" });
    const response = await GET(new Request("http://main.local/api/internal/metrics", {
      headers: { "x-internal-token": env.INTERNAL_TOKEN },
    }));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain(
      'main_inbound_events_total{outcome="persisted"} 1',
    );
    resetMetricsForTests();
  });
});
