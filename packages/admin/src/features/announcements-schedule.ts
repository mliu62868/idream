// SPEC: 公告时间窗的两个纯判据 —— datetime-local 的值怎么变成契约要的 ISO 串，
//       以及什么样的窗口算合法。
// INTENT: 这两件事此前不存在，因为后台根本没有排期入口；补入口时它们必须是纯函数，
//         否则只能靠点开浏览器才能验证 —— 而错一个时区就是「公告存下来了但永远不显示」。

/**
 * `<input type="datetime-local">` 给的是不带时区的本地墙上时间（`2026-09-20T09:00`）。
 * 契约要的是带偏移的 ISO 串。直接拼 "Z" 会把它当成 UTC —— 在东八区就是整整差 8 小时，
 * 而这条链路上的错位不会报错，只会让公告在错误的时刻出现或消失。
 */
export function localInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * INVARIANT: 结束早于开始的窗口永远不会展示。权威不校验先后（`activeAnnouncements`
 * 只是两个独立的比较），所以这条得在发出去之前挡住，否则运营会得到一条存成功、
 * 却永远看不见的公告，而且没有任何提示。
 */
export function announcementWindowOrdered(startsAt: string, endsAt: string): boolean {
  const from = localInputToIso(startsAt);
  const to = localInputToIso(endsAt);
  if (!from || !to) return true;
  return Date.parse(from) < Date.parse(to);
}
