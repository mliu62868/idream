"""Opt-in, model-scoped MPSGraph attention for iDream experiments."""

from __future__ import annotations

from functools import partial
import math


def _native_tensor(tensor):
    # mps-sdpa 0.2.0 wraps the entire MTLBuffer without its storage_offset.
    # contiguous() alone retains the offset for an already contiguous slice.
    tensor = tensor.contiguous()
    return tensor.clone() if tensor.storage_offset() else tensor


def mpsgraph_attention(
    original,
    q,
    k,
    v,
    heads,
    mask=None,
    attn_precision=None,
    skip_reshape=False,
    skip_output_reshape=False,
    compute_precision="comfy",
    **kwargs,
):
    original_args = (q, k, v, heads, mask, attn_precision)

    def fallback():
        return original(*original_args, skip_reshape=skip_reshape,
                        skip_output_reshape=skip_output_reshape, **kwargs)

    # This node is deliberately MPS-only. Other devices retain the model's
    # original backend; installing it never patches unrelated models or TE.
    if q.device.type != "mps" or kwargs.get("enable_gqa", False):
        return fallback()
    if kwargs.get("scale") is not None and not math.isfinite(kwargs["scale"]):
        # The native wrapper's abs(scale-default) comparison treats NaN as
        # the default scale. Leave nonfinite arithmetic to the original path.
        return fallback()
    import torch

    if compute_precision not in {"comfy", "bf16"}:
        raise ValueError(f"Unknown MPSGraph compute precision: {compute_precision}")
    if any(t.device != q.device or t.dtype != q.dtype for t in (k, v)):
        return fallback()
    output_dtype = q.dtype
    # Default to Comfy's per-call/platform precision contract. The separately
    # validated BF16 mode explicitly opts BF16 inputs out of macOS's FP32 QK
    # upcast; FP16/FP32 callers retain Comfy's requested precision.
    if compute_precision != "bf16" or q.dtype != torch.bfloat16:
        from comfy.ldm.modules.attention import get_attn_precision
        if get_attn_precision(attn_precision, q.dtype) == torch.float32:
            q, k, v = (t.float() for t in (q, k, v))
    batch = q.shape[0]
    if not skip_reshape:
        dim = q.shape[-1] // heads
        q, k, v = (
            t.reshape(batch, -1, heads, dim).transpose(1, 2)
            for t in (q, k, v)
        )
    if k.shape != v.shape or q.shape[:2] != k.shape[:2] or q.shape[-1] != k.shape[-1]:
        return fallback()
    if mask is not None:
        # split interprets bool masks additively whereas SDPA treats True as
        # visible. Preserve the caller's original behavior for that contract.
        if mask.dtype == torch.bool:
            return fallback()
        if mask.ndim == 2:
            mask = mask.unsqueeze(0)
        if mask.ndim == 3:
            mask = mask.unsqueeze(1)
        if (mask.ndim != 4 or mask.device != q.device
                or mask.shape[0] not in (1, batch) or mask.shape[1] not in (1, heads)
                or mask.shape[-2:] != (q.shape[-2], k.shape[-2])):
            return fallback()
        mask = _native_tensor(mask)
    from mps_sdpa import sdpa_opt
    from mps_sdpa.backends import _calibrate

    fused_min = _calibrate.get_thresholds()["fused_min_bytes"].get(_calibrate.dtype_key(q.dtype))
    # Preserve Comfy's original math for short audio/text shapes, rather than
    # allowing mps-sdpa's implicit PyObjC/stock fallback to change it as well.
    if fused_min is None or q.shape[-2] * k.shape[-2] * q.element_size() < max(fused_min // 4, 64 * 1024):
        return fallback()
    q, k, v = (_native_tensor(t) for t in (q, k, v))
    result = sdpa_opt(q, k, v, attn_mask=mask, scale=kwargs.get("scale"), backend="mpsgraph_zc")
    result = result.to(output_dtype)
    if not skip_output_reshape:
        result = result.transpose(1, 2).reshape(batch, -1, heads * v.shape[-1])
    return result


class IDreamMPSGraphAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "compute_precision": (["comfy", "bf16"],)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "iDream/experimental"
    DESCRIPTION = "Model-scoped MPSGraph attention. comfy preserves Comfy's upcast setting; bf16 explicitly changes BF16 accumulation. Requires mps-sdpa 0.2.0."

    def patch(self, model, compute_precision="comfy"):
        import os
        from importlib.metadata import version

        if compute_precision not in {"comfy", "bf16"}:
            raise ValueError(f"Unknown MPSGraph compute precision: {compute_precision}")

        # mps-sdpa 0.2.0 calibrates the copying PyObjC backend, not zero-copy.
        # A null result disables zero-copy too. Require the screened defaults
        # in an isolated runner rather than silently routing every call to stock.
        if os.environ.get("MPS_SDPA_SKIP_CALIBRATION") != "1":
            raise RuntimeError("Start the experimental runner with MPS_SDPA_SKIP_CALIBRATION=1")
        if version("mps-sdpa") != "0.2.0":
            raise RuntimeError("This node requires the validated mps-sdpa 0.2.0 contract")
        from mps_sdpa import available_backends
        from mps_sdpa.backends import _calibrate
        thresholds = _calibrate.get_thresholds()
        if thresholds.get("calibrated") or any(thresholds["fused_min_bytes"].get(dtype) is None for dtype in ("bf16", "fp32")):
            raise RuntimeError("MPSGraph thresholds were already calibrated to stock; restart the runner")
        if "mpsgraph_zc" not in available_backends():
            raise RuntimeError("MPSGraph zero-copy attention is unavailable")
        patched = model.clone()
        options = patched.model_options.setdefault("transformer_options", {})
        if options.get("optimized_attention_override") is not None:
            raise ValueError("Model already has an attention override")
        options["optimized_attention_override"] = partial(mpsgraph_attention, compute_precision=compute_precision)
        return (patched,)


NODE_CLASS_MAPPINGS = {"IDreamMPSGraphAttention": IDreamMPSGraphAttention}
NODE_DISPLAY_NAME_MAPPINGS = {"IDreamMPSGraphAttention": "iDream MPSGraph Attention (Experimental)"}
