import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { AgeGateBoundary } from "@/components/ourdream/AgeGateBoundary";
import { AnnouncementBanner } from "@/components/ourdream/AnnouncementBanner";
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
    "Ourdream is an adult AI roleplay platform for discovering characters, creating companions, chatting privately, and generating media.",
  icons: {
    icon: "/seo/favicon.ico",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const ageGateAccepted = cookieStore.get("AdultContentAcceptedOD")?.value === "true";

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} dark h-full antialiased`}
    >
      <body className="min-h-full">
        <AgeGateBoundary initialAccepted={ageGateAccepted}>
          <AnnouncementBanner />
          {children}
        </AgeGateBoundary>
      </body>
    </html>
  );
}
