import { z } from "zod";

// SPEC: the `{ ok: true, data }` unwrap every Comic read shares.
//
// INTENT: was `comicRequest`, one of six private copies of "fetch, decode the
// envelope, throw the server's message". The fetch half now belongs to
// `loadViewerResource`, which also decides whether the answer still matters —
// the copies here could not, so a Comic read that outlived an account change
// still painted its result. What is left is the part that is genuinely about
// Comics: which schema the envelope carries.
export function comicPayload<T>(schema: z.ZodType<T>): (raw: unknown) => T {
  const envelope = z.object({ ok: z.literal(true), data: schema });
  return (raw) => envelope.parse(raw).data;
}

export const comicButton = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-bold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40";
export const comicInput = "w-full rounded-lg border border-white/20 bg-[rgb(24,24,24)] px-3 py-2.5 text-base text-white placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50";
