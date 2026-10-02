# Model-scoped MPSGraph attention

`IDreamMPSGraphAttention` clones one Comfy MODEL and sets its attention override.
RedGraft workflow v4 connects the returned MODEL to both sampling guiders with
explicit `compute_precision=bf16`. Text encoders retain their own backend.

Install `requirements.txt` into an isolated video environment with MPS available;
it pins the matched Torch 2.11 / torchvision 0.26 / torchaudio 2.11 family and
native bridge dependencies. Keep the Comfy source revision fixed separately.
Start that runner with `MPS_SDPA_SKIP_CALIBRATION=1`. In mps-sdpa 0.2.0 the
automatic calibration benchmarks the copying PyObjC backend; a null threshold
also disables zero-copy. The node requires the explicitly screened default
thresholds and refuses that silent all-stock route. Set the environment before
starting the runner, not after another call has cached its calibration.
The node requires the native `mpsgraph_zc` backend; it refuses an existing model
attention override. Non-MPS and GQA calls retain the original attention backend.
The dependency may fall back for unsupported or small shapes, so inspect actual
call statistics rather than assuming every operation uses MPSGraph.

The required `compute_precision` input defaults to `comfy`, which honors Comfy's
per-call/platform FP32 upcast and returns the input dtype. Selecting `bf16`
explicitly opts BF16 inputs into fused accumulation; FP16/FP32 callers still
honor Comfy's precision setting. This BF16 path is not pixel identical.
Short sequences, GQA, boolean masks and unsupported broadcast masks retain the
original model backend. mps-sdpa's OOM recovery can still fall back internally;
its native call counter counts attempts, so inspect fallback counters too.
Contiguous slices are copied only when they have a nonzero storage offset:
mps-sdpa 0.2.0 otherwise reads the underlying Metal buffer from its origin.
Runtime or precision changes require captured Q/K/V numerics, full video and
audio, multiple seeds, and failure recovery. See the
[current qualification record](../../../../docs/research/LTX25_MPSGRAPH_IMPLEMENTATION_2026-10-02.md)
and [historical experiments](../../../../docs/research/LTX25_MAC_ACCELERATION_EXPERIMENTS_2026-09-30.md).

The synthetic screen is `scripts/benchmark-ltx25-mps-attention.py`. Run it under
the same accelerator lease as Gen workers, with `--output` pointing to an existing
directory. For the 13,824-token probe, `--split-memory-gib 4` bounds split attention
to the isolated process budget. Synthetic timing is not an end-to-end speedup.

`test_attention.py` runs CPU contracts by default. Set `IDREAM_TEST_MPS_GRAPH=1`
under the accelerator lease to run native regressions against CPU float64,
including tensor/mask offsets, noncontiguous heads, scale and precision.
Use a separate `TORCH_EXTENSIONS_DIR` for each Torch environment so extension
builds cannot reuse another environment's binary or block on its compile lock.
