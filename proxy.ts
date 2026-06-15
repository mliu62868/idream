import { NextResponse, type NextRequest } from "next/server";

const AGE_GATE_COOKIE = "AdultContentAcceptedOD";
const ANONYMOUS_COOKIE = "idream_anonymous_id";

const gatedPrefixes = ["/create", "/generate", "/generator", "/chat"];
const gatedExact = new Set(["/", "/custom", "/profile", "/feed", "/community"]);

function needsAgeGate(pathname: string) {
  if (pathname.startsWith("/api/v1")) return true;
  if (gatedExact.has(pathname)) return true;
  return gatedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function securityHeaders(response: NextResponse) {
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return response;
}

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const response = NextResponse.next();

  if (!request.cookies.get(ANONYMOUS_COOKIE)?.value) {
    response.cookies.set(ANONYMOUS_COOKIE, crypto.randomUUID(), {
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  const accepted = request.cookies.get(AGE_GATE_COOKIE)?.value === "true";
  if (needsAgeGate(pathname) && !accepted && !pathname.startsWith("/api/v1/age-gate")) {
    if (pathname.startsWith("/api/")) {
      return securityHeaders(
        NextResponse.json(
          {
            ok: false,
            error: {
              code: "forbidden",
              message: "Age gate acceptance required",
              details: { reason: "age_gate_required" },
            },
          },
          { status: 403 },
        ),
      );
    }
  }

  return securityHeaders(response);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico|images|seo).*)"],
};
