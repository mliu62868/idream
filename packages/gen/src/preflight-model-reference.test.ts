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

  it("keeps checkpoint, UNET, VAE, and model-only LoRA probes", () => {
    expect(modelLoaderNodeForReference("CheckpointLoaderSimple", "ckpt_name"))
      .toBe("CheckpointLoaderSimple");
    expect(modelLoaderNodeForReference("UNETLoader", "unet_name"))
      .toBe("UNETLoader");
    expect(modelLoaderNodeForReference("VAELoader", "vae_name"))
      .toBe("VAELoader");
    expect(modelLoaderNodeForReference("LoraLoaderModelOnly", "lora_name"))
      .toBe("LoraLoaderModelOnly");
    expect(modelLoaderNodeForReference("SaveVideo", "filename_prefix"))
      .toBeNull();
  });

  it("checks the Enhance weights against UpscaleModelLoader only", () => {
    expect(modelLoaderNodeForReference("UpscaleModelLoader", "model_name")).toBe("UpscaleModelLoader");
    expect(modelLoaderNodeForReference("SomeOtherNode", "model_name")).toBeNull();
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
