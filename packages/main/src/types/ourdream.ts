export interface CharacterCardData {
  id: string;
  title: string;
  age: string;
  description: string;
  likes: string;
  chats: string;
  likesCount?: number;
  chatsCount?: number;
  source?: "official" | "user";
  creator: string;
  creatorId?: string | null;
  creatorName?: string | null;
  canEditIdentity?: boolean;
  image: string;
  imageAssetId?: string | null;
  heroImage?: string;
  heroThumbnailUrl?: string;
  heroImageAssetId?: string | null;
  currentReleaseId?: string | null;
  hasImage?: boolean;
  vivid?: boolean;
  visualProfile?: {
    id: string;
    version: number;
    status: string;
    style: string;
    anchorAssetIds?: unknown;
    referenceAssetIds?: unknown;
    defaultSeed?: string | null;
  } | null;
}

export interface NavItem {
  label: string;
  href: string;
  active?: boolean;
}

export type OurdreamRouteTemplate =
  | "article"
  | "comparison"
  | "create"
  | "generator"
  | "library"
  | "marketing"
  | "profile"
  | "safety"
  | "terms"
  | "upgrade";

export interface OurdreamRoute {
  path: string;
  title: string;
  description: string;
  template: OurdreamRouteTemplate;
  eyebrow?: string;
}

export interface FooterGroup {
  title: string;
  links: NavItem[];
}
