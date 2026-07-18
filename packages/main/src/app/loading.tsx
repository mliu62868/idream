export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading current content"
      className="min-h-screen bg-[rgb(13,13,13)] px-4 py-16 text-white md:px-[60px]"
      role="status"
    >
      <div className="mx-auto max-w-6xl animate-pulse">
        <div className="h-3 w-28 rounded-full bg-white/10" />
        <div className="mt-5 h-12 max-w-2xl rounded-2xl bg-white/10 md:h-16" />
        <div className="mt-5 h-5 max-w-xl rounded-full bg-white/10" />
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div
              className="h-64 rounded-[18px] border border-white/5 bg-white/5"
              key={index}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
