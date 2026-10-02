"""Model-local Conv3D decomposition for the convolutional LTX 2.5 VAE."""

from __future__ import annotations

import functools
import logging
from types import MethodType

import torch
import torch.nn.functional as functional

logger = logging.getLogger(__name__)
WINDOW_ELEMENTS = 64 << 20

# INTENT: recognize the tested convolutional 2.5 decoder. Other VideoVAE
# architectures, including timestep-conditioned 2.3, retain their own kernels.
DECODER_BLOCKS = [
    ["res_x", {"num_layers": 4}],
    ["compress_space", {"multiplier": 2}],
    ["res_x", {"num_layers": 6}],
    ["compress_time", {"multiplier": 2}],
    ["res_x", {"num_layers": 4}],
    ["compress_all", {"multiplier": 1}],
    ["res_x", {"num_layers": 2}],
    ["compress_all", {"multiplier": 2}],
    ["res_x", {"num_layers": 2}],
]
CONFIG = {
    "dims": 3,
    "in_channels": 3,
    "out_channels": 3,
    "latent_channels": 128,
    "norm_layer": "pixel_norm",
    "patch_size": 4,
    "causal_decoder": False,
    "timestep_conditioning": False,
    "decoder_base_channels": 128,
    "spatial_padding_mode": "zeros",
    "decoder_blocks": DECODER_BLOCKS,
}


def supports(module):
    return (
        isinstance(module, torch.nn.Conv3d)
        and module.kernel_size[0] <= 7
        and module.stride[0] == 1
        and module.padding[0] == 0
        and module.padding_mode == "zeros"
        and module.dilation == (1, 1, 1)
        and module.groups == 1
    )


def conv3d_via_conv2d(module, x, weight, bias, *, window_elements=WINDOW_ELEMENTS):
    """Sum depth slices of the supplied effective weight, with bounded batches."""
    batch, channels, depth, height, width = x.shape
    out_channels, _, kernel_depth, kernel_height, kernel_width = weight.shape
    output_depth = depth - kernel_depth + 1
    if output_depth < 1 or window_elements < 1:
        raise ValueError("Conv3D requires a non-empty output and positive window budget")
    output_height = (height + 2 * module.padding[1] - kernel_height) // module.stride[1] + 1
    output_width = (width + 2 * module.padding[2] - kernel_width) // module.stride[2] + 1
    elements_per_frame = batch * max(
        height * width * channels, output_height * output_width * out_channels
    )
    window = max(1, window_elements // elements_per_frame)
    outputs = []
    for start in range(0, output_depth, window):
        count = min(window, output_depth - start)
        accumulated = None
        for offset in range(kernel_depth):
            values = x[:, :, start + offset : start + offset + count]
            values = values.permute(0, 2, 1, 3, 4).reshape(batch * count, channels, height, width)
            # INVARIANT: MPS Conv2D corrupts a strided depth slice of a 5-D
            # weight on this runtime. Materialize that 4-D kernel explicitly.
            kernel = weight[:, :, offset].contiguous()
            contribution = functional.conv2d(
                values, kernel, None, module.stride[1:], module.padding[1:],
                module.dilation[1:], module.groups,
            )
            accumulated = contribution if accumulated is None else accumulated + contribution
        if bias is not None:
            accumulated = accumulated + bias.reshape(1, -1, 1, 1)
        output = accumulated.reshape(batch, count, out_channels, output_height, output_width)
        outputs.append(output.permute(0, 2, 1, 3, 4))
    return outputs[0] if len(outputs) == 1 else torch.cat(outputs, dim=2)


def _conv_forward(self, x, weight, bias, *args, **kwargs):
    if (
        x.device.type != "mps"
        or x.dtype not in (torch.float32, torch.bfloat16)
        or args
        or any(key != "autopad" for key in kwargs)
        or kwargs.get("autopad") is not None
    ):
        return self._idream_original_conv_forward(x, weight, bias, *args, **kwargs)
    return conv3d_via_conv2d(self, x, weight, bias)


def accelerate_vae(model):
    if not all(model.config.get(key) == value for key, value in CONFIG.items()):
        return 0
    changed = 0
    for module in model.decoder.modules():
        if supports(module) and not hasattr(module, "_idream_original_conv_forward"):
            # SPEC: preserve Comfy's forward/CastBiasWeightContext, including
            # dynamic loading and weight functions; replace only the arithmetic.
            module._idream_original_conv_forward = module._conv_forward
            module._conv_forward = MethodType(_conv_forward, module)
            changed += 1
    if changed:
        model._idream_mps_vae_convolutions = changed
        logger.info("iDream LTX 2.5 VAE: %d scoped MPS Conv2D depth kernels", changed)
    return changed


def install(video_vae_class):
    if getattr(video_vae_class, "_idream_mps_vae_installed", False):
        return
    original_init = video_vae_class.__init__

    @functools.wraps(original_init)
    def initialize(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        accelerate_vae(self)

    # INTENT: existing pinned graphs use VAELoader/VAEDecodeTiled. Recognize
    # each newly constructed model rather than replacing those shared nodes.
    video_vae_class.__init__ = initialize
    video_vae_class._idream_mps_vae_installed = True
