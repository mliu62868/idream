import Link from "next/link";
import { AtSign, Disc3, MessageCircle } from "lucide-react";
import { footerGroups } from "@/lib/ourdream-data";
import { isPublicRouteDiscoverable } from "@/lib/public-route-authority";
import { publicSiteIdentity } from "@/lib/public-site-identity";

function FooterLink({
  href,
  label,
}: Readonly<{ href: string; label: string }>) {
  const external = href.startsWith("http");
  if (external) {
    return (
      <a
        className="text-[14px] font-medium leading-5 text-white transition-colors hover:text-[rgb(170,170,170)]"
        data-link-kind="external"
        href={href}
        rel="noopener noreferrer"
        target="_blank"
      >
        {label}
      </a>
    );
  }

  return (
    <Link
      className="text-[14px] font-medium leading-5 text-white transition-colors hover:text-[rgb(170,170,170)]"
      data-link-kind="internal"
      href={href}
    >
      {label}
    </Link>
  );
}

export function SiteFooter() {
  const identity = publicSiteIdentity();
  const currentYear = new Date().getUTCFullYear();
  const helpLinks = [
    ...(identity.helpCenterUrl
      ? [{ label: "Help Centre", href: identity.helpCenterUrl }]
      : []),
    ...(identity.affiliateUrl
      ? [{ label: "Affiliates", href: identity.affiliateUrl }]
      : []),
  ];
  const groups = footerGroups.map((group) => ({
    ...group,
    links: [
      ...group.links.filter(
        (link) =>
          link.href.startsWith("http") ||
          isPublicRouteDiscoverable(link.href),
      ),
      ...(group.title === "Help" ? helpLinks : []),
    ],
  }));
  const socialLinks = [
    identity.discordUrl
      ? { label: "Discord", href: identity.discordUrl, Icon: MessageCircle }
      : null,
    identity.redditUrl
      ? { label: "Reddit", href: identity.redditUrl, Icon: Disc3 }
      : null,
    identity.xUrl
      ? { label: "Twitter / X", href: identity.xUrl, Icon: AtSign }
      : null,
  ].filter(
    (
      item,
    ): item is {
      Icon: typeof MessageCircle;
      href: string;
      label: string;
    } => item !== null,
  );

  return (
    <footer className="w-full bg-[rgb(13,13,13)] text-white">
      <div className="mx-auto grid w-full max-w-[1120px] gap-10 px-4 py-12 md:grid-cols-[1fr_1fr_1fr_1.2fr] md:px-5 md:py-16">
        {groups.map((group) => (
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
            <p>{currentYear} OURDREAM.AI</p>
            {identity.legalName ? <p>{identity.legalName}</p> : null}
            {identity.supportEmail ? (
              <a
                className="normal-case transition-colors hover:text-white"
                href={`mailto:${identity.supportEmail}`}
              >
                {identity.supportEmail}
              </a>
            ) : null}
          </div>
          {socialLinks.length > 0 ? (
            <div className="mt-6 flex gap-4 md:justify-end">
              {socialLinks.map(({ Icon, href, label }) => (
                <a
                  aria-label={label}
                  className="text-white transition-colors hover:text-[rgb(170,170,170)]"
                  data-link-kind="external"
                  href={href}
                  key={label}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <Icon className="h-5 w-5" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
