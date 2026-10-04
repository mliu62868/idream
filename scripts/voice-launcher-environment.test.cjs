const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const launchers = [
  ["fish-audio", "scripts/breeze-tts-requirements.lock"],
  ["parakeet-asr", "scripts/parakeet-asr-requirements.lock"],
  ["pocket-tts", "scripts/pocket-tts-requirements.lock"],
];

// Exercise the real executable entrypoints, including Bun's PM2 interpreter.
// A probe replaces only uv: no model, Python installation, or listener is needed
// to catch foreign interpreter paths leaking across the actual spawn boundary.
for (const executable of [process.execPath, "bun"]) for (const [name, lock] of launchers) {
  test(`${name} on ${path.basename(executable)} isolates Python paths while preserving runtime configuration`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idream-voice-environment-"));
    const probe = path.join(directory, "uv-probe.cjs");
    const preserved = {
      HOME: directory,
      HF_HOME: path.join(directory, "model-cache"),
      HTTPS_PROXY: "http://proxy.fixture.invalid:8080",
      FISH_AUDIO_MODEL_PATH: path.join(directory, "breeze-model"),
      FISH_AUDIO_API_TOKEN: "fixture-fish-token",
      FISH_AUDIO_PORT: "18062",
      PARAKEET_ASR_API_TOKEN: "fixture-asr-token",
      PARAKEET_ASR_DEVICE: "cpu",
      PARAKEET_ASR_PORT: "18064",
      POCKET_TTS_MODEL_REVISION: "fixture-pocket-revision",
      POCKET_TTS_API_TOKEN: "fixture-pocket-token",
      POCKET_TTS_PORT: "18063",
    };
    const keys = [...Object.keys(preserved), "PYTHONPATH", "PYTHONHOME", "HF_HUB_OFFLINE"];
    writeFileSync(probe, `#!/usr/bin/env node
      const keys = ${JSON.stringify(keys)};
      console.log(JSON.stringify({ args: process.argv.slice(2), environment: Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) }));
    `);
    chmodSync(probe, 0o700);
    try {
      const result = spawnSync(executable, [path.join(__dirname, `start-${name}.cjs`)], {
        cwd: path.resolve(__dirname, ".."),
        env: {
          ...process.env,
          ...preserved,
          UV_BIN: probe,
          PYTHONPATH: "/foreign/oMLX/Python3.11/site-packages",
          PYTHONHOME: "/foreign/oMLX/Python3.11",
        },
        encoding: "utf8",
        timeout: 3000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const child = JSON.parse(result.stdout.trim());
      assert.equal(child.environment.PYTHONPATH, undefined, "uv inherited foreign Python packages");
      assert.equal(child.environment.PYTHONHOME, undefined, "uv inherited a foreign Python standard library");
      for (const [key, value] of Object.entries(preserved)) assert.equal(child.environment[key], value, key);
      assert.deepEqual(child.args.slice(0, 7), ["run", "--offline", "--no-project", "--python", "3.12", "--with-requirements", lock]);
      assert.equal(child.args[7], "uvicorn");
      if (name === "parakeet-asr") assert.equal(child.environment.HF_HUB_OFFLINE, "1");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
