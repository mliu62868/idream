"use client";
import type { ReactNode } from "react";
import { adminDateLocale, type AdminLocale, useAdminI18n } from "@/components/admin/i18n";

// SPEC: 列表单元格的取值与格式化只有这一份。
// INTENT: text / display / date 三件套在 features 下被逐字复制了 12 份，日期还长出四种口径：
//         裸 toLocaleString()（10 处）、裸 toLocaleTimeString()（8 处）、显式 locale、
//         adminDateLocale。前两种跟浏览器 locale 走 —— 中文界面里显示的是英文日期。
// INVARIANT: 这里的每个时间函数都过 adminDateLocale(locale)。不要再出现裸 toLocale*。

/** 只有字符串才是字符串；其余一律空串，交给上层决定怎么显示缺失。 */
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// SPEC: 未知形状的值怎么显示 —— 空是破折号、标量原样、其余折成可看全的 JSON。
// INTENT: 12 份副本里有 4 种做法，最差的一种把对象直接显示成 "—"，等于把数据藏了。
//         这里取并集里信息量最大的那一种：对象也要能看见，只是折起来。
export function displayValue(value: unknown, labels: { yes: string; no: string }): ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? labels.yes : labels.no;
  if (typeof value === "string" || typeof value === "number") return String(value);
  return <code className="block max-w-72 truncate text-xs" title={JSON.stringify(value)}>{JSON.stringify(value)}</code>;
}

function parse(value: unknown) {
  const raw = typeof value === "number" ? value : text(value);
  if (raw === "") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 只到日 —— 列表里的"创建于哪天"。 */
export function formatDate(value: unknown, locale: AdminLocale): string {
  return parse(value)?.toLocaleDateString(adminDateLocale(locale), { dateStyle: "medium" }) ?? "—";
}

/** 日 + 时分 —— 运营需要对齐事件先后顺序时的默认口径。 */
export function formatDateTime(value: unknown, locale: AdminLocale): string {
  return parse(value)?.toLocaleString(adminDateLocale(locale), { dateStyle: "medium", timeStyle: "short" }) ?? "—";
}

/** 只到秒 —— "刚刚刷新于 …" 这种同一天内的时刻。 */
export function formatTime(value: unknown, locale: AdminLocale): string {
  return parse(value)?.toLocaleTimeString(adminDateLocale(locale), { timeStyle: "medium" }) ?? "—";
}

// SPEC: 相对时间取最大的整数单位，只给一位（"3 天"而不是"3 天 4 小时"）。
// INTENT: 队列里唯一在变的量是积压了多久；绝对时间戳要读者自己做减法。
export function formatRelativeTime(value: unknown, referenceTime: unknown, locale: AdminLocale): string {
  const date = parse(value);
  const reference = parse(referenceTime);
  if (!date || !reference) return "—";
  const deltaMs = date.getTime() - reference.getTime();
  const format = new Intl.RelativeTimeFormat(adminDateLocale(locale) ?? "en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    const amount = Math.trunc(deltaMs / ms);
    if (amount !== 0) return format.format(amount, unit);
  }
  return format.format(0, "minute");
}

export function formatMoney(amountCents: number, currency: string, locale: AdminLocale): string {
  try {
    return new Intl.NumberFormat(adminDateLocale(locale), { style: "currency", currency: currency || "USD" })
      .format(amountCents / 100);
  } catch {
    // 后端偶尔给出非 ISO 的币种码；宁可显示原始数值，也不要整行崩掉。
    return `${amountCents} ${currency || "cents"}`;
  }
}

export function formatCount(value: number, locale: AdminLocale): string {
  return value.toLocaleString(adminDateLocale(locale));
}

/** 组件里用这个：locale 已绑好，调用点不必再记得传。 */
export function useAdminFormat() {
  const { locale, t } = useAdminI18n();
  return {
    text,
    display: (value: unknown) => displayValue(value, { yes: t("yes"), no: t("no") }),
    date: (value: unknown) => formatDate(value, locale),
    dateTime: (value: unknown) => formatDateTime(value, locale),
    time: (value: unknown) => formatTime(value, locale),
    relativeTime: (value: unknown, referenceTime: unknown) => formatRelativeTime(value, referenceTime, locale),
    money: (amountCents: number, currency: string) => formatMoney(amountCents, currency, locale),
    count: (value: number) => formatCount(value, locale),
  };
}
