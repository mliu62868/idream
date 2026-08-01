#!/usr/bin/env python3
"""Qwen v19 vs darkBeast Klein 9B — controlled identity+source edit A/B.

Drives ComfyUI /prompt directly so every variable is pinned: same identity image,
same source image, same prompt, same 832x1216, same seed sequence.
Appends one JSON line per run to results.jsonl so progress is observable mid-flight.
"""
import argparse
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

COMFY = "http://127.0.0.1:8188"
REPO = Path("/Users/kk/code/idream")
WF = REPO / "packages/gen/workflows"
COMFY_OUT = Path("/Users/kk/ComfyUI-Shared/output")

IDENTITY = "ref-0.png"           # blonde, blue eyes, yacht, full body
SOURCE = "idream-edit-src.png"   # auburn, green eyes, indoor, upper-body crop

PROMPT = (
    "Replace the woman in the second image with the woman from the first image. "
    "Keep her exact face, blonde hair color and hairstyle from the first image. "
    "Preserve the pose, camera framing, indoor lighting and background of the second image."
)
NEGATIVE = "blurry, deformed hands, extra fingers, watermark, text"

SEEDS = [42, 43, 44, 45]  # [0] = cold run, rest = warm

LANES = {
    "A": {"wf": "qwen-image-edit-multi-reference.json", "sampler": "sa_solver", "scheduler": "beta"},
    "B": {"wf": "qwen-image-edit-multi-reference.json", "sampler": "euler_ancestral", "scheduler": "beta"},
    "C": {"wf": "darkbeast-flux2-klein-9b-multi-reference.json"},
    # D probes whether Klein's slots are simply inverted: feed identity into the
    # node the descriptor calls source_image, and vice versa.
    "D": {"wf": "darkbeast-flux2-klein-9b-multi-reference.json", "swap": True},
}


# The shell exports NO_PROXY as a URL rather than a host list, so urllib routes
# loopback traffic through the 7897 proxy and gets a 502. Pin an empty proxy map.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, payload):
    req = urllib.request.Request(
        f"{COMFY}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(req, timeout=60) as r:
        return json.loads(r.read())


def get(path):
    with OPENER.open(f"{COMFY}{path}", timeout=30) as r:
        return json.loads(r.read())


def build(lane, seed, tag):
    d = json.loads((WF / LANES[lane]["wf"]).read_text())
    g = d["apiPrompt"]
    if lane in ("A", "B"):
        g["8"]["inputs"]["image"] = IDENTITY   # identity anchor
        g["12"]["inputs"]["image"] = SOURCE    # source image
        g["3"]["inputs"]["prompt"] = PROMPT
        g["4"]["inputs"]["prompt"] = NEGATIVE
        g["2"]["inputs"]["seed"] = seed
        g["2"]["inputs"]["sampler_name"] = LANES[lane]["sampler"]
        g["2"]["inputs"]["scheduler"] = LANES[lane]["scheduler"]
        save = "11"
    else:
        swap = LANES[lane].get("swap", False)
        g["6"]["inputs"]["image"] = SOURCE if swap else IDENTITY
        g["10"]["inputs"]["image"] = IDENTITY if swap else SOURCE
        g["4"]["inputs"]["text"] = PROMPT
        g["16"]["inputs"]["noise_seed"] = seed
        save = "21"
    g[save]["inputs"]["filename_prefix"] = f"ab_{tag}"
    return g, save


def ckpt_of(lane):
    return "qwen-v19" if lane in ("A", "B") else "klein-9b"


def run(lane, seed, idx, outdir, thermal):
    tag = f"{lane}_{idx}_seed{seed}"
    g, save = build(lane, seed, tag)
    t0 = time.time()
    pid = post("/prompt", {"prompt": g, "client_id": f"ab-{tag}"})["prompt_id"]
    hist = None
    while True:
        time.sleep(3)
        h = get(f"/history/{pid}")
        if pid in h and h[pid].get("status", {}).get("completed") is not None:
            hist = h[pid]
            break
        if time.time() - t0 > 1800:
            return {"lane": lane, "seed": seed, "error": "timeout 1800s"}
    wall = time.time() - t0

    st = hist.get("status", {})
    msgs = {m[0]: m[1] for m in st.get("messages", []) if isinstance(m, list) and len(m) > 1}
    exec_wall = None
    if "execution_start" in msgs and "execution_success" in msgs:
        exec_wall = round(msgs["execution_success"]["timestamp"] / 1000 - msgs["execution_start"]["timestamp"] / 1000, 3)

    files = []
    for node_out in hist.get("outputs", {}).values():
        for img in node_out.get("images", []):
            src = COMFY_OUT / img.get("subfolder", "") / img["filename"]
            if src.exists():
                dst = outdir / f"{tag}.png"
                shutil.copy2(src, dst)
                files.append(dst.name)

    stats = get("/system_stats")
    dev = stats.get("devices", [{}])[0]
    rec = {
        "lane": lane,
        "run": idx,
        # cold means the checkpoint had to be (re)loaded, not "first run of the lane" —
        # A and B share the Qwen checkpoint, so B never pays a load cost.
        "thermal": thermal,
        "ckpt": ckpt_of(lane),
        "seed": seed,
        "wall_s": round(wall, 2),
        "exec_s": exec_wall,
        "status": st.get("status_str"),
        "files": files,
        "ram_free_gb": round(stats["system"]["ram_free"] / 1e9, 1),
        "vram_free_gb": round(dev.get("vram_free", 0) / 1e9, 1) if dev else None,
    }
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lanes", default="A:0,B:0,C:0", help="comma list of lane[:start_index]")
    ap.add_argument("--runs", type=int, default=4)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--resident", default="", help="checkpoint already loaded in ComfyUI, if any")
    a = ap.parse_args()

    outdir = Path(a.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    results = outdir / "results.jsonl"
    resident = a.resident

    for spec in a.lanes.split(","):
        lane, _, start = spec.partition(":")
        for idx in range(int(start or 0), a.runs):
            thermal = "warm" if ckpt_of(lane) == resident else "cold"
            rec = run(lane, SEEDS[idx % len(SEEDS)], idx, outdir, thermal)
            resident = ckpt_of(lane)
            with results.open("a") as f:
                f.write(json.dumps(rec) + "\n")
            print(json.dumps(rec), flush=True)


if __name__ == "__main__":
    sys.exit(main())
