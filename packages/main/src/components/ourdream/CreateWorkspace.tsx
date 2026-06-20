"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useState } from "react";
import { Check, Wand2 } from "lucide-react";

type DraftPayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    draft?: { id: string };
    character?: { id: string; name: string };
    asset?: { url: string };
  };
};

export function CreateWorkspace() {
  const [name, setName] = useState("Nova Vale");
  const [age, setAge] = useState(21);
  const [gender, setGender] = useState("female");
  const [description, setDescription] = useState(
    "A warm, cinematic companion with a confident personality.",
  );
  const [style, setStyle] = useState("realistic");
  const [visibility, setVisibility] = useState("private");
  const [appearance, setAppearance] = useState("cinematic brunette with soft lighting");
  const [hair, setHair] = useState("long wavy hair");
  const [body, setBody] = useState("athletic");
  const [tags, setTags] = useState("romantic,caring,slow-burn");
  const [preview, setPreview] = useState("/images/ourdream/card-sarah-mercer.webp");
  const [status, setStatus] = useState("");
  const [createdCharacterId, setCreatedCharacterId] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus("");
    setCreatedCharacterId("");
    try {
      const created = await api("/api/v1/character-drafts", {
        name,
        style,
        gender,
      });
      const draftId = created.data?.draft?.id;
      if (!draftId) throw new Error("Draft failed");
      await api(`/api/v1/character-drafts/${draftId}`, {
        step: 6,
        name,
        style,
        gender,
        appearance: { prompt: appearance },
        hair: { prompt: hair },
        body: { type: body },
        advancedDetails: { description },
        tags: normalizedTags(tags),
      }, "PATCH");
      await api(`/api/v1/character-drafts/${draftId}/tags`, {
        tags: normalizedTags(tags),
      });
      const previewPayload = await api(`/api/v1/character-drafts/${draftId}/preview`, {});
      if (previewPayload.data?.asset?.url) setPreview(previewPayload.data.asset.url);
      const submitted = await api(`/api/v1/character-drafts/${draftId}/submit`, {
        visibility,
        description,
        age,
      });
      if (submitted.data?.character?.id) setCreatedCharacterId(submitted.data.character.id);
      setStatus(
        submitted.data?.character
          ? `Saved ${submitted.data.character.name} to My AI.`
          : "Character submitted.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Sign in, accept the age gate, then try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="px-4 pb-12 pt-10 md:px-[60px] md:pb-16">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-center text-[clamp(28px,6vw,52px)] font-black leading-none text-white">
          Create Your Dream AI Girl
        </h1>
        <div className="mt-9 grid gap-4 md:grid-cols-[360px_1fr]">
          <div className="relative min-h-[560px] overflow-hidden rounded-[20px] bg-[rgb(18,18,18)]">
            <Image
              alt=""
              className="object-cover object-top"
              fill
              priority
              sizes="360px"
              src={preview}
            />
            <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.82),rgba(0,0,0,.1)_62%,transparent)]" />
            <div className="absolute inset-x-0 bottom-0 p-5">
              <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">
                Preview
              </p>
              <h2 className="mt-2 text-[26px] font-black leading-7">{name}</h2>
              <p className="mt-2 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                {description}
              </p>
            </div>
          </div>
          <form
            className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-6"
            onSubmit={submit}
          >
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white">
                <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                  Name
                </span>
                <input
                  className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>
              <label className="block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white">
                <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                  Age
                </span>
                <input
                  className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                  max={99}
                  min={18}
                  onChange={(event) => setAge(Number(event.target.value))}
                  type="number"
                  value={age}
                />
              </label>
              <label className="block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white">
                <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                  Gender
                </span>
                <select
                  className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                  onChange={(event) => setGender(event.target.value)}
                  value={gender}
                >
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="trans">Trans</option>
                </select>
              </label>
              <label className="block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white">
                <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                  Style
                </span>
                <select
                  className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                  onChange={(event) => setStyle(event.target.value)}
                  value={style}
                >
                  <option value="realistic">Realistic</option>
                  <option value="anime">Anime</option>
                  <option value="hybrid">Hybrid</option>
                </select>
              </label>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              {[
                ["Appearance", appearance, setAppearance],
                ["Hair", hair, setHair],
                ["Body", body, setBody],
              ].map(([label, value, setter]) => (
                <label
                  className="block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white"
                  key={label as string}
                >
                  <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                    {label as string}
                  </span>
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                    onChange={(event) =>
                      (setter as (next: string) => void)(event.target.value)
                    }
                    value={value as string}
                  />
                </label>
              ))}
            </div>
            <label className="mt-5 block rounded-[14px] bg-[rgb(36,36,36)] p-4">
              <span className="text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                Advanced Details
              </span>
              <textarea
                className="mt-3 min-h-28 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                onChange={(event) => setDescription(event.target.value)}
                value={description}
              />
            </label>
            <label className="mt-5 block rounded-[14px] bg-[rgb(36,36,36)] p-4">
              <span className="text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                Tags
              </span>
              <input
                className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 text-white outline-none"
                onChange={(event) => setTags(event.target.value)}
                value={tags}
              />
            </label>
            <div className="mt-4 flex gap-2">
              {["private", "public"].map((item) => (
                <button
                  className={`h-10 rounded-full px-4 text-[12px] font-bold ${
                    visibility === item ? "bg-white text-[rgb(13,13,13)]" : "bg-[rgb(36,36,36)] text-white"
                  }`}
                  key={item}
                  onClick={() => setVisibility(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
            <button
              className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[14px] font-black text-white disabled:opacity-70"
              disabled={pending}
              type="submit"
            >
              <Wand2 className="h-4 w-4" />
              {pending ? "Creating..." : "Generate character"}
            </button>
            {status && (
              <p className="mt-4 text-[13px] font-medium text-[rgb(170,170,170)]">
                {status}
              </p>
            )}
            {createdCharacterId && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Link
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-4 text-[13px] font-black text-[rgb(13,13,13)]"
                  href={`/characters/${createdCharacterId}`}
                >
                  <Check className="h-4 w-4" />
                  Open character
                </Link>
                <Link
                  className="inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                  href="/custom"
                >
                  My AI
                </Link>
              </div>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}

async function api(path: string, body: unknown, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as DraftPayload;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error?.message ?? path);
  }
  return payload;
}

function normalizedTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}
