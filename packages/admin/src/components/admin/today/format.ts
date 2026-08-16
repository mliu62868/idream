import { translateAdmin, type AdminLocale } from "@/components/admin/i18n";

// SPEC: 工作项已经开了多久 —— 取最大的整数单位，只给一位。
// INTENT: 队列里唯一真正在变的量是"积压了多久"。绝对时间戳要读者自己做减法；
//         "3 周"一眼就知道该不该急。
// MIGRATION: features/operations/WorkspaceUi.tsx 里还有一份同名实现（多带 style:"narrow"，
//         输出格式不一致）。统一版正在 ui/format.ts 落地 —— 到时把这里换成 import，
//         不要再造第三份。
export function formatElapsed(value: string, locale: AdminLocale) {
  const elapsedMs = Math.max(0, Date.now() - new Date(value).getTime());
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const format = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto", style: "narrow" });
  for (const [unit, ms] of units) {
    const amount = Math.floor(elapsedMs / ms);
    if (amount >= 1) return format.format(-amount, unit);
  }
  return format.format(0, "minute");
}

export function formatDateTime(value: string, locale: AdminLocale) {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

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
