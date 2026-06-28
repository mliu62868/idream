"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, Wand2 } from "lucide-react";

type DraftPayload = {
  ok?: boolean;
  error?: { message?: string };
  data?: {
    draft?: { id: string };
    character?: { id: string; name: string; status?: string };
    asset?: { url: string };
    previewJob?: { id: string; status: string };
  };
};

type PreviewStatus = "idle" | "generating" | "complete" | "failed";

type CreateTemplate = {
  id: string;
  name: string;
  summary?: string | null;
  gender?: string | null;
  style?: string | null;
  appearance?: unknown;
  advancedDetails?: unknown;
  tags?: unknown;
};

// Templates store free-form Json; pull a usable string for the draft's prompt-shaped fields.
function pickString(value: unknown, ...keys: string[]): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of keys) {
      const inner = (value as Record<string, unknown>)[key];
      if (typeof inner === "string" && inner.trim()) return inner;
    }
  }
  return "";
}

function pickTags(value: unknown): string {
  if (Array.isArray(value)) return value.filter((t) => typeof t === "string").join(",");
  if (typeof value === "string") return value;
  return "";
}

const DEFAULT_PREVIEW = "/images/ourdream/card-sarah-mercer.webp";
const STORAGE_KEY = "ourdream.create.draft.v1";

const STEPS = ["Identity", "Appearance", "Personality", "Preview", "Publish"] as const;

type WizardState = {
  draftId: string;
  step: number;
  name: string;
  age: number;
  gender: string;
  style: string;
  appearance: string;
  hair: string;
  body: string;
  description: string;
  tags: string;
  visibility: string;
};

const INITIAL: WizardState = {
  draftId: "",
  step: 0,
  name: "Nova Vale",
  age: 21,
  gender: "female",
  style: "realistic",
  appearance: "cinematic brunette with soft lighting",
  hair: "long wavy hair",
  body: "athletic",
  description: "A warm, cinematic companion with a confident personality.",
  tags: "romantic,caring,slow-burn",
  visibility: "private",
};

