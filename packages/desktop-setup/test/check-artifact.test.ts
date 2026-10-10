import assert from "node:assert/strict";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { distributionPath, executable, fixture, loadScript, manifest, put } from "./resource-fixtures.js";

test("rejects media and credentials except explicit Distribution preview families", async () => {
  const { assertSafePath } = await loadScript("check-artifact.mjs");
  for (const filename of ["frame.png", "frame.jpg", "frame.jpeg", "frame.webp", "frame.gif", "audio.aac", "movie.mp4", "movie.mov", "movie.mkv", "movie.webm", "movie.avi", "audio.mp3", "audio.wav", "audio.m4a", "audio.flac", "audio.ogg", "secrets/api-key.txt", "credentials/data", "api-key.txt", "access-key.txt", "token.txt", "password.txt"]) {
    assert.throws(() => assertSafePath(`${distributionPath}/${filename}`), /forbidden/i, filename);
  }
  for (const path of ["skill/hypit/preview/frame.png", "runtime/node_modules/other/preview/frame.png", `${distributionPath}/examples/unapproved/preview/frame.png`, `${distributionPath}/preview/frame.png`]) {
    assert.throws(() => assertSafePath(path), /forbidden/i, path);
  }
  assertSafePath(`${distributionPath}/packages/media-track/preview/Track.png`);
  assertSafePath(`${distributionPath}/examples/minimal-author-package/packages/example-component/preview/Box.png`);
  assertSafePath(`${distributionPath}/packages/studio/src/secret-input.ts`);
});

for (const platform of ["darwin", "win32"] as const) {
  test(`validates ${platform} binary magic and architecture`, async () => {
    const { checkExecutable } = await loadScript("check-artifact.mjs");
    const target = { platform, arch: platform === "darwin" ? "arm64" : "x64" };
    checkExecutable(executable(platform), target);
    assert.throws(() => checkExecutable(Buffer.from("not an executable"), target), /Mach-O|PE|executable/i);
    assert.throws(() => checkExecutable(executable(platform, true), target), /architecture/i);
    assert.throws(() => checkExecutable(executable(platform === "darwin" ? "win32" : "darwin"), target), /Mach-O|PE|executable/i);
    if (platform === "win32") {
      const broken = executable(platform); broken.writeUInt32LE(0xfffffff0, 0x3c);
      assert.throws(() => checkExecutable(broken, target), /PE|executable/i);
    }
  });
}

test("rehashed manifests cannot bless a substituted media binary or omit licensing", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  const { checkArtifact, inventory, resourceDigests, targetFor } = await loadScript("check-artifact.mjs");
  const options = { ...f, platform: "darwin", arch: "arm64" };
  await prepareResources(options);
  const m = await manifest(f.out);
  await put(f.out, "bin/ffmpeg", Buffer.concat([executable("darwin"), Buffer.from("substitution")]));
  m.files = await inventory(f.out, { target: targetFor(options), allowBinLinks: true });
  m.resources = resourceDigests(m.files);
  await put(f.out, "resource-manifest.json", JSON.stringify(m));
  await assert.rejects(checkArtifact(options), /locked binary/);
  await put(f.out, "bin/ffmpeg", executable("darwin"));
  await rm(join(f.out, "licenses/COPYING"));
  m.files = await inventory(f.out, { target: targetFor(options), allowBinLinks: true });
  m.resources = resourceDigests(m.files);
  await put(f.out, "resource-manifest.json", JSON.stringify(m));
  await assert.rejects(checkArtifact(options), /license notices/);
});

for (const attack of ["digest", "size", "extra", "profile", "credential", "media", "missing-skill", "version", "target", "symlink", "aggregate", "manifest-path"]) {
  test(`artifact checker rejects ${attack} changes`, async (t) => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    const { prepareResources } = await loadScript("prepare-resources.mjs");
    const { checkArtifact } = await loadScript("check-artifact.mjs");
    const options = { ...f, platform: "darwin", arch: "arm64" };
    await prepareResources(options);
    const m = await manifest(f.out);
    if (attack === "digest") await put(f.out, `${distributionPath}/bin/hypit.mjs`, "tampered");
    if (attack === "size") m.files["bin/ffmpeg"].bytes++;
    if (attack === "extra") await put(f.out, "unlisted.txt", "hidden");
    if (attack === "profile") await put(f.out, `${distributionPath}/hypit.runtime.json`, "{}");
    if (attack === "credential") await put(f.out, "skill/hypit/credentials.json", "{}");
    if (attack === "media") await put(f.out, `${distributionPath}/final.mp4`, "media");
    if (attack === "missing-skill") {
      await rm(join(f.out, "skill/hypit/references/nested/example.svml"));
      delete m.files["skill/hypit/references/nested/example.svml"];
    }
    if (attack === "version") m.hypit.version = "0.0.0";
    if (attack === "target") m.arch = "x64";
    if (attack === "symlink") await symlink(f.hypitTgz, join(f.out, "skill/hypit/outside"));
    if (attack === "aggregate") m.resources.runtime.sha256 = "0".repeat(64);
    if (attack === "manifest-path") m.files["../../secret"] = m.files["bin/ffmpeg"];
    await put(f.out, "resource-manifest.json", JSON.stringify(m));
    await assert.rejects(checkArtifact(options));
    assert.ok(await readFile(join(f.out, "resource-manifest.json")), "checking must be read-only");
  });
}
