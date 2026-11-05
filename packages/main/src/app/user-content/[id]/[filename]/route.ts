import { dispatchV1 } from "@/server/modules/ourdream/service";
import { MEDIA_THUMBNAIL_FILENAME } from "@/server/modules/ourdream/public-read-model";

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
  // Every other filename stays the original: stored URLs vary by extension.
  const action = filename === MEDIA_THUMBNAIL_FILENAME ? "thumbnail" : "content";
  return dispatchV1(request, ["media", decodeRouteId(id), action]);
}

function decodeRouteId(token: string) {
  return Buffer.from(token, "base64url").toString("utf8");
}
