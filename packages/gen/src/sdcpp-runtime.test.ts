import { describe, expect, it } from "vitest";
import {
  detectSdcppModelFamily,
  krea2TextEncoderCandidates,
  krea2VaeCandidates,
  normalizeSdcppSampler,
  validateSdcppRuntimeComponents,
} from "./sdcpp-runtime";

describe("normalizeSdcppSampler", () => {
  it("maps legacy UI sampler ids to stable-diffusion.cpp CLI values", () => {
    expect(normalizeSdcppSampler("dpmpp_2m")).toBe("dpm++2m");
    expect(normalizeSdcppSampler("dpm++ 2m")).toBe("dpm++2m");
    expect(normalizeSdcppSampler("dpmpp_2s_a")).toBe("dpm++2s_a");
    expect(normalizeSdcppSampler("ddim")).toBe("ddim_trailing");
  });

  it("keeps supported CLI sampler values unchanged", () => {
    expect(normalizeSdcppSampler("euler")).toBe("euler");
    expect(normalizeSdcppSampler("er_sde")).toBe("er_sde");
    expect(normalizeSdcppSampler("dpm++2mv2")).toBe("dpm++2mv2");
  });
});

describe("Krea2 runtime detection", () => {
  it("detects Krea2 model identifiers and paths", () => {
    expect(detectSdcppModelFamily(["redcraftkrea2redmix_krea2edition"])).toBe("krea2");
    expect(detectSdcppModelFamily(["/models/Krea-2/diffusion.safetensors"])).toBe("krea2");
    expect(detectSdcppModelFamily(["pornmaster-zimage-turbo"])).toBe("generic");
  });

  it("rejects Z-Image components for Krea2 before sd-cli metadata validation", () => {
    expect(() =>
      validateSdcppRuntimeComponents({
        family: "krea2",
        llmPath: "/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        vaePath: "/models/z-image-components/split_files/vae/ae.safetensors",
        fileExists: () => true,
      }),
    ).toThrow("Qwen3-VL 4B text encoder");
  });

  it("accepts Krea2 sdcpp component names when files are present", () => {
    const home = "/Users/tester";
    const llmPath = krea2TextEncoderCandidates(home)[0];
    const vaePath = krea2VaeCandidates(home)[0];
    expect(llmPath).toContain("Qwen3VL-4B-Instruct");
    expect(vaePath).toContain("wan_2.1_vae");
    expect(() =>
      validateSdcppRuntimeComponents({
        family: "krea2",
        llmPath,
        vaePath,
        fileExists: () => true,
      }),
    ).not.toThrow();
  });

  it("does not fall back to qwen_image VAE for Krea2", () => {
    const home = "/Users/tester";
    expect(krea2VaeCandidates(home).join("\n")).not.toContain("qwen_image_vae");
    expect(() =>
      validateSdcppRuntimeComponents({
        family: "krea2",
        llmPath: krea2TextEncoderCandidates(home)[0],
        vaePath: `${home}/.localai/models/krea2/vae/qwen_image_vae.safetensors`,
        fileExists: () => true,
      }),
    ).toThrow("wan_2.1_vae");
  });
});
