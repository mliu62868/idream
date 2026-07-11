import { createExperimentDefinition, listExperimentDefinitions } from "@/server/modules/admin-v2/experiments/management";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) { return adminV2Route(() => listExperimentDefinitions(request)); }
export function POST(request: Request) { return adminV2Route(() => createExperimentDefinition(request)); }
