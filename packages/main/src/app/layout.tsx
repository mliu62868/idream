import type { Metadata } from "next";
import { cookies } from "next/headers";
import { AgeGateBoundary } from "@/components/ourdream/AgeGateBoundary";
import { AnnouncementBanner } from "@/components/ourdream/AnnouncementBanner";
import { AGE_GATE_COOKIE_NAME } from "@/lib/age-gate";
import { publicSiteOrigin } from "@/lib/public-site-origin";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: publicSiteOrigin(),
  title: "ourdream.ai | AI Characters, Chat & Image Generation",
  description:
    "Ourdream is an adult AI roleplay platform for discovering characters, creating companions, chatting privately, and generating media.",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: "/seo/favicon.ico",
  },
  openGraph: {
    type: "website",
    siteName: "ourdream.ai",
    title: "ourdream.ai | AI Characters, Chat & Image Generation",
    description:
      "Discover AI characters, create companions, chat privately, and generate character-aware media.",
    url: "/",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const ageGateAccepted =
    cookieStore.get(AGE_GATE_COOKIE_NAME)?.value === "true";

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
