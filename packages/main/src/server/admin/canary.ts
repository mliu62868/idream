import { z } from "zod";

export const ADMIN_READ_CANARY_SCENARIO_IDS = [
  "read.today",
  "read.list",
  "read.detail",
  "read.search",
] as const;

export const ADMIN_WRITE_CANARY_SCENARIO_IDS = [
  "write.command.accept",
  "write.command.replay",
  "write.command.collision",
  "write.command.readback",
  "write.state.readback",
] as const;

export const ADMIN_CANARY_SCENARIO_IDS = [
  ...ADMIN_READ_CANARY_SCENARIO_IDS,
  ...ADMIN_WRITE_CANARY_SCENARIO_IDS,
] as const;

export const adminCanaryScenarioIdSchema = z.enum(ADMIN_CANARY_SCENARIO_IDS);

export type AdminCanaryScenarioId = z.infer<typeof adminCanaryScenarioIdSchema>;
export type AdminReadCanaryScenarioId = (typeof ADMIN_READ_CANARY_SCENARIO_IDS)[number];
export type AdminWriteCanaryScenarioId = (typeof ADMIN_WRITE_CANARY_SCENARIO_IDS)[number];

export function requiredAdminCanaryScenarioIds(mode: "read" | "write") {
  return mode === "read"
    ? ADMIN_READ_CANARY_SCENARIO_IDS
    : ADMIN_WRITE_CANARY_SCENARIO_IDS;
}

export function adminCanaryScenarioPathIsRepresentative(
  scenarioId: AdminCanaryScenarioId,
  path: string,
) {
  let url: URL;
  try {
    url = new URL(path, "https://admin-canary.invalid");
  } catch {
    return false;
  }
  const pathname = url.pathname;
  if (scenarioId === "read.today") return pathname === "/api/v2/admin/today";
  if (scenarioId === "read.list") return /^\/api\/v2\/admin\/(cases|creative\/runs|customers|incidents|jobs)\/?$/.test(pathname);
  if (scenarioId === "read.detail") return /^\/api\/v2\/admin\/(cases|characters|creative\/runs|customers|incidents|jobs)\/[^/?]+\/?$/.test(pathname);
  if (scenarioId === "read.search") return pathname === "/api/v2/admin/search" && (url.searchParams.get("q") ?? "").trim().length >= 2;
  if (["write.command.accept", "write.command.replay", "write.command.collision"].includes(scenarioId)) {
    return /^\/api\/v2\/admin\/cases\/[^/?]+\/commands\/close$/.test(pathname);
  }
  if (scenarioId === "write.command.readback") return /^\/api\/v2\/admin\/commands\/[^/?]+$/.test(pathname);
  return /^\/api\/v2\/admin\/cases\/[^/?]+\/?$/.test(pathname);
}
