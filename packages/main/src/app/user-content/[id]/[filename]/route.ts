import { dispatchV1 } from "@/server/modules/ourdream/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type UserContentRouteContext = {
  params: Promise<{
    id: string;
    filename: string;
  }>;
};

export async function GET(request: Request, context: UserContentRouteContext) {
  const { id } = await context.params;
  return dispatchV1(request, ["media", decodeRouteId(id), "content"]);
}

function decodeRouteId(token: string) {
  return Buffer.from(token, "base64url").toString("utf8");
}
