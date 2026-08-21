import { describe, expect, it } from "vitest";
import h3Descriptor from "../workflows/minimax-h3-redcraft-i2v.json";
import {
  modelLoaderNodeForReference,
  requiredComfyNodeTypes,
} from "./preflight-model-reference";

describe("modelLoaderNodeForReference", () => {
  it("checks GGUF text encoders against the loader that actually owns them", () => {
    expect(modelLoaderNodeForReference("CLIPLoaderGGUF", "clip_name"))
      .toBe("CLIPLoaderGGUF");
    expect(modelLoaderNodeForReference("CLIPLoader", "clip_name"))
      .toBe("CLIPLoader");
  });

  it("keeps the existing checkpoint, UNET, and VAE probes", () => {
    expect(modelLoaderNodeForReference("CheckpointLoaderSimple", "ckpt_name"))
      .toBe("CheckpointLoaderSimple");
    expect(modelLoaderNodeForReference("UNETLoader", "unet_name"))
      .toBe("UNETLoader");
    expect(modelLoaderNodeForReference("VAELoader", "vae_name"))
      .toBe("VAELoader");
    expect(modelLoaderNodeForReference("SaveVideo", "filename_prefix"))
      .toBeNull();
  });

  it("enumerates every executable H3 node type for runner preflight", () => {
    expect(requiredComfyNodeTypes(h3Descriptor.apiPrompt)).toEqual(
      expect.arrayContaining([
        "MiniMaxH3SigmaShift",
        "MiniMaxH3ImageToVideo",
        "VAEDecodeAudio",
        "CreateVideo",
        "SaveVideo",
      ]),
    );
  });
});
