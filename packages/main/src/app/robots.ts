import type { MetadataRoute } from "next";
import { publicSiteOrigin } from "@/lib/public-site-origin";

export default function robots(): MetadataRoute.Robots {
  const origin = publicSiteOrigin();
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin/",
        "/api/",
        "/chat/",
        "/internal-preview/",
        "/user-content/",
      ],
    },
    sitemap: new URL("/sitemap.xml", origin).href,
    host: origin.href,
  };
}
