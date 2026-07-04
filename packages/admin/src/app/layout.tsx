import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Admin | iDream",
  description: "Internal iDream control plane.",
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
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
