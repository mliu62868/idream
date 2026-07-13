import { getTodayAllWork } from "@/server/modules/admin-v2/today/query";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return getTodayAllWork(request);
}
