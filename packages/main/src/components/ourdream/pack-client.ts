import { z } from "zod";

export const packButton = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/20 px-5 py-2 text-sm font-bold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40";
export const packInput = "w-full rounded-lg border border-white/20 bg-[rgb(24,24,24)] px-3 py-2.5 text-base text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50";
export function packPayload<T>(schema: z.ZodType<T>) {
  const envelope = z.object({ ok: z.literal(true), data: schema });
  return (raw: unknown): T => envelope.parse(raw).data;
}
export function packStateLabel(status: string, visibility: string) {
  const statuses: Record<string, string> = { draft: "Draft", published: "Published", withdrawn: "Withdrawn", blocked: "Blocked" };
  const audiences: Record<string, string> = { private: "Only you", unlisted: "Link only", public: "Public" };
  return `${statuses[status] ?? status} · ${audiences[visibility] ?? visibility}`;
}
