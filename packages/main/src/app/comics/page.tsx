import type { Metadata } from "next";
import { ComicCatalog } from "@/components/ourdream/ComicCatalog";
export const metadata: Metadata = { title: "Comics | iDream", robots: { index: false, follow: false } };
export default function ComicsPage() { return <ComicCatalog />; }
