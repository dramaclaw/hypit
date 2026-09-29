import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, readdir, rename, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { checkout, distributionPath, executable, fixture, loadScript, manifest, put } from "./resource-fixtures.js";

for (const [platform, arch, filename] of [["darwin", "arm64", "ffmpeg"], ["win32", "x64", "ffmpeg.exe"]] as const) {
  test(`stages ${platform}/${arch} Distribution, full Skill and pinned target FFmpeg`, async (t) => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    const { prepareResources } = await loadScript("prepare-resources.mjs");
    await prepareResources({ ...f, platform, arch });
    const m = await manifest(f.out);
    assert.equal(m.platform, platform); assert.equal(m.arch, arch);
    assert.equal(m.hypit.name, "@hypit/hypit"); assert.equal(m.hypit.version, "7.8.9");
    assert.equal(JSON.parse(await readFile(join(f.out, distributionPath, "package.json"), "utf8")).version, "7.8.9");
    assert.deepEqual(await readdir(join(f.out, "bin")), [filename]);
    assert.deepEqual(await readFile(join(f.out, "bin", filename)), executable(platform));
    if (platform === "darwin") assert.ok((await stat(join(f.out, "bin", filename))).mode & 0o111);
    assert.equal(await readFile(join(f.out, "skill/hypit/references/nested/example.svml"), "utf8"), "<Video />");
    for (const path of [`bin/${filename}`, "skill/hypit/SKILL.md", `${distributionPath}/bin/hypit.mjs`]) {
      const contents = await readFile(join(f.out, path));
      assert.equal(m.files[path].sha256, createHash("sha256").update(contents).digest("hex"));
      assert.equal(m.files[path].bytes, contents.length);
    }
    assert.deepEqual(Object.keys(m.resources).sort(), ["bin", "runtime", "skill"]);
    assert.equal(m.hypit.tarball.sha256, createHash("sha256").update(await readFile(f.hypitTgz)).digest("hex"));
    const { checkArtifact } = await loadScript("check-artifact.mjs");
    await checkArtifact({ ...f, platform, arch });
  });
}

test("strips only known example profiles and records them without changing the tarball", async (t) => {
  const profiles = ["examples/provider-package/hypit.runtime.json", "examples/semantic-composition/hypit.runtime.json"];
  const f = await fixture(Object.fromEntries(profiles.map(path => [path, "{}\n"]))); t.after(() => rm(f.root, { recursive: true, force: true }));
  const before = await readFile(f.hypitTgz);
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await prepareResources({ ...f, platform: "darwin", arch: "arm64" });
  assert.deepEqual((await manifest(f.out)).strippedProfiles, profiles.map(path => `${distributionPath}/${path}`));
  for (const path of profiles) await assert.rejects(access(join(f.out, distributionPath, path)));
  assert.deepEqual(await readFile(f.hypitTgz), before);
});

for (const path of [".env", ".env.production", "hypit.runtime.json", "examples/provider-package/nested/hypit.runtime.json", "secrets/credentials.json", "keys/service-account.json", "private.pem", "output/final.mp4", "movie.webm"]) {
  test(`refuses Distribution containing ${path}`, async (t) => {
    const f = await fixture({ [path]: "do not ship" }); t.after(() => rm(f.root, { recursive: true, force: true }));
    const { prepareResources } = await loadScript("prepare-resources.mjs");
    await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /forbidden|denied/i);
    await assert.rejects(access(f.out), "a failed stage must not be published");
  });
}

test("rejects an unsupported target before creating output", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "x64" }), /unsupported/i);
});
test("does not replace an existing output directory", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await put(f.out, "keep.txt", "owned by user");
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /exist/i);
  assert.equal(await readFile(join(f.out, "keep.txt"), "utf8"), "owned by user");
});
test("refuses a mismatched FFmpeg package version", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await put(f.source, "packages/desktop-setup/node_modules/@ffmpeg-installer/darwin-arm64/package.json", JSON.stringify({ name: "@ffmpeg-installer/darwin-arm64", version: "99.0.0", os: ["darwin"], cpu: ["arm64"] }));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /pinned|version/i);
});
test("refuses Skill symlinks that could import host state", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await symlink(f.hypitTgz, join(f.source, "skills/hypit/references/outside"));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /symlink/i);
});

test("refuses a source Skill root symlink", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rename(join(f.source, "skills/hypit"), join(f.root, "external-skill"));
  await symlink(join(f.root, "external-skill"), join(f.source, "skills/hypit"));
  const { inventory } = await loadScript("check-artifact.mjs");
  await assert.rejects(inventory(join(f.source, "skills/hypit")), /symlink|directory/i);
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /symlink|directory/i);
});

test("identical resource inputs produce identical manifests in different output directories", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await prepareResources({ ...f, platform: "darwin", arch: "arm64" });
  const second = join(f.root, "second");
  await prepareResources({ ...f, out: second, platform: "darwin", arch: "arm64" });
  assert.equal(await readFile(join(f.out, "resource-manifest.json"), "utf8"), await readFile(join(second, "resource-manifest.json"), "utf8"));
});

test("Distribution --json-path emits only a JSON path and preserves normal pack output", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await put(f.source, "scripts/pack-distribution.mjs", await readFile(join(checkout, "scripts/pack-distribution.mjs")));
  await put(f.source, "README.md", "# Hypit\n## Examples\nexamples\n## Use the Hypit skill\nskill\n");
  await put(f.source, "package.json", JSON.stringify({ name: "@hypit/hypit", version: "7.8.9" }));
  const npmCli = join(f.root, "npm-cli.js");
  // Stub the external npm process, keeping all pack-script file operations real.
  await put(f.root, "npm-cli.js", `const fs = require('node:fs'); const path = require('node:path');
    const args = process.argv.slice(2);
    if (args[0] === 'run') console.log('Building declarations');
    else if (args.includes('--dry-run')) console.log(JSON.stringify([{ files: [{ path: 'package.json' }, { path: 'README.md' }] }]));
    else { const filename = 'hypit-hypit-7.8.9.tgz'; fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], filename), 'packed'); console.log(JSON.stringify([{ filename }])); }
  `);
  const script = join(f.source, "scripts/pack-distribution.mjs");
  const options = { encoding: "utf8" as const, env: { ...process.env, npm_execpath: npmCli }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  const output = execFileSync(process.execPath, [script, "--json-path"], options);
  const tarball = JSON.parse(output);
  assert.equal(tarball, join(f.source, "dist/release/hypit-hypit-7.8.9.tgz"));
  assert.equal(await readFile(tarball, "utf8"), "packed");
  const normal = execFileSync(process.execPath, [script], options);
  assert.match(normal, /Building declarations/);
  assert.match(normal, /"filename":"hypit-hypit-7.8.9.tgz"/);
});
