"use client";

import {
  characterProjectCreateResponseSchema,
  characterProjectDraftResumeSchema,
  characterWorkspaceProjectSchema,
  type CharacterProjectDraft,
  type CharacterProjectDraftAuthority,
} from "@idream/shared/admin";
import { ArrowLeft, ArrowRight, Check, Loader2, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import { cn } from "@/lib/utils";
import { WorkspaceButton, fieldClass, textAreaClass } from "@/features/operations/WorkspaceUi";

type Draft = CharacterProjectDraft;
type SaveState = "Not saved" | "Saving" | "Saved" | "Conflict" | "Failed to save";

const steps = ["Positioning", "Persona", "Visual direction", "Commercial intent", "Review"] as const;

const initialDraft: Draft = {
  positioning: {
    audience: "Define the adult audience for this companion",
    companionNeed: "Define the recurring companionship need",
    hypothesis: "State the behavior and outcome hypothesis",
    differentiation: "Explain why users will choose this character",
  },
  persona: {
    name: "Untitled companion",
    age: 18,
    gender: "female",
    relationshipArchetype: "trusted companion",
    characterPromise: "A specific, dependable companionship promise",
    personality: "Warm, observant, and consistent",
    tone: "Natural, concise, and emotionally present",
    backstory: "Draft the experiences that shape this character's point of view.",
    firstMessage: "I'm here. Where should we begin?",
    exampleDialogue: ["Tell me what matters most about that."],
  },
  visualDirection: {
    identityAnchor: "A recognizable adult companion identity",
    stableTraits: ["consistent face", "recognizable silhouette"],
    style: "realistic",
    referenceDirection: "Describe lighting, framing, wardrobe, and reference direction.",
  },
  commercialIntent: {
    ownerId: null,
    plannedLaunchAt: null,
    targetPlacementKeys: [],
    successCriteria: ["Define one measurable success criterion"],
    productionPackage: "Define the required identity, placement, and chat asset package.",
    qaPlan: "Define mobile, desktop, and conversation QA evidence.",
  },
};

function draftKey(value: Draft) {
  return JSON.stringify(value);
}

export function CharacterCreateWizard({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [authority, setAuthority] = useState<CharacterProjectDraftAuthority | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("Not saved");
  const [error, setError] = useState<string | null>(null);
  const authorityRef = useRef<CharacterProjectDraftAuthority | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const lastSavedKeyRef = useRef<string | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const persistNow = useCallback(async (snapshot: Draft, allowCreate: boolean) => {
    const key = draftKey(snapshot);
    if (lastSavedKeyRef.current === key && authorityRef.current) return;
    setSaveState("Saving");
    setError(null);
    try {
      if (!authorityRef.current) {
        if (!allowCreate) return;
        idempotencyKeyRef.current ??= crypto.randomUUID();
        const created = await adminV2Request("/api/v2/admin/characters", {
          method: "POST",
          idempotencyKey: idempotencyKeyRef.current,
          schema: characterProjectCreateResponseSchema,
          body: {
            ...snapshot,
            reason: {
              code: "character_wizard_started",
              summary: "Create a server-authoritative Character Project draft",
            },
            confirmation: "CREATE CHARACTER",
          },
        });
        authorityRef.current = created;
        setAuthority(created);
        const url = new URL(window.location.href);
        url.searchParams.set("draft", created.characterId);
        window.history.replaceState(null, "", `${url.pathname}?${url.searchParams.toString()}`);
      } else {
        const saved = await adminV2Request(`/api/v2/admin/characters/${authorityRef.current.characterId}/project`, {
          method: "PATCH",
          ifMatch: authorityRef.current.projectVersion,
          schema: characterWorkspaceProjectSchema,
          body: {
            entityVersion: authorityRef.current.projectVersion,
            ownerId: snapshot.commercialIntent.ownerId,
            audience: snapshot.positioning.audience,
            companionNeed: snapshot.positioning.companionNeed,
            hypothesis: snapshot.positioning.hypothesis,
            differentiation: snapshot.positioning.differentiation,
            targetPlacementKeys: snapshot.commercialIntent.targetPlacementKeys,
            successCriteria: snapshot.commercialIntent.successCriteria,
            productionPackage: snapshot.commercialIntent.productionPackage,
            qaPlan: snapshot.commercialIntent.qaPlan,
            plannedLaunchAt: snapshot.commercialIntent.plannedLaunchAt,
            content: {
              persona: snapshot.persona,
              visualDirection: snapshot.visualDirection,
            },
            reason: "Autosave Character creation wizard",
          },
        });
        const next = { ...authorityRef.current, projectVersion: saved.version };
        authorityRef.current = next;
        setAuthority(next);
      }
      lastSavedKeyRef.current = key;
      setSaveState("Saved");
    } catch (cause) {
      if (cause instanceof AdminV2RequestError && cause.status === 409) setSaveState("Conflict");
      else setSaveState("Failed to save");
      setError(cause instanceof Error ? cause.message : "Character draft could not be saved");
      throw cause;
    }
  }, []);

  const persist = useCallback((snapshot: Draft, allowCreate: boolean) => {
    const run = saveQueueRef.current.then(() => persistNow(snapshot, allowCreate));
    saveQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, [persistNow]);

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      const characterId = new URLSearchParams(window.location.search).get("draft");
      if (!characterId || authorityRef.current) return;
      setSaveState("Saving");
      setError(null);
      try {
        const resumed = await adminV2Request(`/api/v2/admin/characters/${encodeURIComponent(characterId)}/project`, {
          schema: characterProjectDraftResumeSchema,
        });
        authorityRef.current = resumed.authority;
        lastSavedKeyRef.current = draftKey(resumed.draft);
        setAuthority(resumed.authority);
        setDraft(resumed.draft);
        setSaveState("Saved");
      } catch (cause) {
        setSaveState("Failed to save");
        setError(cause instanceof Error ? cause.message : "Server draft could not be restored");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!authority) return;
    const timer = window.setTimeout(() => {
      void persist(draft, false).catch(() => undefined);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [authority, draft, persist]);

  if (!canCreate) {
    return (
      <section className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-6 sm:p-8">
        <ShieldAlert className="h-6 w-6 text-[var(--ad-text-muted)]" />
        <h1 className="mt-4 text-lg font-semibold">No permission</h1>
        <p className="mt-2 text-sm text-[var(--ad-text-muted)]">Your effective grants do not include character.project.write.</p>
      </section>
    );
  }

  async function next() {
    try {
      await persist(draft, true);
      setStep((current) => Math.min(steps.length - 1, current + 1));
    } catch {
      // The persistent state and inline error explain the failure.
    }
  }

  async function finish() {
    try {
      await persist(draft, true);
      const destination = authorityRef.current?.deepLink;
      if (destination) router.push(destination);
    } catch {
      // Stay on Review so the operator can resolve and retry.
    }
  }

  const update = <K extends keyof Draft>(section: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [section]: value }));
    if (authorityRef.current) setSaveState("Not saved");
  };
  const currentLabel = steps[step];

  return (
    <section className="mx-auto max-w-4xl" data-testid="character-create-wizard">
      <header className="rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ad-text-muted)]">Character Studio · Server draft</p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Create Character Project</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ad-text-muted)]">Each completed step is persisted to the authority. Content autosaves create immutable versions and revisions.</p>
          </div>
          <SaveIndicator state={saveState} />
        </div>
        <ol className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Character creation progress">
          {steps.map((label, index) => (
            <li className={cn("rounded-md border px-3 py-2 text-xs", index === step ? "border-[var(--ad-ink)] font-semibold" : "border-[var(--ad-border)] text-[var(--ad-text-muted)]")} key={label}>
              <span className="mr-1 tabular-nums">{index + 1}.</span>{label}
            </li>
          ))}
        </ol>
      </header>

      <div className="mt-4 rounded-xl border border-[var(--ad-border)] bg-[var(--ad-surface)] p-4 sm:p-6">
        <h2 className="text-lg font-semibold">{currentLabel}</h2>
        <p className="mt-1 text-xs text-[var(--ad-text-muted)]">Project version {authority?.projectVersion ?? "not created"}</p>
        <div className="mt-5">
          {step === 0 ? <PositioningStep draft={draft} update={update} /> : null}
          {step === 1 ? <PersonaStep draft={draft} update={update} /> : null}
          {step === 2 ? <VisualStep draft={draft} update={update} /> : null}
          {step === 3 ? <CommercialStep draft={draft} update={update} /> : null}
          {step === 4 ? <ReviewStep draft={draft} /> : null}
        </div>
        {error ? <p className="mt-4 rounded-md bg-[var(--ad-red-bg)] p-3 text-sm text-[var(--ad-red-text)]" role="alert">{error}</p> : null}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <WorkspaceButton disabled={step === 0 || saveState === "Saving"} onClick={() => setStep((current) => Math.max(0, current - 1))}>
            <ArrowLeft className="h-4 w-4" /> Back
          </WorkspaceButton>
          {step < steps.length - 1 ? (
            <WorkspaceButton disabled={saveState === "Saving"} onClick={() => void next()} tone="primary">
              {step === 0 ? "Save positioning & continue" : "Save & continue"} <ArrowRight className="h-4 w-4" />
            </WorkspaceButton>
          ) : (
            <WorkspaceButton disabled={saveState === "Saving"} onClick={() => void finish()} tone="primary">
              <Check className="h-4 w-4" /> Save and open project
            </WorkspaceButton>
          )}
        </div>
      </div>
    </section>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  return (
    <span className="inline-flex min-h-8 items-center gap-2 rounded-md bg-black/[0.04] px-3 text-xs font-semibold" role="status">
      {state === "Saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : state === "Saved" ? <Check className="h-3.5 w-3.5" /> : null}
      {state}
    </span>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2">{children}</div>;
}

function Field({ label, value, onChange, type = "text" }: { label: string; value: string | number; onChange: (value: string) => void; type?: "text" | "number" | "datetime-local" }) {
  return <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{label}<input className={`${fieldClass} mt-1`} min={type === "number" ? 18 : undefined} onChange={(event) => onChange(event.target.value)} type={type} value={value} /></label>;
}

function Area({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-xs font-semibold text-[var(--ad-text-muted)]">{label}<textarea className={`${textAreaClass} mt-1`} onChange={(event) => onChange(event.target.value)} value={value} /></label>;
}

function PositioningStep({ draft, update }: StepProps) {
  const set = (field: keyof Draft["positioning"], value: string) => update("positioning", { ...draft.positioning, [field]: value });
  return <Grid><Area label="Audience" onChange={(value) => set("audience", value)} value={draft.positioning.audience} /><Area label="Companion need" onChange={(value) => set("companionNeed", value)} value={draft.positioning.companionNeed} /><Area label="Hypothesis" onChange={(value) => set("hypothesis", value)} value={draft.positioning.hypothesis} /><Area label="Differentiation" onChange={(value) => set("differentiation", value)} value={draft.positioning.differentiation} /></Grid>;
}

type StepProps = { draft: Draft; update: <K extends keyof Draft>(section: K, value: Draft[K]) => void };

function PersonaStep({ draft, update }: StepProps) {
  const set = <K extends keyof Draft["persona"]>(field: K, value: Draft["persona"][K]) => update("persona", { ...draft.persona, [field]: value });
  return <div className="space-y-4"><Grid><Field label="Name" onChange={(value) => set("name", value)} value={draft.persona.name} /><Field label="Age (18+)" onChange={(value) => set("age", Math.max(18, Number(value) || 18))} type="number" value={draft.persona.age} /><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Gender<select className={`${fieldClass} mt-1`} onChange={(event) => set("gender", event.target.value as Draft["persona"]["gender"])} value={draft.persona.gender}><option value="female">Female</option><option value="male">Male</option><option value="trans">Trans</option></select></label><Field label="Relationship archetype" onChange={(value) => set("relationshipArchetype", value)} value={draft.persona.relationshipArchetype} /></Grid><Grid><Area label="Character promise" onChange={(value) => set("characterPromise", value)} value={draft.persona.characterPromise} /><Area label="Personality" onChange={(value) => set("personality", value)} value={draft.persona.personality} /><Area label="Tone" onChange={(value) => set("tone", value)} value={draft.persona.tone} /><Area label="Backstory" onChange={(value) => set("backstory", value)} value={draft.persona.backstory} /><Area label="First message" onChange={(value) => set("firstMessage", value)} value={draft.persona.firstMessage} /><Area label="Example dialogue (one per line)" onChange={(value) => set("exampleDialogue", lines(value))} value={draft.persona.exampleDialogue.join("\n")} /></Grid></div>;
}

function VisualStep({ draft, update }: StepProps) {
  const set = <K extends keyof Draft["visualDirection"]>(field: K, value: Draft["visualDirection"][K]) => update("visualDirection", { ...draft.visualDirection, [field]: value });
  return <Grid><Area label="Identity anchor" onChange={(value) => set("identityAnchor", value)} value={draft.visualDirection.identityAnchor} /><Area label="Stable traits (one per line)" onChange={(value) => set("stableTraits", lines(value))} value={draft.visualDirection.stableTraits.join("\n")} /><label className="text-xs font-semibold text-[var(--ad-text-muted)]">Visual style<select className={`${fieldClass} mt-1`} onChange={(event) => set("style", event.target.value as Draft["visualDirection"]["style"])} value={draft.visualDirection.style}><option value="realistic">Realistic</option><option value="anime">Anime</option><option value="hybrid">Hybrid</option><option value="other">Other</option></select></label><Area label="Reference direction" onChange={(value) => set("referenceDirection", value)} value={draft.visualDirection.referenceDirection} /></Grid>;
}

function CommercialStep({ draft, update }: StepProps) {
  const set = <K extends keyof Draft["commercialIntent"]>(field: K, value: Draft["commercialIntent"][K]) => update("commercialIntent", { ...draft.commercialIntent, [field]: value });
  return <Grid><Field label="Owner ID" onChange={(value) => set("ownerId", value.trim() || null)} value={draft.commercialIntent.ownerId ?? ""} /><Field label="Planned launch" onChange={(value) => set("plannedLaunchAt", value ? new Date(value).toISOString() : null)} type="datetime-local" value={dateInput(draft.commercialIntent.plannedLaunchAt)} /><Area label="Target placements (one per line)" onChange={(value) => set("targetPlacementKeys", lines(value))} value={draft.commercialIntent.targetPlacementKeys.join("\n")} /><Area label="Success criteria (one per line)" onChange={(value) => set("successCriteria", lines(value))} value={draft.commercialIntent.successCriteria.join("\n")} /><Area label="Production package" onChange={(value) => set("productionPackage", value)} value={draft.commercialIntent.productionPackage} /><Area label="QA plan" onChange={(value) => set("qaPlan", value)} value={draft.commercialIntent.qaPlan} /></Grid>;
}

function ReviewStep({ draft }: { draft: Draft }) {
  const rows = [
    ["Character", `${draft.persona.name}, age ${draft.persona.age}`],
    ["Audience", draft.positioning.audience],
    ["Promise", draft.persona.characterPromise],
    ["Visual anchor", draft.visualDirection.identityAnchor],
    ["Owner", draft.commercialIntent.ownerId ?? "Unassigned"],
    ["Success", draft.commercialIntent.successCriteria.join(" · ")],
  ];
  return <dl className="divide-y divide-[var(--ad-border)] rounded-lg border border-[var(--ad-border)]">{rows.map(([label, value]) => <div className="grid gap-1 p-3 sm:grid-cols-[140px_1fr]" key={label}><dt className="text-xs font-semibold text-[var(--ad-text-muted)]">{label}</dt><dd className="text-sm">{value}</dd></div>)}</dl>;
}

function lines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function dateInput(value: string | null) {
  return value ? value.slice(0, 16) : "";
}
