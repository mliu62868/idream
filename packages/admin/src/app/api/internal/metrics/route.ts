import { timingSafeEqual } from "node:crypto";
import { renderPrometheusMetrics } from "@idream/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const expected = process.env.INTERNAL_TOKEN;
  const supplied = request.headers.get("x-internal-token");
  if (!expected) return new Response("Metrics exporter is not configured", { status: 503 });
  if (!supplied || !sameToken(supplied, expected)) return new Response("Unauthorized", { status: 401 });
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
