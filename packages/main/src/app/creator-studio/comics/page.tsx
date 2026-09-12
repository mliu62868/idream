import type { Metadata } from "next";
import { ComicCatalog } from "@/components/ourdream/ComicCatalog";
export const metadata: Metadata = { title: "Your Comics | iDream", robots: { index: false, follow: false } };
export default function ComicStudioPage() { return <ComicCatalog mine />; }
