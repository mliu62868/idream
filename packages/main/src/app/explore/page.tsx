import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Explore AI Characters | iDream",
  description:
    "Explore iDream AI characters with search, filters, categories, and creator cards.",
  alternates: {
    canonical: "/",
  },
  robots: { index: false, follow: true },
};

export default function ExplorePage() {
  permanentRedirect("/");
}
