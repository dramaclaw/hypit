import assert from "node:assert/strict";
import { readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { distributionPath, executable, fixture, loadScript, manifest, put } from "./resource-fixtures.js";

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
