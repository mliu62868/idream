"""Enable the tested, model-scoped LTX 2.5 VAE kernels on Apple Silicon."""

import torch
from .acceleration import install

if torch.backends.mps.is_available():
    from comfy.ldm.lightricks.vae.causal_video_autoencoder import VideoVAE

    install(VideoVAE)

NODE_CLASS_MAPPINGS = {}
