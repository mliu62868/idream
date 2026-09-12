import { z } from "zod";
import { parsePublicApiError } from "@/lib/public-api-contracts";

export async function comicRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const raw: unknown = await response.json();
  if (!response.ok) throw new Error(parsePublicApiError(raw)?.message ?? "Comic could not load. Try again.");
  return z.object({ ok: z.literal(true), data: schema }).parse(raw).data;
}

export const comicButton = "inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-bold hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-40";
export const comicInput = "w-full rounded-lg border border-white/20 bg-[rgb(24,24,24)] px-3 py-2.5 text-base text-white placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50";
