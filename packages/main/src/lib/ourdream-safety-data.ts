import { localSafetyDocuments } from "./ourdream-local-safety-docs";

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

export const safetyDocuments: SafetyDocument[] = localSafetyDocuments.map(
  (document) => ({ ...document }),
);

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

// SPEC: 一篇安全文档的版本号由它的正文决定。
// INTENT: policy_versions 是「某个时点发布的政策原文」这份记录，此前 seed 把版本号
//   写死成 seed-2026-06-13 且 upsert 的 update 会改写 body——改一次文案就把历史那行
//   悄悄重写了，一份会被篡改的存档比没有存档更危险。改成按内容派生后，改文案只会
//   追加新行，旧版本原样留着。不用 node:crypto：这个模块被安全中心页面（客户端）引用，
//   而这里要的是内容同一性标签，不是安全摘要。
export function safetyDocumentVersion(
  document: Pick<SafetyDocument, "title" | "markdown">,
) {
  const payload = `${document.title}\n${document.markdown}`;
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return `content-${hash.toString(16).padStart(8, "0")}`;
}

export const safetyRoutePaths = [
  "/safety",
  ...safetyDocuments.map((document) => `/safety${document.path}`),
];

const safetyRoutePathSet = new Set<string>(safetyRoutePaths);

export function safetyRoutePathToDocPath(routePath: string) {
  if (routePath === "/safety") return "/introduction";
  if (routePath.startsWith("/safety/")) {
    return routePath.slice("/safety".length);
  }
  return routePath;
}

// SPEC: 把安全中心文档里的链接解析成可用的站内 href。
// INTENT: 文档正文同时使用 section 内链接(/policies/x)和站内绝对链接(/helpdesk)；
//   以已发布的 safety 路由集合为判据，只有真属于安全中心的路径才加 /safety 前缀，
//   否则按站内绝对路径原样返回——统一加前缀会把 /helpdesk 变成 /safety/helpdesk 死链。
export function toSafetyHref(path: string) {
  if (
    path.startsWith("http") ||
    path.startsWith("mailto:") ||
    path.startsWith("#")
  ) {
    return path;
  }

  const normalized = path.startsWith("/") ? path : `/${path}`;
  const scoped = `/safety${normalized}`;
  return safetyRoutePathSet.has(scoped) ? scoped : normalized;
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
