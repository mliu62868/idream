import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { homeFaqs } from "@/lib/ourdream-data";

export function HomeSeoSections() {
  return (
    <section className="px-4 pb-14 pt-12 md:px-[60px] md:pb-20 md:pt-16">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-center text-[32px] font-bold leading-10 text-white md:text-[36px]">
          One character, connected across every creative surface
        </h1>

        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            [
              "Discover",
              "Browse public companions and find a personality, visual style, and story hook that fits.",
            ],
            [
              "Create",
              "Shape a private or public character with identity details that carry into chat and images.",
            ],
            [
              "Continue",
              "Return to saved conversations, generated media, and the characters you are building over time.",
            ],
          ].map(([title, description]) => (
            <div
              className="rounded-[12px] border border-white/10 bg-[rgb(18,18,18)] p-5"
              key={title}
            >
              <h2 className="text-[22px] font-black uppercase leading-7 text-white">
                {title}
              </h2>
              <p className="mt-3 text-[14px] font-medium leading-6 text-[rgb(170,170,170)]">
                {description}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 border-t border-white/10 pt-10">
          <h2 className="mb-8 text-center text-[30px] font-bold leading-9 text-white">
            Frequently Asked Questions
          </h2>
          <div className="space-y-5">
            {homeFaqs.map((faq) => (
              <article
                className="rounded-[8px] border border-white/10 bg-[rgb(18,18,18)]/80 p-6"
                key={faq.question}
              >
                <h3 className="text-[18px] font-semibold leading-7 text-white">
                  {faq.question}
                </h3>
                <p className="mt-3 text-[15px] leading-7 text-[rgb(170,170,170)]">
                  {faq.answer}
                </p>
              </article>
            ))}
          </div>
        </div>

        <div className="mt-10 flex justify-center">
          <Link
            className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-white px-5 text-[14px] font-bold leading-4 text-[rgb(13,13,13)] transition-colors hover:bg-white/90"
            href="/upgrade"
          >
            Join Now
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
