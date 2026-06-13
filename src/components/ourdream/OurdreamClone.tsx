import { AppSidebar } from "./AppSidebar";
import { CharacterGrid } from "./CharacterGrid";
import { MobileBottomNav } from "./MobileBottomNav";
import { PromoToast } from "./PromoToast";
import { HomeSeoSections } from "./HomeSeoSections";
import { SiteFooter } from "./SiteFooter";
import { TopControls } from "./TopControls";

export function OurdreamClone() {
  return (
    <main className="min-h-screen bg-[rgb(13,13,13)] text-white">
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <div className="min-w-0 flex-1 pb-20 md:pb-12">
          <TopControls />
          <div className="pt-2 md:pt-6">
            <CharacterGrid />
          </div>
          <HomeSeoSections />
        </div>
      </div>
      <SiteFooter />
      <PromoToast />
      <MobileBottomNav />
    </main>
  );
}
