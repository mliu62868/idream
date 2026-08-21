const SLOT_TO_NODE: Readonly<Record<string, string>> = {
  ckpt_name: "CheckpointLoaderSimple",
  unet_name: "UNETLoader",
  clip_name: "CLIPLoader",
  vae_name: "VAELoader",
};

// SPEC: preflight queries the loader that owns each selectable model field.
// INTENT: ComfyUI-GGUF maintains a separate CLIPLoaderGGUF file list; asking the
// core CLIPLoader about an H3 GGUF encoder produces a false missing-model error.
export function modelLoaderNodeForReference(
  classType: string,
  slot: string,
): string | null {
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
