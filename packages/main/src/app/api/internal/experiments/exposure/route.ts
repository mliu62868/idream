import { recordExperimentExposureRequest } from "@/server/modules/admin-v2/experiments/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request) {
  return recordExperimentExposureRequest(request);
}
