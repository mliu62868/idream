import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { AgeGate } from "@/components/ourdream/AgeGate";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-safety",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ourdream.ai | Unlimited AI Roleplay Platform",
  description:
    "Ourdream is an AI roleplay platform clone built from the live visual reference.",
  icons: {
    icon: "/seo/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} dark h-full antialiased`}
    >
      <body className="min-h-full">
        {children}
        <AgeGate />
      </body>
    </html>
  );
}
