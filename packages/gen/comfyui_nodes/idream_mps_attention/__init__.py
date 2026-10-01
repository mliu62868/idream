"""Opt-in, model-scoped MPSGraph attention for iDream experiments."""

from __future__ import annotations


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
    **kwargs,
):
    from mps_sdpa import sdpa_opt

    # This node is deliberately MPS-only. Other devices retain the model's
    # original backend; installing it never patches unrelated models or TE.
    if q.device.type != "mps" or kwargs.get("enable_gqa", False):
        return original(
            q, k, v, heads, mask, attn_precision,
            skip_reshape=skip_reshape,
            skip_output_reshape=skip_output_reshape,
            **kwargs,
        )
    batch = q.shape[0]
    if not skip_reshape:
        dim = q.shape[-1] // heads
        q, k, v = (
            t.reshape(batch, -1, heads, dim).transpose(1, 2)
            for t in (q, k, v)
        )
    if mask is not None:
        if mask.ndim == 2:
            mask = mask.unsqueeze(0)
        if mask.ndim == 3:
            mask = mask.unsqueeze(1)
    # Keep BF16 inputs and MPSGraph's fused accumulation. The alternative FP32
    # path is screened in the benchmark, not a global Comfy precision change.
    result = sdpa_opt(q, k, v, attn_mask=mask, scale=kwargs.get("scale"), backend="mpsgraph_zc")
    if not skip_output_reshape:
        result = result.transpose(1, 2).reshape(batch, -1, heads * v.shape[-1])
    return result


class IDreamMPSGraphAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "iDream/experimental"
    DESCRIPTION = "Uses MPSGraph zero-copy attention only for this model. Requires mps-sdpa 0.2.0."

    def patch(self, model):
        import os

        from mps_sdpa import available_backends
        from mps_sdpa.backends import _calibrate

        # mps-sdpa 0.2.0 calibrates the copying PyObjC backend, not zero-copy.
        # A null result disables zero-copy too. Require the screened defaults
        # in an isolated runner rather than silently routing every call to stock.
        if os.environ.get("MPS_SDPA_SKIP_CALIBRATION") != "1":
            raise RuntimeError("Start the experimental runner with MPS_SDPA_SKIP_CALIBRATION=1")
        if _calibrate.get_thresholds()["fused_min_bytes"].get("bf16") is None:
            raise RuntimeError("MPSGraph thresholds were already calibrated to stock; restart the runner")
        if "mpsgraph_zc" not in available_backends():
            raise RuntimeError("MPSGraph zero-copy attention is unavailable")
        patched = model.clone()
        options = patched.model_options.setdefault("transformer_options", {})
        if options.get("optimized_attention_override") is not None:
            raise ValueError("Model already has an attention override")
        options["optimized_attention_override"] = mpsgraph_attention
        return (patched,)


NODE_CLASS_MAPPINGS = {"IDreamMPSGraphAttention": IDreamMPSGraphAttention}
NODE_DISPLAY_NAME_MAPPINGS = {"IDreamMPSGraphAttention": "iDream MPSGraph Attention (Experimental)"}
