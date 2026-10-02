# LTX 2.5 VAE on MPS

This ComfyUI runtime plugin recognizes the tested convolutional LTX 2.5 VAE
configuration and evaluates eligible decoder Conv3D kernels as sums of Conv2D
depth slices. It uses the existing PyTorch environment and checkpoint bytes.
The encoder, temporal caches, latent statistics, tile sizes, blending, audio,
and workflow bindings retain their existing implementations. CPU/CUDA kernels
and other VAE configurations continue through their original operation.

The adapter replaces each matching module's `_conv_forward`, after ComfyUI's
dynamic weight-loading and casting context. Each sliced kernel must be contiguous
on MPS; omitting that copy produces corrupt output on the measured runtime.
BF16 accumulation changes rounding, so this is not bitwise identical.

The existing `workflows/comfy-extra-models-idream.yaml` exposes the canonical
`comfyui_nodes` directory to ComfyUI. Restart through the documented project
PM2 wrapper to load this plugin; no additional installer or dependencies are
required. A loaded matching VAE logs its accelerated convolution count (42 for
the current checkpoint). Existing loaded instances need a restart.

Validation and raw replay evidence:
[2026-10-02 VAE experiment](../../../../docs/research/LTX25_VAE_ACCELERATION_2026-10-02.md).
