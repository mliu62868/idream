const samplerAliases = new Map<string, string>([
  ["dpmpp2sa", "dpm++2s_a"],
  ["dpm2sa", "dpm++2s_a"],
  ["dpmpp2m", "dpm++2m"],
  ["dpm2m", "dpm++2m"],
  ["dpmpp2mv2", "dpm++2mv2"],
  ["dpm2mv2", "dpm++2mv2"],
  ["dpmpp2msde", "dpm++2m"],
  ["dpmpp3msde", "dpm++2m"],
  ["dpmppsde", "er_sde"],
  ["ddim", "ddim_trailing"],
  ["lms", "euler"],
]);

const supportedSamplers = new Set([
  "euler",
  "euler_a",
  "heun",
  "dpm2",
  "dpm++2s_a",
  "dpm++2m",
  "dpm++2mv2",
  "ipndm",
  "ipndm_v",
  "lcm",
  "ddim_trailing",
  "tcd",
  "res_multistep",
  "res_2s",
  "er_sde",
  "euler_cfg_pp",
  "euler_a_cfg_pp",
]);

export function normalizeSdcppSampler(value: string) {
  const trimmed = value.trim();
  if (supportedSamplers.has(trimmed)) return trimmed;
  return samplerAliases.get(samplerKey(trimmed)) ?? trimmed;
}

export type SdcppModelFamily = "generic" | "krea2";

export function detectSdcppModelFamily(values: Array<string | null | undefined>): SdcppModelFamily {
  return values.some((value) => isKrea2Text(value)) ? "krea2" : "generic";
}

export function krea2TextEncoderCandidates(homeDir: string) {
  return [
    `${homeDir}/.localai/models/krea2/text_encoders/Qwen3VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/.localai/models/krea2/text_encoders/Qwen3-VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/.localai/models/Krea-2/text_encoders/Qwen3VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/.localai/models/Krea-2/text_encoders/Qwen3-VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/Downloads/models/Qwen3VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/Downloads/models/Qwen3-VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/Downloads/Qwen3VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/Downloads/Qwen3-VL-4B-Instruct-Q4_K_M.gguf`,
    `${homeDir}/.localai/models/krea2/text_encoders/qwen3vl_4b_fp8_scaled.safetensors`,
    `${homeDir}/.localai/models/krea2/text_encoders/qwen3vl_4b_bf16.safetensors`,
    `${homeDir}/.localai/models/Krea-2/text_encoders/qwen3vl_4b_fp8_scaled.safetensors`,
    `${homeDir}/.localai/models/Krea-2/text_encoders/qwen3vl_4b_bf16.safetensors`,
    `${homeDir}/Downloads/models/qwen3vl_4b_fp8_scaled.safetensors`,
    `${homeDir}/Downloads/models/qwen3vl_4b_bf16.safetensors`,
    `${homeDir}/Downloads/qwen3vl_4b_fp8_scaled.safetensors`,
    `${homeDir}/Downloads/qwen3vl_4b_bf16.safetensors`,
  ];
}

export function krea2VaeCandidates(homeDir: string) {
  return [
    `${homeDir}/.localai/models/krea2/vae/wan_2.1_vae.safetensors`,
    `${homeDir}/.localai/models/Krea-2/vae/wan_2.1_vae.safetensors`,
    `${homeDir}/Downloads/models/wan_2.1_vae.safetensors`,
    `${homeDir}/Downloads/wan_2.1_vae.safetensors`,
  ];
}

export function isKnownKrea2IncompatibleTextEncoder(value: string) {
  const lowered = value.toLowerCase();
  return lowered.includes("qwen3-4b-instruct") || lowered.includes("z-image");
}

export function isKnownKrea2IncompatibleVae(value: string) {
  const lowered = value.toLowerCase();
  return (
    lowered.endsWith("/ae.safetensors") ||
    lowered.includes("flux.1-ae") ||
    lowered.includes("qwen_image_vae") ||
    lowered.includes("z-image")
  );
}

export function validateSdcppRuntimeComponents(input: {
  family: SdcppModelFamily;
  llmPath: string;
  vaePath: string;
  fileExists?: (path: string) => boolean;
}) {
  if (input.family !== "krea2") return;
  if (isKnownKrea2IncompatibleTextEncoder(input.llmPath)) {
    throw new Error(
      `Krea2 requires the Qwen3-VL 4B text encoder, not ${input.llmPath}. ` +
        "Set llmPath to Qwen3-VL-4B-Instruct-Q4_K_M.gguf or qwen3vl_4b_fp8_scaled.safetensors.",
    );
  }
  if (isKnownKrea2IncompatibleVae(input.vaePath)) {
    throw new Error(
      `Krea2 requires wan_2.1_vae.safetensors, not ${input.vaePath}.`,
    );
  }
  const fileExists = input.fileExists ?? (() => true);
  if (!fileExists(input.llmPath)) {
    throw new Error(`Krea2 text encoder not found for sdcpp: ${input.llmPath}`);
  }
  if (!fileExists(input.vaePath)) {
    throw new Error(`Krea2 VAE not found for sdcpp: ${input.vaePath}`);
  }
}

function samplerKey(value: string) {
  return value
    .toLowerCase()
    .replace(/\+/g, "p")
    .replace(/[^a-z0-9]+/g, "");
}

function isKrea2Text(value: string | null | undefined) {
  if (!value) return false;
  return /krea[-_ ]?2/i.test(value);
}
