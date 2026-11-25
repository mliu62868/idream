"""Prepare the fixed IndexTTS 2.5 MLX bundle before starting the voice gateway."""

import argparse
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download

from scripts.indextts_voice_runtime import (
    CAMPPLUS_FILES, CAMPPLUS_REPO, CAMPPLUS_REVISION, DEFAULT_MODEL_PATH, MODEL_FILES,
    MODEL_REPO, MODEL_REVISION, W2V_DIRECTORY, W2V_FILES, W2V_REPO, W2V_REVISION,
    verify_files,
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, default=Path(os.getenv("FISH_AUDIO_MODEL_PATH", DEFAULT_MODEL_PATH)))
    target = parser.parse_args().model_path.expanduser().resolve()
    if (target / "config.json").exists():
        verify_files(target, {"config.json": MODEL_FILES["config.json"]})

    for repo, revision, directory, files in (
        (MODEL_REPO, MODEL_REVISION, target, MODEL_FILES),
        (W2V_REPO, W2V_REVISION, target / W2V_DIRECTORY, W2V_FILES),
        (CAMPPLUS_REPO, CAMPPLUS_REVISION, target, CAMPPLUS_FILES),
    ):
        missing = [name for name in files if not (directory / name).is_file()]
        if missing:
            snapshot_download(repo, revision=revision, local_dir=directory, allow_patterns=missing, max_workers=2)
        verify_files(directory, files)
    print(json.dumps({"model": MODEL_REPO, "revision": MODEL_REVISION, "model_path": str(target)}))


if __name__ == "__main__":
    main()
