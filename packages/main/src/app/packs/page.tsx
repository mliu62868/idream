import type { Metadata } from "next";
import { PackCatalog } from "@/components/ourdream/PackCatalog";
export const metadata: Metadata = { title: "Packs | iDream", robots: { index: false, follow: false } };
export default async function PacksPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const { scope } = await searchParams;
  const selected = scope === "mine" || scope === "claimed" ? scope : "public";
  return <PackCatalog scope={selected} key={selected} />;
}
