import { redirect } from "next/navigation";

// 保留旧书签的明确去向，日常角色流程不再包含人工审核队列。
export default function CharacterReviewPage() {
  redirect("/admin/characters");
}
