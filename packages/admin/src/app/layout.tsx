import type { Metadata } from "next";
import { cookies } from "next/headers";
import { readAdminShellPreferences } from "@/components/admin/shell-preferences";
import "./globals.css";

export const metadata: Metadata = {
  // SPEC: 兜底标题只留品牌名，不带任何一种语言的词。
  // INTENT: 这里原是硬编码中文，于是没有自己 metadata 的页面（404、权威不可用）在英文
  //         locale 下会漏出中文。品牌名两种语言下都成立，比翻译它更省事也更对。
  title: "iDream Admin",
  description: "iDream 内部控制面。",
  robots: {
    index: false,
    follow: false,
  },
};

// SPEC: 首帧的 <html lang> 就是运营选定的语言。
// INTENT: 这里过去恒定写死 "en"，由 AdminConsoleClient 挂载后再改 documentElement.lang——
//         服务端发出的 HTML 因此始终自称英文，屏幕阅读器和 CJK 字体选择都按错的语言走。
//         语言偏好现在是 cookie（见 shell-preferences.ts），请求时就知道，直接渲染对。
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const { locale } = readAdminShellPreferences((name) => cookieStore.get(name)?.value);

  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