export function CreateWorkspace() {
  const [state, setState] = useState<WizardState>(INITIAL);
  const [preview, setPreview] = useState(DEFAULT_PREVIEW);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [status, setStatus] = useState("");
  const [createdCharacterId, setCreatedCharacterId] = useState("");
  const [createdStatus, setCreatedStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [templates, setTemplates] = useState<CreateTemplate[]>([]);
  const [templateId, setTemplateId] = useState("");

  const step = state.step;
  const set = useCallback(
    <K extends keyof WizardState>(key: K, value: WizardState[K]) =>
      setState((current) => ({ ...current, [key]: value })),
    [],
  );

  // Resume a draft after refresh: client-persisted wizard state (the draft API has no GET).
  // localStorage is browser-only, so we hydrate post-mount rather than in a lazy initializer
  // (a lazy initializer would diverge from the SSR markup and break hydration).
  useEffect(() => {
    let restored: WizardState | null = null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) restored = { ...INITIAL, ...(JSON.parse(raw) as Partial<WizardState>) };
    } catch {
      // ignore malformed storage
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from browser storage
    if (restored) setState(restored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota/serialization errors
    }
  }, [state, hydrated]);

  // Load admin-curated starting templates (public, active only). Best-effort: the create
  // flow stays fully usable from scratch if none exist or the fetch fails.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/v1/character-templates");
        if (!res.ok) return;
        const payload = (await res.json()) as { data?: { items?: CreateTemplate[] } };
        if (alive && Array.isArray(payload.data?.items)) setTemplates(payload.data.items);
      } catch {
        // ignore — templates are optional scaffolding
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function applyTemplate(template: CreateTemplate) {
    // Selecting a template seeds the draft; the user is then free to edit everything (no runtime link).
    setTemplateId(template.id);
    setState((current) => ({
      ...current,
      gender: template.gender || current.gender,
      style: template.style || current.style,
      appearance: pickString(template.appearance, "prompt", "summary") || current.appearance,
      description:
        pickString(template.advancedDetails, "description") || template.summary || current.description,
      tags: pickTags(template.tags) || current.tags,
    }));
    setStatus(`Started from "${template.name}". Edit any field before publishing.`);
  }

  const nameError = state.name.trim().length < 2 ? "Name needs at least 2 characters." : "";
  const ageError = state.age < 18 || state.age > 99 ? "Age must be between 18 and 99." : "";

  async function ensureDraft(): Promise<string> {
    if (state.draftId) return state.draftId;
    const created = await api("/api/v1/character-drafts", {
      name: state.name,
      style: state.style,
      gender: state.gender,
    });
    const id = created.data?.draft?.id;
    if (!id) throw new Error("Draft failed");
    set("draftId", id);
    return id;
  }

  async function saveStep(nextStep: number) {
    const draftId = await ensureDraft();
    await api(
      `/api/v1/character-drafts/${draftId}`,
      {
        step: Math.min(nextStep, 12),
        name: state.name,
        style: state.style,
        gender: state.gender,
        appearance: { prompt: state.appearance },
        hair: { prompt: state.hair },
        body: { type: state.body },
        advancedDetails: { description: state.description },
        tags: normalizedTags(state.tags),
      },
      "PATCH",
    );
  }

  async function next() {
    if (step === 0 && (nameError || ageError)) {
      setStatus(nameError || ageError);
      return;
    }
    setPending(true);
    setStatus("");
    try {
      await saveStep(step + 1);
      set("step", Math.min(step + 1, STEPS.length - 1));
    } catch (error) {
      setStatus(messageFrom(error));
    } finally {
      setPending(false);
    }
  }

  function back() {
    setStatus("");
    set("step", Math.max(step - 1, 0));
  }

  async function generatePreview() {
    setPending(true);
    setPreviewStatus("generating");
    setStatus("");
    try {
      const draftId = await ensureDraft();
      await saveStep(3);
      // Preview generation is async (worker-backed): enqueue, then poll the job
      // status until it settles. Keeps the UI responsive for slow image providers.
      await api(`/api/v1/character-drafts/${draftId}/preview`, {});
      const asset = await pollPreview(draftId);
      if (asset?.url) setPreview(asset.url);
      setPreviewStatus("complete");
    } catch (error) {
      setPreviewStatus("failed");
      setStatus(messageFrom(error));
    } finally {
      setPending(false);
    }
  }

  // Poll the preview job until completed (returns the asset) or failed/timeout.
  async function pollPreview(draftId: string): Promise<{ url?: string } | null> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = await api(`/api/v1/character-drafts/${draftId}/preview`, undefined, "GET");
      const job = status.data?.previewJob;
      if (job?.status === "completed") return status.data?.asset ?? null;
      if (job?.status === "failed") throw new Error("Preview generation failed. Try again.");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    throw new Error("Preview timed out. Try again.");
  }

  async function submit() {
    // Guard against double-submit: once a character is created, don't reuse the same
    // draft to create a duplicate (the success state already links onward).
    if (pending || createdCharacterId) return;
    setPending(true);
    setStatus("");
    setCreatedCharacterId("");
    setCreatedStatus("");
    try {
      const draftId = await ensureDraft();
      await saveStep(STEPS.length);
      await api(`/api/v1/character-drafts/${draftId}/tags`, { tags: normalizedTags(state.tags) });
      const submitted = await api(`/api/v1/character-drafts/${draftId}/submit`, {
        visibility: state.visibility,
        description: state.description,
        age: state.age,
      });
      const character = submitted.data?.character;
      if (character?.id) {
        setCreatedCharacterId(character.id);
        setCreatedStatus(character.status ?? "");
      }
      setStatus(
        character
          ? character.status === "pending_review"
            ? `${character.name} submitted for review. Public characters go live after approval.`
            : `Saved ${character.name} to My AI.`
          : "Character submitted.",
      );
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    } catch (error) {
      setStatus(messageFrom(error));
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

        <ol className="mt-8 flex flex-wrap justify-center gap-2" data-testid="create-steps">
          {STEPS.map((label, index) => (
            <li
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-bold uppercase ${
                index === step
                  ? "bg-white text-[rgb(13,13,13)]"
                  : index < step
                    ? "bg-[rgb(36,36,36)] text-[rgb(253,95,194)]"
                    : "bg-[rgb(36,36,36)] text-[rgb(114,113,112)]"
              }`}
              key={label}
            >
              {index < step ? <Check className="h-3.5 w-3.5" /> : <span>{index + 1}</span>}
              {label}
            </li>
          ))}
        </ol>

        <div className="mt-8 grid gap-4 md:grid-cols-[360px_1fr]">
          <div className="relative min-h-[560px] overflow-hidden rounded-[20px] bg-[rgb(18,18,18)]">
            <Image alt="" className="object-cover object-top" fill priority sizes="360px" src={preview} />
            <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(0,0,0,.82),rgba(0,0,0,.1)_62%,transparent)]" />
            {previewStatus === "generating" && (
              <div className="absolute inset-0 grid place-items-center bg-black/50 text-[13px] font-bold text-white">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Generating preview…
                </span>
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 p-5">
              <p className="text-[12px] font-black uppercase text-[rgb(253,95,194)]">Preview</p>
              <h2 className="mt-2 text-[26px] font-black leading-7">{state.name}</h2>
              <p className="mt-2 text-[13px] font-medium leading-5 text-[rgb(170,170,170)]">
                {state.description}
              </p>
            </div>
          </div>

          <div className="rounded-[20px] border border-white/10 bg-[rgb(18,18,18)] p-4 md:p-6">
            {step === 0 && templates.length > 0 && (
              <div className="mb-4" data-testid="create-templates">
                <p className="text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
                  Start from a template
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    className={`h-9 rounded-full px-3 text-[12px] font-bold ${
                      templateId === ""
                        ? "bg-white text-[rgb(13,13,13)]"
                        : "bg-[rgb(36,36,36)] text-white"
                    }`}
                    onClick={() => {
                      setTemplateId("");
                      setStatus("");
                    }}
                    type="button"
                  >
                    From scratch
                  </button>
                  {templates.map((template) => (
                    <button
                      className={`h-9 rounded-full px-3 text-[12px] font-bold ${
                        templateId === template.id
                          ? "bg-white text-[rgb(13,13,13)]"
                          : "bg-[rgb(36,36,36)] text-white"
                      }`}
                      key={template.id}
                      onClick={() => applyTemplate(template)}
                      title={template.summary ?? undefined}
                      type="button"
                    >
                      {template.name}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {step === 0 && (
              <div className="grid gap-3 md:grid-cols-2" data-testid="create-step-identity">
                <Field label="Name">
                  <input
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                    onChange={(event) => set("name", event.target.value)}
                    value={state.name}
                  />
                </Field>
                <Field label="Age" hint={ageError || "18+ only"}>
                  <input
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                    max={99}
                    min={18}
                    onChange={(event) => set("age", Number(event.target.value))}
                    type="number"
                    value={state.age}
                  />
                </Field>
                <Field label="Gender">
                  <select
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                    onChange={(event) => set("gender", event.target.value)}
                    value={state.gender}
                  >
                    <option value="female">Female</option>
                    <option value="male">Male</option>
                    <option value="trans">Trans</option>
                  </select>
                </Field>
                <Field label="Style">
                  <select
                    className="mt-2 w-full bg-transparent text-[18px] font-bold leading-6 outline-none"
                    onChange={(event) => set("style", event.target.value)}
                    value={state.style}
                  >
                    <option value="realistic">Realistic</option>
                    <option value="anime">Anime</option>
                    <option value="hybrid">Hybrid</option>
                  </select>
                </Field>
                <p className="md:col-span-2 text-[12px] font-medium text-[rgb(170,170,170)]">
                  Characters must be adults (18+). Content depicting minors or real people is prohibited.
                </p>
              </div>
            )}

            {step === 1 && (
              <div className="grid gap-3 md:grid-cols-3" data-testid="create-step-appearance">
                <Field label="Appearance">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                    onChange={(event) => set("appearance", event.target.value)}
                    value={state.appearance}
                  />
                </Field>
                <Field label="Hair">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                    onChange={(event) => set("hair", event.target.value)}
                    value={state.hair}
                  />
                </Field>
                <Field label="Body">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 outline-none"
                    onChange={(event) => set("body", event.target.value)}
                    value={state.body}
                  />
                </Field>
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-3" data-testid="create-step-personality">
                <Field label="Advanced Details">
                  <textarea
                    className="mt-3 min-h-28 w-full rounded-[12px] border border-white/10 bg-[rgb(13,13,13)] p-4 text-[14px] font-medium leading-6 text-white outline-none"
                    onChange={(event) => set("description", event.target.value)}
                    value={state.description}
                  />
                </Field>
                <Field label="Tags">
                  <input
                    className="mt-2 w-full bg-transparent text-[14px] font-semibold leading-6 text-white outline-none"
                    onChange={(event) => set("tags", event.target.value)}
                    value={state.tags}
                  />
                </Field>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-4" data-testid="create-step-preview">
                <p className="text-[13px] font-medium text-[rgb(170,170,170)]">
                  Generate a preview to see how {state.name} looks before publishing.
                </p>
                <button
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[rgb(36,36,36)] text-[14px] font-black text-white disabled:opacity-60"
                  disabled={pending}
                  onClick={() => void generatePreview()}
                  type="button"
                >
                  {previewStatus === "generating" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="h-4 w-4" />
                  )}
                  {previewStatus === "complete" ? "Regenerate preview" : "Generate preview"}
                </button>
                {previewStatus === "complete" && (
                  <p className="text-[13px] font-semibold text-[rgb(120,220,170)]">Preview ready.</p>
                )}
                {previewStatus === "failed" && (
                  <p className="text-[13px] font-semibold text-[rgb(255,140,140)]">
                    Preview failed. Try again or continue without one.
                  </p>
                )}
              </div>
            )}

            {step === 4 && (
              <div className="grid gap-4" data-testid="create-step-publish">
                <div>
                  <p className="text-[12px] font-bold uppercase text-[rgb(114,113,112)]">Visibility</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {["private", "unlisted", "public"].map((item) => (
                      <button
                        className={`h-10 rounded-full px-4 text-[12px] font-bold ${
                          state.visibility === item
                            ? "bg-white text-[rgb(13,13,13)]"
                            : "bg-[rgb(36,36,36)] text-white"
                        }`}
                        key={item}
                        onClick={() => set("visibility", item)}
                        type="button"
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[12px] font-medium text-[rgb(170,170,170)]">
                    {state.visibility === "public"
                      ? "Public characters are reviewed before appearing in Explore and Community."
                      : state.visibility === "unlisted"
                        ? "Unlisted characters are only reachable by direct link."
                        : "Private characters stay in your My AI only."}
                  </p>
                </div>
                <button
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(0deg,#ff1cac,#fd5fc2_50%,#ff79d1)] text-[14px] font-black text-white disabled:opacity-70"
                  data-testid="create-submit"
                  disabled={pending || Boolean(createdCharacterId)}
                  onClick={() => void submit()}
                  type="button"
                >
                  <Wand2 className="h-4 w-4" />
                  {pending ? "Submitting…" : state.visibility === "public" ? "Submit for review" : "Save character"}
                </button>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                className="inline-flex h-11 items-center gap-2 rounded-full bg-[rgb(36,36,36)] px-5 text-[13px] font-bold text-white disabled:opacity-40"
                disabled={step === 0 || pending}
                onClick={back}
                type="button"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
              {step < STEPS.length - 1 && (
                <button
                  className="inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 text-[13px] font-black text-[rgb(13,13,13)] disabled:opacity-60"
                  data-testid="create-next"
                  disabled={pending}
                  onClick={() => void next()}
                  type="button"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Next
                  <ArrowRight className="h-4 w-4" />
                </button>
              )}
            </div>

            {status && (
              <p className="mt-4 text-[13px] font-medium text-[rgb(220,220,220)]" data-testid="create-status">
                {status}
              </p>
            )}
            {createdCharacterId && createdStatus !== "pending_review" && (
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
            {createdCharacterId && createdStatus === "pending_review" && (
              <Link
                className="mt-4 inline-flex h-10 items-center justify-center rounded-full bg-[rgb(36,36,36)] px-4 text-[13px] font-bold text-white"
                href="/custom"
              >
                View in My AI
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: Readonly<{ label: string; hint?: string; children: React.ReactNode }>) {
  return (
    <label className="block rounded-[14px] bg-[rgb(36,36,36)] p-4 text-left text-white">
      <span className="block text-[12px] font-bold uppercase leading-4 text-[rgb(114,113,112)]">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] font-medium text-[rgb(170,170,170)]">{hint}</span>}
    </label>
  );
}

async function api(path: string, body?: unknown, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    // GET/HEAD cannot carry a body — only serialize for write methods.
    body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  // Logged-out users can't create drafts; send them to sign up instead of
  // dead-ending on a 401 (mirrors CharacterDetailClient.startChat).
  if (response.status === 401) {
    window.location.href = "/signup";
    throw new Error("Sign in to create a character. Redirecting…");
  }
  const payload = (await response.json()) as DraftPayload;
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error?.message ?? "Sign in, accept the age gate, then try again.");
  }
  return payload;
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Sign in, accept the age gate, then try again.";
}

function normalizedTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
}
