"""Model-scoped Qwen Image 2.1 corrections for the native ComfyUI runner."""

from __future__ import annotations

import logging
import time
from types import MethodType

import torch
from comfy_api.latest import io
from comfy_extras.nodes_qwen import TextEncodeQwenImage21
from .turbo import IDreamQwen21TurboLora, IDreamQwen21TurboSigmas

logger = logging.getLogger(__name__)


def safe_avg_down_forward(self, x):
    """Preserve AvgDown3D's CPU semantics without MPS's broken 5-D F.pad."""
    # SPEC: prepend temporal zeros, then fold temporal/spatial cells into
    # channels and average each channel group. Large MPS constant padding can
    # silently zero/corrupt the input (ComfyUI #16433, PyTorch #195368).
    pad_t = (-x.shape[2]) % self.factor_t
    if pad_t:
        zeros = x.new_zeros((x.shape[0], x.shape[1], pad_t, *x.shape[3:]))
        x = torch.cat((zeros, x), dim=2)
    batch, channels, frames, height, width = x.shape
    x = x.reshape(
        batch, channels, frames // self.factor_t, self.factor_t,
        height // self.factor_s, self.factor_s,
        width // self.factor_s, self.factor_s,
    )
    x = x.permute(0, 1, 3, 5, 7, 2, 4, 6).contiguous()
    x = x.reshape(
        batch, self.out_channels, self.group_size,
        frames // self.factor_t, height // self.factor_s, width // self.factor_s,
    )
    return x.mean(dim=2)


def correct_qwen21_vae(vae):
    from comfy.ldm.wan.vae2_2 import AvgDown3D, WanVAE

    # INVARIANT: this node never changes Wan video VAE instances or global
    # classes, even though ComfyUI reuses Wan's implementation for Qwen 2.1.
    if (
        not isinstance(vae.first_stage_model, WanVAE)
        or vae.latent_channels != 64
        or vae.output_channels != 4
        or vae.downscale_ratio != 16
    ):
        raise ValueError("Expected the RGBA Qwen Image 2.1 VAE (64 channels, /16)")
    corrected = 0
    for module in vae.first_stage_model.modules():
        if isinstance(module, AvgDown3D):
            module.forward = MethodType(safe_avg_down_forward, module)
            corrected += 1
    if corrected == 0:
        raise ValueError("Qwen Image 2.1 VAE has no recognized AvgDown3D modules")
    logger.info("iDream corrected %d Qwen 2.1 temporal-padding modules", corrected)
    return vae


class IDreamQwen21VAELoader:
    @classmethod
    def INPUT_TYPES(cls):
        from nodes import VAELoader
        return VAELoader.INPUT_TYPES()

    RETURN_TYPES = ("VAE",)
    FUNCTION = "load_vae"
    CATEGORY = "iDream/Qwen 2.1"
    DESCRIPTION = "Loads Qwen 2.1 VAE with CPU-equivalent temporal padding on Apple GPUs."

    def load_vae(self, vae_name):
        from nodes import VAELoader
        (vae,) = VAELoader().load_vae(vae_name)
        return (correct_qwen21_vae(vae),)


class _PositiveOnlyClip:
    def __init__(self, clip):
        self.clip = clip
        self.positive = None

    def tokenize(self, *args, **kwargs):
        return self.clip.tokenize(*args, **kwargs)

    def encode_from_tokens_scheduled(self, tokens):
        if self.positive is None:
            self.positive = self.clip.encode_from_tokens_scheduled(tokens)
        return self.positive


class IDreamQwen21TextEncode(TextEncodeQwenImage21):
    @classmethod
    def define_schema(cls):
        schema = super().define_schema()
        schema.node_id = "IDreamQwen21TextEncode"
        schema.display_name = "iDream Text Encode Qwen Image 2.1"
        schema.inputs.append(io.Float.Input("cfg", default=1.0, min=1.0, max=20.0))
        return schema

    @classmethod
    def execute(cls, clip, prompt, negative_prompt, vae=None, resolution=1024, images=None, cfg=1.0):
        # SPEC: CFG=1 and BasicGuider never evaluate the unconditional branch.
        # Reuse the positive value for that unused output so the stock node's
        # geometry, RGBA, vision-slot and reference-latent contracts stay intact.
        # Keep the real negative pass for every profile that uses CFG > 1.
        encoder = _PositiveOnlyClip(clip) if cfg == 1.0 else clip
        started = time.perf_counter()
        result = TextEncodeQwenImage21.execute(
            encoder, prompt, negative_prompt, vae, resolution, images,
        )
        if torch.backends.mps.is_available():
            torch.mps.synchronize()
        logger.info("iDream Qwen 2.1 conditioning %.3fs (cfg=%s)", time.perf_counter()-started, cfg)
        return result


NODE_CLASS_MAPPINGS = {
    "IDreamQwen21VAELoader": IDreamQwen21VAELoader,
    "IDreamQwen21TextEncode": IDreamQwen21TextEncode,
    "IDreamQwen21TurboLora": IDreamQwen21TurboLora,
    "IDreamQwen21TurboSigmas": IDreamQwen21TurboSigmas,
}
NODE_DISPLAY_NAME_MAPPINGS = {"IDreamQwen21VAELoader": "iDream Qwen 2.1 VAE Loader"}
