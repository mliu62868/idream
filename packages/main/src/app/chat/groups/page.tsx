import type { Metadata } from "next";
import { GroupChatManager } from "@/components/ourdream/GroupChatManager";

export const metadata: Metadata = { title: "Your group chats | iDream", robots: { index: false, follow: false } };

export default function GroupChatsPage() {
  return <GroupChatManager />;
}
