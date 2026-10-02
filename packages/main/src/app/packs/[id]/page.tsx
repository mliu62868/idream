import type { Metadata } from "next";
import { PackReader } from "@/components/ourdream/PackReader";
import { requirePublicPackForAnonymous } from "@/server/public-route-existence";
export const metadata: Metadata = { title: "Pack | iDream", robots: { index: false, follow: false } };
export default async function PackPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ release?: string }> }) {
  const { id } = await params; const { release } = await searchParams;
  await requirePublicPackForAnonymous(id, release);
  return <PackReader id={id} releaseId={release} key={`${id}:${release ?? "current"}`} />;
}
