from pathlib import Path
import hashlib
import json
import subprocess

import numpy as np

ROOT = Path(__file__).resolve().parent
results = []
for steps in (4, 8):
    video = ROOT / f"nsfw-native-{steps}step.mp4"
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-count_frames", "-show_streams",
        "-show_format", "-of", "json", str(video),
    ]))
    visual = next(s for s in probe["streams"] if s["codec_type"] == "video")
    audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    assert (visual["width"], visual["height"]) == (512, 512)
    assert visual["r_frame_rate"] == "24/1"
    assert int(visual["nb_read_frames"]) == 22
    assert (audio["sample_rate"], audio["channels"]) == ("32000", 2)
    pixels = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(video), "-map", "0:v:0",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ])
    assert len(pixels) == 22 * 512 * 512 * 3
    frames = np.frombuffer(pixels, dtype=np.uint8).reshape(22, 512, 512, 3)
    frame_std = frames.reshape(22, -1).std(axis=1)
    assert np.all(frame_std > 5), "Blank or near-constant frames"
    pcm = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(video), "-map", "0:a:0",
        "-f", "f32le", "pipe:1",
    ])
    samples = np.frombuffer(pcm, dtype="<f4")
    assert samples.size > 0 and np.isfinite(samples).all()
    report = {
        "steps": steps,
        "path": str(video),
        "sha256": hashlib.sha256(video.read_bytes()).hexdigest(),
        "bytes": video.stat().st_size,
        "video_frames": 22,
        "video_seconds": float(visual["duration"]),
        "container_seconds": float(probe["format"]["duration"]),
        "width": 512,
        "height": 512,
        "fps": "24/1",
        "frame_std_min": float(frame_std.min()),
        "frame_std_max": float(frame_std.max()),
        "mean_absolute_frame_difference": float(np.abs(np.diff(frames.astype(np.float32), axis=0)).mean()),
        "audio_channels": 2,
        "audio_sample_rate": 32000,
        "audio_finite": True,
        "audio_rms": float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))),
        "audio_peak": float(np.abs(samples).max()),
        "scope": "Container and complete decode checks; content quality requires visual review",
    }
    (ROOT / f"nsfw-native-{steps}step.ffprobe.json").write_text(json.dumps(probe, indent=2) + "\n")
    results.append(report)
(ROOT / "video-verification.json").write_text(json.dumps(results, indent=2) + "\n")
print(json.dumps(results, indent=2))
