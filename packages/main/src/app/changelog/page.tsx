import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { CmsRenderer } from "@/components/ourdream/CmsRenderer";
import { RouteShell } from "@/components/ourdream/OurdreamRoutePage";
import { authHrefForTarget } from "@/components/ourdream/authRedirect";
import { getAuthCtx } from "@/server/lib/auth";
import { entitlementMap } from "@/server/modules/ourdream/subscription-lifecycle";
import { loadPublishedRoutePage } from "@/server/cms/published-route";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Changelog | iDream",
  description: "Product updates for Premium and Deluxe members.",
  robots: { index: false, follow: false },
};
const route = { path: "/changelog", title: "Changelog", description: "Product updates for Premium and Deluxe members.", template: "article" as const };

export default async function ChangelogPage() {
  // INVARIANT: Authenticate this request before reading the shared CMS cache.
  // The URL supplies the customer pathname to auth; this never sends a request.
  const ctx = await getAuthCtx(new Request("http://idream.internal/changelog", { headers: await headers() }));
  const member = ctx.userId && (await entitlementMap(ctx.userId)).premium_controls === true;
  if (member) {
    const resolution = await loadPublishedRoutePage(route.path);
    if (resolution.state === "published") return <CmsRenderer page={resolution.page} label="Changelog" />;
    if (resolution.state !== "absent") throw new Error("Changelog publication is temporarily unavailable");
    return <RouteShell route={route}><section className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-4xl font-black">Changelog</h1><p className="mt-6 text-white/70">No product updates have been published yet.</p><Link className="mt-6 inline-block underline" href="/helpdesk">Back to Help Desk</Link></section></RouteShell>;
  }
  return <RouteShell route={route}><section className="mx-auto max-w-3xl px-4 py-12"><h1 className="text-4xl font-black">Changelog</h1><p className="mt-6 text-white/70">Read product updates with Premium or Deluxe. Help Desk support and roadmap voting are available to everyone.</p><Link className="mt-6 inline-block rounded-full bg-white px-5 py-3 font-bold text-black" href={ctx.userId ? "/upgrade" : authHrefForTarget("/login", route.path)} prefetch={false}>{ctx.userId ? "View plans" : "Sign in to check access"}</Link><Link className="ml-5 inline-block underline" href="/helpdesk">Back to Help Desk</Link></section></RouteShell>;
}
