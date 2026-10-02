import type { Metadata } from "next";
import { PackStudio } from "@/components/ourdream/PackStudio";
export const metadata: Metadata = { title: "Edit Pack | iDream", robots: { index: false, follow: false } };
export default async function EditPackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; return <PackStudio id={id} key={id} />;
}
