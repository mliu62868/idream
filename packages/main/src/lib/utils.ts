import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// SPEC: 站内「Share」按钮的唯一实现 —— 有系统分享面板（移动端）先用它，没有或失败就复制链接。
// 返回给调用方状态条的一句话；空串表示系统面板已接手（或用户取消），无需再提示。
// INTENT: 复制也失败时把链接原文给出来，用户至少能手动选中复制，而不是只看到一个「失败」。
export async function shareOrCopy(url: string, title: string): Promise<string> {
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title, url })
      return ""
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return ""
    }
  }
  try {
    await navigator.clipboard.writeText(url)
    return "Share link copied."
  } catch {
    return `Share link: ${url}`
  }
}
