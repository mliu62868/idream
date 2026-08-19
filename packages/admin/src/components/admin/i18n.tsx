"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AdminLocale } from "./shell-preferences";

// AdminLocale 的取值域住在 shell-preferences.ts（服务端也要按它校验 cookie）；这里转出去，
// 既有引用方（today/*、jobs/*）不必改 import 路径。
export type { AdminLocale };

// 纯查表层住在 i18n-dictionary.ts（不带 "use client"，服务端可调）；这里原样转出去，
// 既有 import 路径不变。
export type { AdminI18nContextValue, TranslationValues } from "./i18n-dictionary";
export {
  adminDateLocale,
  adminValueLabel,
  hasAdminZh,
  translateAdmin,
} from "./i18n-dictionary";
import { translateAdmin, adminValueLabel } from "./i18n-dictionary";
import type { AdminI18nContextValue } from "./i18n-dictionary";

const defaultContext: AdminI18nContextValue = {
  locale: "en",
  t: (key, values) => translateAdmin("en", key, values),
  value: (key) => adminValueLabel("en", key),
};

const AdminI18nContext = createContext<AdminI18nContextValue>(defaultContext);

export function AdminI18nProvider({
  children,
  locale,
}: {
  children: ReactNode;
  locale: AdminLocale;
}) {
  const value: AdminI18nContextValue = {
    locale,
    t: (key, values) => translateAdmin(locale, key, values),
    value: (key) => adminValueLabel(locale, key),
  };

  return <AdminI18nContext value={value}>{children}</AdminI18nContext>;
}

export function useAdminI18n() {
  return useContext(AdminI18nContext);
}

export function AdminText({ text }: { text: string }) {
  const { t } = useAdminI18n();
  return t(text);
}
