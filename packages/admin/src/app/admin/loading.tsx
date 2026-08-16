// SPEC: 骨架必须和真实外壳同构——248px 侧栏（品牌头 + 一个常驻项 + 六个折叠分组标题）、
//       h-14 顶栏（面包屑 + 标题 + 搜索 + 两个按钮）、内容区。
// INTENT: 之前是一个完全空白的侧栏加两块灰条，和加载完成后的画面对不上，于是每次路由切换
//         都要整页重排一次——骨架屏本来就是为了消除这次重排。占位块的高度取自 AdminConsoleClient
//         里的实际尺寸（导航项 h-10 + mb-1、分组标题 h-9、顶栏 min-h-14）。
const FOLDED_GROUP_COUNT = 6;

export default function AdminLoading() {
  return (
    <main aria-busy="true" aria-label="正在加载后台工作区" className="min-h-screen bg-[var(--ad-canvas)] text-[var(--ad-ink)]">
      <div className="flex min-h-screen animate-pulse">
        <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-[var(--ad-border)] bg-[var(--ad-surface)] xl:flex">
          <div className="flex h-14 shrink-0 items-center border-b border-[var(--ad-border)] px-5">
            <div className="h-4 w-28 rounded bg-black/[0.06]" />
          </div>
          <div className="p-3">
            <div className="mb-1 h-10 rounded-md bg-black/[0.05]" />
            <div className="mt-3 border-t border-[var(--ad-border)] pt-3">
              {Array.from({ length: FOLDED_GROUP_COUNT }, (_, index) => (
                <div className="mb-1 flex h-9 items-center px-3" key={index}>
                  <div className="h-2.5 w-24 rounded bg-black/[0.05]" />
                </div>
              ))}
            </div>
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          <header className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--ad-border)] px-4 py-2.5 md:px-6">
            <div className="min-w-0 flex-1">
              <div className="h-2.5 w-40 rounded bg-black/[0.05]" />
              <div className="mt-1.5 h-4 w-52 rounded bg-black/[0.06]" />
            </div>
            <div className="flex w-full items-center gap-2 md:w-auto">
              <div className="h-9 min-w-0 flex-1 rounded-md bg-black/[0.05] md:w-[320px] md:flex-none" />
              <div className="h-9 w-24 shrink-0 rounded-md bg-black/[0.05]" />
              <div className="h-9 w-28 shrink-0 rounded-md bg-black/[0.05]" />
            </div>
          </header>
          <div className="p-4 md:p-6">
            <div className="h-64 rounded-lg border border-[var(--ad-border)] bg-[var(--ad-surface)]" />
          </div>
        </section>
      </div>
    </main>
  );
}
