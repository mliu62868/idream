import safetyDocsJson from "./ourdream-safety-docs.json";

export interface SafetyDocument {
  path: string;
  title: string;
  description: string;
  markdown: string;
}

export interface SafetyNavItem {
  title: string;
  path: string;
}

export interface SafetyNavGroup {
  title: string;
  items: SafetyNavItem[];
}

export const safetyRootHref = "/safety/introduction";

export const safetyDocuments = safetyDocsJson as SafetyDocument[];

export const safetyNavGroups: SafetyNavGroup[] = [
  {
    title: "Overview",
    items: [
      { title: "Our approach to safety", path: "/introduction" },
      { title: "Principles", path: "/principles" },
      { title: "What we won't do", path: "/policies/what-we-wont-do" },
    ],
  },
  {
    title: "Policies",
    items: [
      { title: "Acceptable use", path: "/policies/acceptable-use" },
      { title: "Prohibited content", path: "/policies/prohibited-content" },
      { title: "Age verification", path: "/policies/age-verification" },
      { title: "Intellectual property", path: "/policies/intellectual-property" },
    ],
  },
  {
    title: "Moderation",
    items: [
      { title: "How moderation works", path: "/moderation/how-it-works" },
      {
        title: "Why was my character rejected?",
        path: "/moderation/why-rejected",
      },
      { title: "Appeals", path: "/moderation/appeals" },
    ],
  },
  {
    title: "Reporting",
    items: [{ title: "Report a problem", path: "/reporting/how-to-report" }],
  },
  {
    title: "Your account",
    items: [
      { title: "Your safety tools", path: "/your-account/safety-tools" },
      {
        title: "Wellbeing resources",
        path: "/your-account/wellbeing-resources",
      },
      { title: "Privacy at a glance", path: "/your-account/privacy-summary" },
    ],
  },
  {
    title: "Contact",
    items: [{ title: "Contact", path: "/contact" }],
  },
];

export const safetyRoutePaths = [
  "/safety",
  ...safetyDocuments.map((document) => `/safety${document.path}`),
];

export function safetyRoutePathToDocPath(routePath: string) {
  if (routePath === "/safety") return "/introduction";
  if (routePath.startsWith("/safety/")) {
    return routePath.slice("/safety".length);
  }
  return routePath;
}

export function toSafetyHref(path: string) {
  if (
    path.startsWith("http") ||
    path.startsWith("mailto:") ||
    path.startsWith("#")
  ) {
    return path;
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `/safety${normalized}`;
}

export function getSafetyDocumentForRoute(routePath: string) {
  const documentPath = safetyRoutePathToDocPath(routePath);
  return (
    safetyDocuments.find((document) => document.path === documentPath) ??
    safetyDocuments.find((document) => document.path === "/introduction") ??
    safetyDocuments[0]
  );
}

export function getNextSafetyDocument(documentPath: string) {
  const flatItems = safetyNavGroups.flatMap((group) => group.items);
  const index = flatItems.findIndex((item) => item.path === documentPath);
  const next = index >= 0 ? flatItems[index + 1] : undefined;

  if (!next) return undefined;

  return safetyDocuments.find((document) => document.path === next.path);
}
