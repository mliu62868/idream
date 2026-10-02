import type { Metadata } from "next";
import { PackStudio } from "@/components/ourdream/PackStudio";
export const metadata: Metadata = { title: "Create Pack | iDream", robots: { index: false, follow: false } };
export default function NewPackPage() { return <PackStudio />; }
