import type { Metadata } from "next";
import { ComicStudio } from "@/components/ourdream/ComicStudio";
export const metadata: Metadata = { title: "Edit Comic | iDream", robots: { index: false, follow: false } };
export default async function EditComicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; return <ComicStudio id={id} key={id} />;
}
