# Optional MPSGraph attention experiment

`IDreamMPSGraphAttention` clones one Comfy MODEL and sets its attention override.
Connect the returned MODEL to both sampling guiders. It does not change the
canonical RedGraft workflow or patch text encoders globally.

Install `requirements.txt` into an isolated Comfy environment with MPS available.
Start that runner with `MPS_SDPA_SKIP_CALIBRATION=1`. In mps-sdpa 0.2.0 the
automatic calibration benchmarks the copying PyObjC backend; a null threshold
also disables zero-copy. The node requires the explicitly screened default
thresholds and refuses that silent all-stock route. Set the environment before
starting the runner, not after another call has cached its calibration.
The node requires the native `mpsgraph_zc` backend; it refuses an existing model
attention override. Non-MPS and GQA calls retain the original attention backend.
The dependency may fall back for unsupported or small shapes, so inspect actual
call statistics rather than assuming every operation uses MPSGraph.

The BF16 path changes floating point accumulation and is not pixel identical.
Before enabling it in a default workflow, verify captured Q/K/V numerics, full
video and audio, multiple seeds, and failure recovery. See the
[local experiment record](../../../../docs/research/LTX25_MAC_ACCELERATION_EXPERIMENTS_2026-09-30.md).

The synthetic screen is `scripts/benchmark-ltx25-mps-attention.py`. Run it under
the same accelerator lease as Gen workers, with `--output` pointing to an existing
directory. For the 13,824-token probe, `--split-memory-gib 4` bounds split attention
to the isolated process budget. Synthetic timing is not an end-to-end speedup.
