import { proxyToMain } from "../../../../server/main-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type UserContentRouteContext = {
  params: Promise<{
    id: string;
    filename: string;
  }>;
};

export async function GET(request: Request, context: UserContentRouteContext) {
  const { id, filename } = await context.params;
  return proxyToMain(
    request,
    `/user-content/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`,
  );
}
