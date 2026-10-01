const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");

function runner(profile, port, killTimeout) {
  return {
    name: `comfyui-${profile}`,
    cwd: repoRoot,
    script: path.join(__dirname, "start-comfyui-idream.cjs"),
    interpreter: process.execPath,
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    restart_delay: 5_000,
    kill_timeout: killTimeout,
    env: {
      COMFYUI_PROFILE: profile,
      COMFYUI_PORT: port,
      // INVARIANT: PM2 merges saved env on restart. The image code and Python
      // must come from the same Qwen21 install, even after a legacy override.
      ...(profile === "image" ? {
        COMFYUI_VENV_PYTHON: "/Users/kk/ComfyUI-Installs/idream-image-qwen21/ComfyUI/.venv/bin/python3",
      } : {}),
    },
  };
}

module.exports = {
  apps: [
    runner("video", "8188", 35 * 60 * 1_000),
    runner("image", "8189", 10 * 60 * 1_000),
    runner("video-h3", "8190", 35 * 60 * 1_000),
  ],
};
