import type { Metadata } from "next";
import { ChatSessionClient } from "@/components/ourdream/ChatSessionClient";

export const metadata: Metadata = { title: "Private group chat | iDream", robots: { index: false, follow: false } };

export default async function GroupChatPage({ params }: { params: Promise<{ groupId: string }> }) {
  const { groupId } = await params;
  return <ChatSessionClient id={groupId} key={groupId} groupMode />;
}
