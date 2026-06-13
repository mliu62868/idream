import Image from "next/image";
import Link from "next/link";
import { ChevronDown, Menu, Search } from "lucide-react";
import { categoryFilters } from "@/lib/ourdream-data";
import { cn } from "@/lib/utils";

function Pill({
  children,
  className,
}: Readonly<{ children: React.ReactNode; className?: string }>) {
  return (
    <button
      className={cn(
        "inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-[rgb(53,53,54)] pl-4 pr-3 text-[12px] font-medium leading-4 text-white transition-colors hover:bg-[rgb(62,62,63)]",
        className,
      )}
    >
      {children}
      <ChevronDown className="h-3.5 w-3.5 text-[rgb(170,170,170)]" />
    </button>
  );
}

export function TopControls() {
  return (
    <>
      <header className="sticky top-0 z-40 h-14 w-full bg-[rgba(13,13,13,0.6)] backdrop-blur-xl">
        <div className="flex h-14 items-center justify-between gap-2 px-2 md:px-4">
          <button className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[rgb(170,170,170)] md:hidden">
            <Menu className="h-4 w-4" />
          </button>
          <div className="hidden min-w-0 flex-1 md:block" />
          <div className="ml-auto flex items-center gap-3">
            <Link
              className="hidden text-[12px] font-bold leading-4 text-white md:block"
              href="/login"
            >
              Login
            </Link>
            <Link
              className="rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] px-4 py-2 text-[12px] font-bold leading-4 text-white"
              href="/signup"
            >
              Join Free
            </Link>
          </div>
        </div>
      </header>

      <section className="w-full px-2 pt-0 md:px-[60px] md:pt-[14px]">
        <div className="mb-3 overflow-hidden md:hidden">
          <Image
            src="/images/ourdream/pride-banner-female.webp"
            alt="Pride Sale - Upgrade Now"
            width={800}
            height={160}
            className="h-[52px] w-full object-cover"
            priority
          />
        </div>

        <div className="flex items-center gap-3 overflow-x-auto pb-2 md:grid md:grid-cols-[1fr_320px_1fr] md:overflow-visible md:pb-0">
          <div className="flex justify-start">
            <Pill>Popular · Month</Pill>
          </div>

          <label className="hidden h-9 items-center gap-2 rounded-full bg-[rgb(53,53,54)] px-4 text-[12px] font-medium leading-4 text-[rgb(170,170,170)] md:flex">
            <Search className="h-4 w-4" />
            <span>Try &apos;Busty blonde&apos; or &apos;Petite asian&apos;</span>
          </label>

          <div className="flex justify-start gap-2 md:justify-end">
            <Pill>Female</Pill>
            <Pill>Any Style</Pill>
            <Pill>Any Age</Pill>
          </div>
        </div>

        <div className="mt-2 flex gap-1 overflow-x-auto pb-3 md:mt-4 md:pb-0">
          {categoryFilters.map((filter, index) => (
            <button
              key={filter}
              className={cn(
                "flex h-9 shrink-0 items-center rounded-full px-3 text-[12px] font-medium leading-4 transition-colors",
                index === 0
                  ? "bg-[rgb(46,46,46)] text-white"
                  : "text-[rgb(170,170,170)] hover:bg-[rgb(36,36,36)] hover:text-white",
              )}
            >
              {filter}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
