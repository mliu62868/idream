import { timingSafeEqual } from "node:crypto";
import { renderPrometheusMetrics } from "@idream/shared";
import { env } from "@/server/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const supplied = request.headers.get("x-internal-token");
  if (!supplied || !sameToken(supplied, env.INTERNAL_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return new Response(renderPrometheusMetrics(), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
}

function sameToken(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
