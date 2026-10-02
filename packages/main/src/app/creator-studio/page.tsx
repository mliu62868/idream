import type { Metadata } from "next";
import { RouteShell } from "@/components/ourdream/OurdreamRoutePage";
import { CreatorStudioWorkspace } from "@/components/ourdream/CreatorStudioWorkspace";

export const metadata: Metadata = { title: "Creator Studio | iDream", robots: { index: false, follow: false } };
export default function Page() {
  return <RouteShell route={{ path: "/creator-studio", title: "Creator Studio", description: "Your saved work and current creator progress.", template: "profile" }}><CreatorStudioWorkspace /></RouteShell>;
}
