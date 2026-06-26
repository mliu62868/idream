import type { Metadata } from "next";
import { OurdreamClone } from "@/components/ourdream/OurdreamClone";

export const metadata: Metadata = {
  title: "Explore AI Characters | ourdream.ai",
  description:
    "Explore Ourdream AI characters with search, filters, categories, and creator cards.",
  alternates: {
    canonical: "/explore",
  },
};

export default function ExplorePage() {
  return <OurdreamClone />;
}
