"use client";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:border-[#c9c7c0] disabled:bg-[#e7e5df] disabled:text-[#5d5f59] active:scale-[0.98]";

export function PrimaryButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(BASE, "bg-[var(--ad-ink)] text-white hover:bg-[#333333]", className)}
      {...props}
    />
  );
}

export function GhostButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        BASE,
        "border border-[var(--ad-border)] bg-[var(--ad-surface)] text-[var(--ad-text)] hover:bg-black/[0.03]",
        className,
      )}
      {...props}
    />
  );
}

export function DangerButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        BASE,
        "border border-[var(--ad-red-text)]/20 bg-[var(--ad-red-bg)] text-[var(--ad-red-text)] hover:bg-[var(--ad-red-hover)]",
        className,
      )}
      {...props}
    />
  );
}
