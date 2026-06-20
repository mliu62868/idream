export interface CharacterCardData {
  id: string;
  title: string;
  age: string;
  description: string;
  likes: string;
  chats: string;
  creator: string;
  image: string;
  vivid?: boolean;
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
