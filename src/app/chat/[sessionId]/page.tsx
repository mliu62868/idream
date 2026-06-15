import { ChatSessionClient } from "@/components/ourdream/ChatSessionClient";

type PageProps = {
  params: Promise<{ sessionId: string }>;
};

export default async function ChatPage({ params }: PageProps) {
  const { sessionId } = await params;
  return <ChatSessionClient id={sessionId} />;
}
