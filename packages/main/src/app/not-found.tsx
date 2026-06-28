import Link from "next/link";
import { ArrowRight, Compass } from "lucide-react";
import { AppSidebar } from "@/components/ourdream/AppSidebar";
import { MobileBottomNav } from "@/components/ourdream/MobileBottomNav";
import { SiteFooter } from "@/components/ourdream/SiteFooter";

// SPEC: App-shell 404 so unknown routes keep the sidebar/footer/nav instead of
//       Next's bare default. activeHref="" leaves every nav item inactive.
export default function NotFound() {
  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar activeHref="" />
        <div className="min-w-0 flex-1 pb-20 md:pb-12">
          <section className="grid min-h-[60vh] place-items-center px-4 py-16 md:px-[60px]">
            <div className="mx-auto max-w-xl text-center">
              <p className="text-[12px] font-black uppercase tracking-wide text-[rgb(253,95,194)]">
                Error 404
              </p>
              <h1 className="mt-4 text-[40px] font-black uppercase leading-none text-white md:text-[64px]">
                Page not found
              </h1>
              <p className="mt-5 text-[15px] font-medium leading-7 text-[rgb(170,170,170)]">
                The page you&apos;re looking for doesn&apos;t exist or may have moved.
                Head back to Explore to keep discovering AI characters.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <Link
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold text-[rgb(13,13,13)] hover:bg-white/90"
                  href="/"
                >
                  <Compass className="h-4 w-4" />
                  Back to Explore
                </Link>
                <Link
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[rgb(46,46,46)] px-5 text-[14px] font-bold text-white hover:bg-[rgb(53,53,54)]"
                  href="/create"
                >
                  Create your AI
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>
      <SiteFooter />
      <MobileBottomNav activeHref="" />
    </main>
  );
}
