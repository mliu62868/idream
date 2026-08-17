import { translateAdmin, type AdminLocale } from "@/components/admin/i18n";

// SPEC: 「推迟到」的时刻 —— 短日期 + 时分，Today 独有。
// INTENT: 故意不换 ui/format 的 formatTime（那份只给时分）：推迟档位里有"下周一"，
//         去掉日期后"09:00"读不出是哪天。elapsed 与 dateTime 两条已经换成共享实现了。
export function formatTime(value: string, locale: AdminLocale) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

export function todayOperationalText(text: string, locale: AdminLocale) {
  if (locale === "en") return text;

  const entityState = /^([a-z_]+) (.+) is ([a-z_]+)$/i.exec(text);
  if (entityState) {
    const [, entityType, entityId, state] = entityState;
    const [targetType, ...targetId] = entityId.split(":");
    const target = targetId.length
      ? `${translateAdmin(locale, targetType)}:${targetId.join(":")}`
      : entityId;
    return `${translateAdmin(locale, entityType.replaceAll("_", " "))} ${target} · ${translateAdmin(locale, state)}`;
  }

  const incidentState = /^Incident is ([a-z_]+)$/i.exec(text);
  if (incidentState) {
    return `${translateAdmin(locale, "Incident")} · ${translateAdmin(locale, incidentState[1])}`;
  }

  if (text.includes(" · ")) {
    return text.split(" · ").map((segment) => todayOperationalSegment(segment, locale)).join(" · ");
  }
  return translateAdmin(locale, text);
}

function todayOperationalSegment(segment: string, locale: AdminLocale) {
  const readiness = /^readiness ([a-z_]+)$/i.exec(segment);
  if (readiness) {
    return `${translateAdmin(locale, "Readiness")}：${translateAdmin(locale, readiness[1])}`;
  }
  return translateAdmin(locale, segment);
}
