import Link from "next/link";
import { AtSign, Disc3, MessageCircle } from "lucide-react";
import { footerGroups } from "@/lib/ourdream-data";

function FooterLink({
  href,
  label,
}: Readonly<{ href: string; label: string }>) {
  const external = href.startsWith("http");
  if (external) {
    return (
      <a
        className="text-[14px] font-medium leading-5 text-white transition-colors hover:text-[rgb(170,170,170)]"
        href={href}
        rel="noopener"
        target="_blank"
      >
        {label}
      </a>
    );
  }

  return (
    <Link
      className="text-[14px] font-medium leading-5 text-white transition-colors hover:text-[rgb(170,170,170)]"
      href={href}
    >
      {label}
    </Link>
  );
}

export function SiteFooter() {
  return (
    <footer className="w-full bg-[rgb(13,13,13)] text-white">
      <div className="mx-auto grid w-full max-w-[1120px] gap-10 px-4 py-12 md:grid-cols-[1fr_1fr_1fr_1.2fr] md:px-5 md:py-16">
        {footerGroups.map((group) => (
          <div key={group.title}>
            <h2 className="mb-4 text-[13px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
              {group.title}
            </h2>
            <nav className="flex flex-col gap-3">
              {group.links.map((link) => (
                <FooterLink
                  key={`${group.title}-${link.href}`}
                  href={link.href}
                  label={link.label}
                />
              ))}
            </nav>
          </div>
        ))}

        <div className="md:text-right">
          <div className="text-[12px] font-medium uppercase leading-5 text-[rgb(114,113,112)]">
            <p>2026 OURDREAM.AI</p>
            <p>USA: Dream Studio USA, Inc.</p>
            <p>Cyprus: TEKTOPIA LTD (HE 473775)</p>
          </div>
          <div className="mt-6 flex gap-4 md:justify-end">
            <a
              aria-label="Discord"
              className="text-white transition-colors hover:text-[rgb(170,170,170)]"
              href="https://discord.gg/P47YU7je5D"
              rel="noopener"
              target="_blank"
            >
              <MessageCircle className="h-5 w-5" />
            </a>
            <a
              aria-label="Reddit"
              className="text-white transition-colors hover:text-[rgb(170,170,170)]"
              href="https://reddit.com/r/ourdream_ai"
              rel="noopener"
              target="_blank"
            >
              <Disc3 className="h-5 w-5" />
            </a>
            <a
              aria-label="Twitter / X"
              className="text-white transition-colors hover:text-[rgb(170,170,170)]"
              href="https://x.com/ourdreamai"
              rel="noopener"
              target="_blank"
            >
              <AtSign className="h-5 w-5" />
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
