import type { Metadata } from "next";
import { CreatorProfileClient } from "@/components/ourdream/CreatorProfileClient";

type PageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const canonical = `/creators/${encodeURIComponent(id)}`;
  return {
    title: "Creator | ourdream.ai",
    alternates: {
      canonical,
    },
    openGraph: {
      type: "website",
      siteName: "ourdream.ai",
      title: "Creator | ourdream.ai",
      description: "View an Ourdream creator and their public characters.",
      url: canonical,
    },
    robots: { index: false, follow: false },
  };
}

export default async function CreatorPage({ params }: PageProps) {
  const { id } = await params;
  return <CreatorProfileClient id={id} key={id} />;
}
