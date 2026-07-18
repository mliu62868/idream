import type { Metadata } from "next";
import { ChatSessionClient } from "@/components/ourdream/ChatSessionClient";

type PageProps = {
  params: Promise<{ sessionId: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { sessionId } = await params;
  const canonical = `/chat/${encodeURIComponent(sessionId)}`;
  return {
    title: "Private chat | ourdream.ai",
    alternates: {
      canonical,
    },
    openGraph: {
      type: "website",
      siteName: "ourdream.ai",
      title: "Private chat | ourdream.ai",
      description: "Continue a private Ourdream chat.",
      url: canonical,
    },
    robots: { index: false, follow: false },
  };
}

export default async function ChatPage({ params }: PageProps) {
  const { sessionId } = await params;
  return <ChatSessionClient id={sessionId} key={sessionId} />;
}
