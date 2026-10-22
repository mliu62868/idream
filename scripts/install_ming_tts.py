"""Install pinned Ming assets explicitly; resident gateway startup stays offline."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.request import urlopen

from huggingface_hub import snapshot_download

from scripts.ming_voice_runtime import CAMPLUS_SHA256

MODEL_REPO = "mlx-community/Ming-3.0-tts-0.5B-8bit"
MODEL_REVISION = "c807b99d2ea77d896fcffc917f0330d36470bb29"
MODEL_CHECKSUMS = {
    "model.safetensors": "e88a4b53cb5b705703e961389f3d7f0e8b72c240b4dad796bf9961cc018971fc",
    "campplus.safetensors": "a479586bd8f8f96cdb414eaa2fa07c6cd54d6d1636562e2d75a0211cb3b0a6fd",
}
CAMPLUS_URL = "https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B/resolve/8d66b70a00f05ad183fa8a863b4ce609fc83cbc0/campplus.onnx"


def checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, default=Path(os.getenv(
        "FISH_AUDIO_MODEL_PATH", "~/.idream/models/mlx-community/Ming-3.0-tts-0.5B-8bit")))
    parser.add_argument("--camplus-path", type=Path, default=Path(os.getenv(
        "FISH_AUDIO_CAMPLUS_MODEL_PATH", "~/.idream/models/ming/campplus.onnx")))
    args = parser.parse_args()
    model_path = args.model_path.expanduser().resolve()
    camplus_path = args.camplus_path.expanduser().resolve()
    config = model_path / "config.json"
    if config.exists() and json.loads(config.read_text()).get("model_type") != "dense":
        raise RuntimeError("Target directory contains a different model; refusing to replace it with Ming")
    snapshot_download(MODEL_REPO, revision=MODEL_REVISION, local_dir=model_path)
    checksums = {name: checksum(model_path / name) for name in MODEL_CHECKSUMS}
    if checksums != MODEL_CHECKSUMS:
        raise RuntimeError("Ming weights differ from the pinned checksums")
    if camplus_path.exists():
        if checksum(camplus_path) != CAMPLUS_SHA256:
            raise RuntimeError("Existing CAM++ differs from the pinned checksum; refusing to overwrite")
    else:
        camplus_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=camplus_path.parent, delete=False) as target:
                temporary = Path(target.name)
                with urlopen(CAMPLUS_URL, timeout=120) as source:
                    while chunk := source.read(1024 * 1024):
                        target.write(chunk)
            if checksum(temporary) != CAMPLUS_SHA256:
                raise RuntimeError("Downloaded CAM++ differs from the pinned checksum")
            # Do not overwrite an asset installed concurrently.
            os.link(temporary, camplus_path)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    print(json.dumps({"model": MODEL_REPO, "revision": MODEL_REVISION,
                      "model_path": str(model_path), "checksums": checksums,
                      "camplus_path": str(camplus_path), "camplus_sha256": CAMPLUS_SHA256}, indent=2))


if __name__ == "__main__":
    main()
