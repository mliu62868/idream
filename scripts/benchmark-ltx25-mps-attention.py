"""Screen split/MPSGraph attention with an independent CPU float64 reference.

Run under the shared generation accelerator lease, using an isolated Comfy
environment with mps-sdpa 0.2.0. This measures synthetic tensors, not video speed.
"""

import argparse
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--length", type=int, default=3456)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--split-memory-gib", type=float)
parser.add_argument("--comfy-root", type=Path, default=Path("/Users/kk/ComfyUI-Installs/idream-ltx25-v0342/ComfyUI"))
args = parser.parse_args()
# Screen the native path, not the PyObjC copy backend's automatic calibration.
os.environ["MPS_SDPA_SKIP_CALIBRATION"] = "1"
sys.argv = [sys.argv[0]]
sys.path.insert(0, str(args.comfy_root.resolve()))
import torch
from comfy.ldm.modules.attention import attention_split
from comfy import model_management
from mps_sdpa import backend_status, get_fallback_stats, reset_fallback_stats, sdpa_opt
from mps_sdpa.api import get_call_stats, reset_call_stats

torch.set_num_threads(4)
torch.mps.set_per_process_memory_fraction(0.3)
if args.split_memory_gib:
    # The isolated process has a 32 GiB allocation cap; psutil's host free RAM
    # does not include it. Bound Comfy's chunk estimator to this test budget.
    model_management.get_free_memory = lambda *_args, **_kwargs: int(args.split_memory_gib * 1024**3)
heads, dim = 32, 128
rng = torch.Generator().manual_seed(20260930)
cpu = [torch.randn(1, heads, args.length, dim, generator=rng).to(torch.bfloat16) for _ in range(3)]
q, k, v = [x.to("mps") for x in cpu]
flat = [x.transpose(1, 2).reshape(1, args.length, heads * dim) for x in (q, k, v)]
head_ids, row_ids = [0, 10, 21, 31], [0, args.length // 3, 2 * args.length // 3, args.length - 1]
reference = torch.stack([
    torch.softmax(cpu[0][0, h, row_ids].double() @ cpu[1][0, h].double().T / math.sqrt(dim), -1) @ cpu[2][0, h].double()
    for h in head_ids
])
floor_diff = reference.to(torch.bfloat16).double() - reference
rel_limit = max(0.005, 4 * (floor_diff.square().mean().sqrt() / reference.square().mean().sqrt()).item())
abs_limit = max(0.002, 4 * floor_diff.abs().max().item())
rows = []
result = {"input_kind": "synthetic LTX-shaped Gaussian; not captured activations", "calibration": "MPS_SDPA_SKIP_CALIBRATION=1; screened default thresholds", "shape": list(q.shape), "split_memory_gib": args.split_memory_gib, "torch": torch.__version__, "backend_status": backend_status(), "relative_limit": rel_limit, "absolute_limit": abs_limit, "rows": rows}
print(json.dumps({"shape":result["shape"], "backend_status":result["backend_status"]},default=str), flush=True)
functions = {
    "split-fp32": lambda: attention_split(*flat, heads),
    "mpsgraph-fp32": lambda: sdpa_opt(q.float(), k.float(), v.float(), backend="mpsgraph_zc").to(torch.bfloat16).transpose(1, 2).reshape(1, args.length, heads * dim),
    "mpsgraph-bf16": lambda: sdpa_opt(q, k, v, backend="mpsgraph_zc").transpose(1, 2).reshape(1, args.length, heads * dim),
}
for name, run in functions.items():
    row = {"backend": name}
    try:
        reset_fallback_stats()
        reset_call_stats()
        torch.mps.synchronize()
        start = time.perf_counter()
        out = run()
        torch.mps.synchronize()
        row["first_seconds"] = time.perf_counter() - start
        actual = torch.stack([out.reshape(1,args.length,heads,dim)[0,row_ids,h].cpu().double() for h in head_ids])
        error = actual - reference
        row.update(finite=bool(torch.isfinite(out).all()), relative_rmse=(error.square().mean().sqrt()/reference.square().mean().sqrt()).item(), max_abs=error.abs().max().item())
        row["passed"] = row["finite"] and row["relative_rmse"] <= rel_limit and row["max_abs"] <= abs_limit
        if name.startswith("mpsgraph") and not get_call_stats().get("mpsgraph_zc"):
            row.update(passed=False, error="Requested native MPSGraph but it fell back")
        row["fallback_stats"] = get_fallback_stats()
        del out
        timings = []
        if row["passed"]:
            for _ in range(3):
                torch.mps.synchronize()
                start = time.perf_counter()
                out = run()
                torch.mps.synchronize()
                timings.append(time.perf_counter() - start)
                del out
            row["seconds"] = timings
            row["median_seconds"] = statistics.median(timings)
        row["call_stats"] = get_call_stats()
    except Exception as error:
        row.update(passed=False, error=str(error))
    rows.append(row)
    args.output.write_text(json.dumps(result,indent=2,default=str)+"\n")
    print(json.dumps(row,default=str), flush=True)
    torch.mps.empty_cache()
if not all(row["passed"] for row in rows):
    sys.exit(1)
