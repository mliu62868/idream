import type { AdminI18nContextValue, TranslationValues } from "@/components/admin/i18n-dictionary";

// INVARIANT: 日志保存消息意图，直到渲染才翻译；恢复循环与取数不依赖 locale。
export type CharacterCommandMessage = string | {
  readonly key: string;
  readonly values: TranslationValues;
};

export function characterCommandMessage(key: string, values: TranslationValues): CharacterCommandMessage {
  return { key, values };
}

export function renderCharacterCommandMessage(message: CharacterCommandMessage, t: AdminI18nContextValue["t"]): string {
  if (typeof message === "string") return t(message);
  return t(message.key, Object.fromEntries(Object.entries(message.values).map(([key, value]) =>
    [key, (key === "action" || key === "status") && typeof value === "string" ? t(value) : value],
  )));
}
