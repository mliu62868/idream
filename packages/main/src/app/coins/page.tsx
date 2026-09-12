import type { Metadata } from "next";
import { CoinStoreWorkspace } from "@/components/ourdream/CoinStoreWorkspace";
import { RouteShell } from "@/components/ourdream/OurdreamRoutePage";
import { getOurdreamRoute } from "@/lib/ourdream-data";
export const metadata: Metadata = { title: "Dreamcoin Store | iDream", robots: { index: false, follow: false } };
export default function CoinStorePage() {
  const route = getOurdreamRoute("/upgrade")!;
  return <RouteShell route={{ ...route, path: "/coins" }}><CoinStoreWorkspace /></RouteShell>;
}
