#!/usr/bin/env python3
"""Bounded H3-shaped attention microbenchmark; never loads or patches ComfyUI.

Inputs are synthetic, optionally using the checkpoint's learned Q/K RMSNorm
weights. They are not captured model activations. All backends see the same
quantized inputs and include conversion to ComfyUI's [B,S,H*D] output layout.
Run under the repository's generation accelerator lease (see the report).
"""

import argparse
import gc
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import resource
import statistics
import subprocess
import time
from pathlib import Path

# Must also be set by the parent process, before Python processes .pth files.
os.environ["MTLFLASHATTN_SHIM"] = "off"
os.environ["MTLFLASHATTN_SDPA"] = "off"

import torch
import torch.nn.functional as F


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=["smoke", "dit", "dit-long", "vae"], required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--backends", default="sdpa,mps-flash,mtl-auto,mtl-fp16")
    parser.add_argument("--repeat", type=int, default=5)
    parser.add_argument("--warmup", type=int, default=2)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.repeat < 3 or args.warmup < 1:
        parser.error("repeat must be >=3 and warmup must be >=1")
    return args


def norm_weights(checkpoint, block):
    from safetensors import safe_open

    with safe_open(str(checkpoint), framework="pt", device="cpu") as handle:
        q = handle.get_tensor(f"blocks.{block}.attn.q_norm.weight").float()
        k = handle.get_tensor(f"blocks.{block}.attn.k_norm.weight").float()
    return q, k


def inputs(case, checkpoint):
    # 124 frames -> 37 latent frames, each 32x32 / 2x2 patches; one
    # keyframe -> 256 tokens; stereo audio -> 2*round(124/24*40)=414.
    # Text lengths are explicit scenarios, not an observed prompt length.
    specs = {
        "smoke": (4, 1024, 128, torch.bfloat16, None),
        "dit": (56, 37 * 256 + 256 + 414 + 256, 128, torch.bfloat16, 0),
        "dit-long": (56, 37 * 256 + 256 + 414 + 1024, 128, torch.bfloat16, 25),
        # Video VAE: 7 latent time slices * 16x16 tile + 4 registers + 1 suffix.
        "vae": (32, 7 * 16 * 16 + 5, 64, torch.float16, None),
    }
    heads, seq, dim, dtype, block = specs[case]
    generator = torch.Generator(device="cpu").manual_seed(20260912)
    packed = torch.randn((1, seq, 3, heads, dim), generator=generator)
    for i in (0, 1):
        x = packed[:, :, i]
        x.mul_(torch.rsqrt(x.square().mean(-1, keepdim=True) + 1e-5))
    norms = None
    if block is not None:
        if checkpoint is None:
            raise ValueError("H3 DiT cases require --checkpoint for learned norm scales")
        qw, kw = norm_weights(checkpoint, block)
        packed[:, :, 0].mul_(qw)
        packed[:, :, 1].mul_(kw)
        norms = {
            "block": block,
            "q_min_max": [qw.min().item(), qw.max().item()],
            "k_min_max": [kw.min().item(), kw.max().item()],
            "sha256": hashlib.sha256(qw.numpy().tobytes() + kw.numpy().tobytes()).hexdigest(),
        }
    # Quantize once on CPU. Preserve the interleaved projection strides for
    # Q/K; V is cloned as in H3's Attention.forward.
    packed = packed.to(dtype)
    cpu = [packed[:, :, i].transpose(1, 2) for i in range(3)]
    packed_mps = packed.to("mps")
    q = packed_mps[:, :, 0].transpose(1, 2)
    k = packed_mps[:, :, 1].transpose(1, 2)
    v = packed_mps[:, :, 2].clone().transpose(1, 2)
    return (q, k, v), cpu, norms


