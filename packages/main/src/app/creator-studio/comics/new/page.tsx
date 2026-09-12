import type { Metadata } from "next";
import { ComicStudio } from "@/components/ourdream/ComicStudio";
export const metadata: Metadata = { title: "Create Comic | iDream", robots: { index: false, follow: false } };
export default function NewComicPage() { return <ComicStudio />; }
