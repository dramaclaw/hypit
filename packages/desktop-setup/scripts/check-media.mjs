import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { checkMediaBinary, targetFor } from "./check-artifact.mjs";

const exec = promisify(execFile);

// Cross-target inspection proves option/configuration presence and architecture;
// only a native target can prove codec execution. Run native checks on release CI.
export async function checkMediaRuntime(root, options) {
  const target = targetFor(options);
  const ffmpeg = join(root, "bin", target.executable);
  const ffprobe = join(root, "bin", target.probe.executable);
  checkMediaBinary(await readFile(ffmpeg), target, "ffmpeg");
  checkMediaBinary(await readFile(ffprobe), target, "ffprobe");
  if (process.platform !== target.platform || process.arch !== target.arch) return { mode: "static", platform: target.platform };
  const temporary = await mkdtemp(join(tmpdir(), "hypit-media-smoke-"));
  try {
    const output = join(temporary, "smoke.mp4");
    await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2", "-frames:v", "2", "-fps_mode", "cfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", output], { timeout: 30_000 });
    const result = await exec(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,nb_frames", "-of", "json", output], { timeout: 30_000 });
    const stream = JSON.parse(result.stdout).streams?.[0];
    assert.equal(stream?.codec_name, "h264");
    assert.equal(stream?.nb_frames, "2");
    return { mode: "native", platform: target.platform };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
