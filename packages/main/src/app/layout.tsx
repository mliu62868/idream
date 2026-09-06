import type { Metadata } from "next";
import { AgeGateBoundary } from "@/components/ourdream/AgeGateBoundary";
import { AnnouncementBanner } from "@/components/ourdream/AnnouncementBanner";
import { publicSiteOrigin } from "@/lib/public-site-origin";
import "./globals.css";

// SPEC: 根布局只放全站共用的默认值，不放任何「按路由才成立」的断言。
// INTENT: 这里原本下发 `alternates.canonical: "/"` 与 `robots: index,follow`。
//   真实页面各自覆盖掉了，但 `notFound()` 的路由覆盖不掉 —— 布局的 head 早在
//   notFound 解析出来之前就随流式输出冲走了，于是每条渲染不出内容的路由都在对
//   爬虫说「收录我，我的正主是首页」。canonical 交给各页自己声明（首页也一样），
//   robots 的 index,follow 本就是爬虫默认值，全站声明它只会制造这个 bug。
export const metadata: Metadata = {
  metadataBase: publicSiteOrigin(),
  title: "iDream | AI Characters, Chat & Image Generation",
  description:
    "iDream is an adult AI roleplay platform for discovering characters, creating companions, chatting privately, and generating media.",
  icons: {
    icon: "/seo/favicon.ico",
  },
  openGraph: {
    type: "website",
    siteName: "iDream",
    title: "iDream | AI Characters, Chat & Image Generation",
    description:
      "Discover AI characters, create companions, chat privately, and generate character-aware media.",
    url: "/",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full">
        <AgeGateBoundary>
          <AnnouncementBanner />
          {children}
        </AgeGateBoundary>
      </body>
    </html>
  );
}
