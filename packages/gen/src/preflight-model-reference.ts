const SLOT_TO_NODE: Readonly<Record<string, string>> = {
  ckpt_name: "CheckpointLoaderSimple",
  unet_name: "UNETLoader",
  clip_name: "CLIPLoader",
  vae_name: "VAELoader",
  lora_name: "LoraLoaderModelOnly",
};

// SPEC: preflight queries the loader that owns each selectable model field.
// INTENT: ComfyUI-GGUF maintains a separate CLIPLoaderGGUF file list; asking the
// core CLIPLoader about an H3 GGUF encoder produces a false missing-model error.
export function modelLoaderNodeForReference(
  classType: string,
  slot: string,
): string | null {
  if (slot === "model_name" && classType === "UpscaleModelLoader") return "UpscaleModelLoader";
  if (slot === "clip_name" && classType === "CLIPLoaderGGUF") {
    return "CLIPLoaderGGUF";
  }
  return SLOT_TO_NODE[slot] ?? null;
}

export function requiredComfyNodeTypes(
  apiPrompt: Readonly<Record<string, { readonly class_type?: unknown }>>,
): string[] {
  return [...new Set(
    Object.values(apiPrompt)
      .map((node) => node.class_type)
      .filter((value): value is string =>
        typeof value === "string" && value.length > 0
      ),
  )].sort();
}

// SPEC: list a loader field's selectable files from /object_info.
// INTENT: ComfyUI ships both the legacy `[[...files]]` spec and the V3
// `["COMBO", { options: [...] }]` spec (UpscaleModelLoader moved in 0.37).
export function comboOptions(spec: unknown): string[] | null {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0].filter((v): v is string => typeof v === "string");
  const options = (spec[1] as { options?: unknown } | undefined)?.options;
  if (spec[0] === "COMBO" && Array.isArray(options)) {
    return options.filter((v): v is string => typeof v === "string");
  }
  return null;
}
