"""Viggle v0.3 unmerged adapter and six-step Euler schedule.

Adapted from Viggle/Qwen-Image-2.1-viggle-turbo, revision
009a44a895ef85f7e643c80fdca9543795248867/comfyui/viggle_turbo.py.
Keep the adapter's Qwen Research license with the installed weights.
"""

import json
import math

import torch
import torch.nn.functional as F


class IDreamQwen21TurboSigmas:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"latent": ("LATENT",), "steps": ("INT", {"default": 6, "min": 6, "max": 6})}}

    RETURN_TYPES = ("SIGMAS",)
    FUNCTION = "get_sigmas"
    CATEGORY = "iDream/Qwen 2.1"

    def get_sigmas(self, latent, steps=6):
        if steps != 6:
            raise ValueError("The qualified Viggle v0.3 recipe requires six steps")
        samples = latent["samples"]
        ratio = latent.get("downscale_ratio_spacial", 16) / 16
        tokens = round(samples.shape[-2] * ratio) * round(samples.shape[-1] * ratio)
        mu = 0.5 + 0.4 * (tokens - 256) / (8192 - 256)
        raw = torch.tensor([1, .9375, .875, .75, .5, .25], dtype=torch.float64)
        shifted = math.exp(mu) / (math.exp(mu) + (1 / raw - 1))
        # SPEC: the distilled grid has no terminal stretch; append exact zero.
        return (torch.cat((shifted, shifted.new_zeros(1))).float(),)


def lora_forward(x, weights):
    return F.linear(F.linear(x, weights[0].to(x.dtype)), weights[1].to(x.dtype))


def add_mlp_hooks(mlp, gate, up, down, hooks):
    gate_up = {}

    def gate_hook(_module, inputs, output):
        gate_up["value"] = output + torch.cat((lora_forward(inputs[0], gate), lora_forward(inputs[0], up)), dim=-1)
        return gate_up["value"]

    def output_hook(_module, _inputs, output):
        gate_value, up_value = gate_up.pop("value").chunk(2, dim=-1)
        return output + lora_forward(F.silu(gate_value) * up_value, down)

    # Comfy's fused linear_input_act bypasses the down projection's hooks;
    # attach that residual to the MLP, using the already adapted gate/up.
    hooks.append(mlp.gate_up.register_forward_hook(gate_hook))
    hooks.append(mlp.register_forward_hook(output_hook))


def run_with_lora(lora, executor, *args, **kwargs):
    diffusion = executor.class_obj
    device = args[0].device
    for weights in lora.values():
        if weights[0].device != device:
            weights[0], weights[1] = weights[0].to(device), weights[1].to(device)
    hooks = []
    try:
        for name, weights in lora.items():
            parent, _, leaf = name.rpartition(".")
            module = diffusion.get_submodule(parent)
            if not getattr(module, "fused", False):
                hooks.append(diffusion.get_submodule(name).register_forward_hook(
                    lambda _module, inputs, output, weights=weights: output + lora_forward(inputs[0], weights)
                ))
            elif leaf == "out":
                add_mlp_hooks(module, lora[parent + ".gate_layer"], lora[parent + ".proj"], weights, hooks)
        return executor(*args, **kwargs)
    finally:
        # INVARIANT: cleanup also covers registration errors and interrupts;
        # the shared diffusion module must never leak a LoRA into another graph.
        for hook in hooks:
            hook.remove()


class IDreamQwen21TurboLora:
    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths
        return {"required": {"model": ("MODEL",), "lora_name": (folder_paths.get_filename_list("loras"),)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "load"
    CATEGORY = "iDream/Qwen 2.1"
    DESCRIPTION = "Applies Viggle v0.3 at scale 1 as an unmerged residual, preserving its BF16 update."

    def load(self, model, lora_name):
        import comfy.patcher_extension
        import comfy.utils
        import folder_paths
        from comfy.ldm.qwen_image21.model import QwenImage21Transformer2DModel
        if not isinstance(model.get_model_object("diffusion_model"), QwenImage21Transformer2DModel):
            raise ValueError("The Viggle adapter requires a Qwen Image 2.1 transformer")
        state, metadata = comfy.utils.load_torch_file(folder_paths.get_full_path_or_raise("loras", lora_name), return_metadata=True)
        config = json.loads((metadata or {}).get("lora_adapter_metadata", "{}"))
        if config.get("transformer.r") != 128 or config.get("transformer.lora_alpha") != 128:
            raise ValueError("Expected the qualified rank-128/alpha-128 Viggle v0.3 adapter")
        lora = {}
        for key in state:
            if not key.startswith("transformer.") or not key.endswith((".lora_A.weight", ".lora_B.weight")):
                raise ValueError(f"Unexpected adapter tensor: {key}")
            if key.endswith(".lora_A.weight"):
                paired = key.replace(".lora_A.weight", ".lora_B.weight")
                if paired not in state:
                    raise ValueError(f"Adapter is missing {paired}")
                name = key.removeprefix("transformer.").removesuffix(".lora_A.weight")
                lora[name] = [state[key], state[paired]]
        if len(lora) != 227 or len(state) != 454:
            raise ValueError("Incomplete Viggle v0.3 adapter: expected 227 paired projections")
        patched = model.clone()
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL, "idream_qwen21_turbo",
            lambda executor, *args, **kwargs: run_with_lora(lora, executor, *args, **kwargs),
        )
        return (patched,)
