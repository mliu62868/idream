import type { Metadata } from "next";
import { ComicReader } from "@/components/ourdream/ComicReader";
export const metadata: Metadata = { title: "Read Comic | iDream", robots: { index: false, follow: false } };
export default async function ComicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; return <ComicReader id={id} key={id} />;
}