def reference(cpu):
    q, k, v = cpu
    h, n, d = q.shape[1:]
    head_ids = sorted(set([0, h // 3, 2 * h // 3, h - 1]))
    row_ids = sorted(set([round(i * (n - 1) / 31) for i in range(32)]))
    refs = []
    # CPU float64, sampled queries but ALL keys/values: independent of MPS
    # SDPA and every candidate kernel. Bounded ~3 MiB score matrix per head.
    for head in head_ids:
        qs = q[0, head, row_ids].double()
        ks = k[0, head].double()
        vs = v[0, head].double()
        refs.append(torch.softmax((qs @ ks.T) / math.sqrt(d), dim=-1) @ vs)
    return torch.stack(refs), head_ids, row_ids


def sample_output(output, heads, dim, head_ids, row_ids):
    shaped = output.view(1, -1, heads, dim).transpose(1, 2)
    return torch.stack([shaped[0, head, row_ids].cpu().double() for head in head_ids])


def error_metrics(actual, expected):
    diff = actual - expected
    rms = expected.square().mean().sqrt().item()
    rmse = diff.square().mean().sqrt().item()
    return {
        "finite": bool(torch.isfinite(actual).all()),
        "reference_rms": rms,
        "rmse": rmse,
        "relative_rmse": rmse / max(rms, 1e-30),
        "max_abs": diff.abs().max().item(),
        "cosine": F.cosine_similarity(actual.flatten(), expected.flatten(), dim=0).item(),
    }


def backend(name, qkv):
    q, k, v = qkv
    b, h, n, d = q.shape

    def flatten(out):
        return out.transpose(1, 2).reshape(b, n, h * d)

    if name == "sdpa":
        return lambda: flatten(F.scaled_dot_product_attention(q, k, v)), "torch SDPA, unchanged dtype"
    if name == "mps-flash":
        import mps_flash_attn as mfa

        if not mfa.is_available():
            raise RuntimeError(f"mps-flash-attn unavailable: {mfa._IMPORT_ERROR}")
        return lambda: flatten(mfa.flash_attention(q, k, v)), "mps_flash_attn native extension"
    if name in ("mtl-auto", "mtl-fp16", "mtl-v1-fp16"):
        import metal_flash_attn as mtl
        from metal_flash_attn._kernel import _select_tier

        cast = name != "mtl-auto" and q.dtype != torch.float16
        probe = tuple(t.to(torch.float16) for t in qkv) if cast else qkv
        route = "v1 (forced)" if name == "mtl-v1-fp16" else _select_tier(*probe)
        del probe

        def run():
            values = tuple(t.to(torch.float16) for t in qkv) if cast else qkv
            previous = os.environ.get("MTLFLASHATTN_KERNEL")
            os.environ["MTLFLASHATTN_KERNEL"] = "v1" if name == "mtl-v1-fp16" else "auto"
            try:
                out = mtl.flash_attn_func(*(t.transpose(1, 2) for t in values), causal=False)
            finally:
                if previous is None:
                    os.environ.pop("MTLFLASHATTN_KERNEL", None)
                else:
                    os.environ["MTLFLASHATTN_KERNEL"] = previous
            return out.reshape(b, n, h * d).to(q.dtype)

        return run, f"mtl {route}; fp16 conversion={cast}"
    raise ValueError(f"Unknown backend {name}")


def memory():
    return {
        "mps_current_bytes": torch.mps.current_allocated_memory(),
        "mps_driver_bytes": torch.mps.driver_allocated_memory(),
        "process_rss_high_water_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    }


def main():
    args = parse_args()
    torch.set_num_threads(4)
    if not torch.backends.mps.is_available():
        raise RuntimeError("MPS is required")
    # Bound this experiment's allocator while production models remain resident.
    torch.mps.set_per_process_memory_fraction(0.25)
    qkv, cpu, norms = inputs(args.case, args.checkpoint)
    ref, head_ids, row_ids = reference(cpu)
    del cpu
    torch.mps.synchronize()
    baseline_quantization = error_metrics(ref.to(qkv[0].dtype).double(), ref)
    # Screening tolerance anchored to the unavoidable output quantization.
    # This is an operator gate, not a perceptual/video equivalence assertion.
    rel_limit = max(0.005, 4 * baseline_quantization["relative_rmse"])
    abs_limit = max(0.002, 4 * baseline_quantization["max_abs"])
    result = {
        "case": args.case,
        "input_kind": "synthetic normalized Gaussian, H3-shaped; not captured activations",
        "shape_bhnd": list(qkv[0].shape),
        "strides": [list(x.stride()) for x in qkv],
        "dtype": str(qkv[0].dtype),
        "learned_norms": norms,
        "checkpoint": str(args.checkpoint) if args.checkpoint else None,
        "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "torch": torch.__version__,
        "python": platform.python_version(),
        "macos": platform.mac_ver()[0],
        "chip": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip(),
        "packages": {p: importlib.metadata.version(p) for p in ["mps-flash-attn", "mtlflashattn"]},
        "reference": {"device": "cpu", "dtype": "float64", "heads": head_ids, "query_rows": row_ids, "all_keys": True},
        "quantization_floor": baseline_quantization,
        "screening_limits": {"relative_rmse": rel_limit, "max_abs": abs_limit},
        "memory_scope": "after synchronized calls; retained allocation observations, NOT transient peak per backend",
        "initial_memory": memory(),
        "mps_allocator_fraction": 0.25,
        "backends": {},
    }

    def save():
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")

    save()
    active = {}
    for name in args.backends.split(","):
        info = {"times_ms": []}
        result["backends"][name] = info
        try:
            fn, route = backend(name, qkv)
            info["route"] = route
            start = time.perf_counter()
            out = fn()
            torch.mps.synchronize()
            info["first_call_ms"] = (time.perf_counter() - start) * 1000
            info["memory_after_first"] = memory()
            info["all_output_finite"] = bool(torch.isfinite(out).all().item())
            actual = sample_output(out, qkv[0].shape[1], qkv[0].shape[-1], head_ids, row_ids)
            info["error"] = error_metrics(actual, ref)
            info["operator_screen_pass"] = (
                info["all_output_finite"]
                and info["error"]["finite"]
                and info["error"]["relative_rmse"] <= rel_limit
                and info["error"]["max_abs"] <= abs_limit
            )
            del out, actual
            # Failures stay in the result; incorrect kernels are not timed as winners.
            if info["operator_screen_pass"]:
                for _ in range(args.warmup):
                    out = fn()
                    torch.mps.synchronize()
                    del out
                active[name] = fn
        except Exception as exc:
            info["exception"] = f"{type(exc).__name__}: {exc}"
            info["operator_screen_pass"] = False
        print(json.dumps({"phase": "validation", "backend": name, **info}), flush=True)
        gc.collect()
        torch.mps.empty_cache()
        save()

    # Rotate order across rounds to reduce clock/thermal order bias. All calls
    # are explicitly synchronized; conversion/layout overhead stays in timing.
    names = list(active)
    for fn in active.values():
        out = fn()
        torch.mps.synchronize()
        del out
    for round_id in range(args.repeat):
        order = names[round_id % len(names):] + names[:round_id % len(names)] if names else []
        for name in order:
            torch.mps.synchronize()
            start = time.perf_counter()
            out = active[name]()
            torch.mps.synchronize()
            elapsed = (time.perf_counter() - start) * 1000
            info = result["backends"][name]
            info["times_ms"].append(elapsed)
            info["last_memory"] = memory()
            del out
            print(json.dumps({"phase": "timing", "round": round_id, "backend": name, "ms": elapsed}), flush=True)
        save()
    for info in result["backends"].values():
        if info["times_ms"]:
            info["median_ms"] = statistics.median(info["times_ms"])
            info["min_max_ms"] = [min(info["times_ms"]), max(info["times_ms"])]
    base = result["backends"].get("sdpa", {}).get("median_ms")
    if base:
        for info in result["backends"].values():
            if "median_ms" in info:
                info["speedup_vs_sdpa"] = base / info["median_ms"]
    result["final_memory"] = memory()
    save()
    if not active:
        raise SystemExit("No backend passed the operator screen; see JSON evidence")


if __name__ == "__main__":
    with torch.inference_mode():
        main()
