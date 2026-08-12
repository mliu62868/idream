import type { Metadata } from "next";
import { AgeVerificationReturn } from "@/components/ourdream/AgeVerificationReturn";
import { RouteShell } from "@/components/ourdream/OurdreamRoutePage";
import { safeAgeVerificationReturnTarget } from "@/lib/age-verification-return";
import type { OurdreamRoute } from "@/types/ourdream";

export const metadata: Metadata = {
  title: "Age verification | ourdream.ai",
  description: "Confirm the result of your Ourdream age verification.",
  alternates: { canonical: "/age-verification/return" },
  robots: { index: false, follow: false },
};

const route: OurdreamRoute = {
  path: "/age-verification/return",
  title: "Age verification",
  description: "Confirm the provider result and safely continue.",
  template: "profile",
};

type PageProps = {
  searchParams: Promise<{ next?: string | string[] }>;
};

export default async function Page({ searchParams }: PageProps) {
  const { next } = await searchParams;
  const nextPath = safeAgeVerificationReturnTarget(
    typeof next === "string" ? next : null,
  );

  return (
    <RouteShell route={route}>
      <AgeVerificationReturn nextPath={nextPath} />
    </RouteShell>
  );
}
