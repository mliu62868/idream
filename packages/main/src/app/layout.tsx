import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AgeGateBoundary } from "@/components/ourdream/AgeGateBoundary";
import { AnnouncementBanner } from "@/components/ourdream/AnnouncementBanner";
import "./globals.css";

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
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full">
        <AgeGateBoundary initialAccepted={ageGateAccepted}>
          <AnnouncementBanner />
          {children}
        </AgeGateBoundary>
      </body>
    </html>
  );
}
