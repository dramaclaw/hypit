import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { checkout, executable, loadScript } from "./resource-fixtures.js";

test("media gate rejects legacy FFmpeg and nonredistributable builds", async () => {
  const { checkMediaBinary } = await loadScript("check-artifact.mjs");
  const target = { platform: "darwin", arch: "arm64" };
  const binary = (flags: string) => Buffer.concat([executable("darwin").subarray(0, 200), Buffer.from(flags)]);
  assert.throws(() => checkMediaBinary(binary("--enable-gpl\0"), target, "ffmpeg"), /fps_mode/);
  assert.throws(() => checkMediaBinary(binary("fps_mode\0--enable-nonfree\0"), target, "ffmpeg"), /nonfree/);
  assert.doesNotThrow(() => checkMediaBinary(binary("fps_mode\0--enable-gpl\0"), target, "ffmpeg"));
});

// Run against the actual staging tree during release validation. Cross-target
// binaries are inspected without executing Windows programs on a macOS host.
for (const [platform, arch, directory] of [["darwin", "arm64", "mac-arm64"], ["win32", "x64", "win-x64"]] as const) {
  test(`staged ${platform}/${arch} FFmpeg supports fps_mode cfr`, { skip: !process.env.HYPIT_TEST_STAGED_MEDIA }, async () => {
    const root = join(checkout, "packages/desktop-setup/resources", directory, "bin");
    const path = join(root, platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    const bytes = await readFile(path);
    if (process.platform === platform && process.arch === arch) {
      execFileSync(path, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2", "-frames:v", "2", "-fps_mode", "cfr", "-f", "null", "-"], { timeout: 30_000 });
    }
    assert.ok(bytes.includes(Buffer.from("fps_mode\0")), "FFmpeg must expose the fps_mode option");
    assert.ok(!bytes.includes(Buffer.from("--enable-nonfree")), "FFmpeg must be redistributable");
    const { checkMediaRuntime } = await loadScript("check-media.mjs");
    const result = await checkMediaRuntime(join(root, ".."), { platform, arch });
    assert.equal(result.mode, process.platform === platform && process.arch === arch ? "native" : "static");
  });
}
