import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "iDream 管理后台",
  description: "iDream 内部控制面。",
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
