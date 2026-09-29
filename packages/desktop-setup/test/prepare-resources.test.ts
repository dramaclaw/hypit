import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { create as createTar, Header } from "tar";
import { checkout, distributionPath, executable, fixture, loadScript, manifest, put } from "./resource-fixtures.js";

async function replaceTarball(path: string, entries: { path: string; contents?: string; type?: "Directory" | "File" }[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "");
    const header = new Header({ path: entry.path, type: entry.type ?? "File", size: contents.length, mode: 0o644 });
    header.encode();
    blocks.push(header.block!, contents, Buffer.alloc((512 - contents.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  await writeFile(path, gzipSync(Buffer.concat(blocks)));
}

test("committed runtime lock mirrors Distribution dependencies and pins every registry artifact with integrity", async () => {
  const root = JSON.parse(await readFile(join(checkout, "package.json"), "utf8"));
  const directory = join(checkout, "packages/desktop-setup/runtime-lock");
  const input = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8"));
  assert.deepEqual(input.dependencies, root.dependencies);
  assert.deepEqual(lock.packages[""].dependencies, input.dependencies);
  assert.equal(lock.lockfileVersion, 3);
  assert.ok(Object.keys(lock.packages).length > 1);
  assert.equal(lock.packages["node_modules/@hypit/hypit"], undefined);
  for (const [path, entry] of Object.entries(lock.packages) as [string, any][]) {
    if (!path) continue;
    assert.match(entry.resolved, /^https:\/\//, path);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, path);
  }
});

test("fails when packed dependencies differ from the committed runtime input", async (t) => {
  const f = await fixture({ "package.json": JSON.stringify({ name: "@hypit/hypit", version: "7.8.9", dependencies: { missing: "^1.0.0" } }) });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /dependencies.*runtime lock|runtime lock.*dependencies/i);
  await assert.rejects(access(f.out));
});

test("fails when runtime package input and lock disagree", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const lockPath = "packages/desktop-setup/runtime-lock/package-lock.json";
  const lock = JSON.parse(await readFile(join(f.source, lockPath), "utf8"));
  lock.packages[""].dependencies = { changed: "^1.0.0" };
  await put(f.source, lockPath, JSON.stringify(lock));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /runtime lock/i);
});

test("rejects runtime lock entries without integrity or with local resolutions", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const lockPath = "packages/desktop-setup/runtime-lock/package-lock.json";
  const lock = JSON.parse(await readFile(join(f.source, lockPath), "utf8"));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  for (const entry of [{ version: "1.0.0", resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" }, { version: "1.0.0", resolved: "file:/tmp/pkg.tgz", integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }]) {
    lock.packages["node_modules/pkg"] = entry;
    await put(f.source, lockPath, JSON.stringify(lock));
    await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /runtime lock.*integrity/i);
  }
});

test("installs only locked tarballs without consulting drifting registry metadata", async (t) => {
  const f = await fixture({ "package.json": JSON.stringify({ name: "@hypit/hypit", version: "7.8.9", dependencies: { "locked-runtime": "^1.0.0" } }) });
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await put(f.root, "registry/package/package.json", JSON.stringify({ name: "locked-runtime", version: "1.0.0", scripts: { postinstall: "exit 99" } }));
  await createTar({ file: join(f.root, "locked.tgz"), cwd: join(f.root, "registry"), gzip: true, portable: true }, ["package"]);
  const bytes = await readFile(join(f.root, "locked.tgz"));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === "/locked-runtime-1.0.0.tgz") { response.writeHead(200, { "content-type": "application/octet-stream" }); response.end(bytes); }
    // Fresh registry metadata must never participate in the install.
    else { response.writeHead(500); response.end("Registry metadata changed"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const registry = `http://127.0.0.1:${address.port}`;
  const input = { name: "hypit-desktop-runtime", version: "1.0.0", private: true, dependencies: { "locked-runtime": "^1.0.0" } };
  await put(f.source, "packages/desktop-setup/runtime-lock/package.json", JSON.stringify(input));
  await put(f.source, "packages/desktop-setup/runtime-lock/package-lock.json", JSON.stringify({ name: input.name, version: input.version, lockfileVersion: 3, packages: {
    "": input,
    "node_modules/locked-runtime": { version: "1.0.0", resolved: `${registry}/locked-runtime-1.0.0.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` },
  } }));
  const previous = process.env.npm_config_registry;
  process.env.npm_config_registry = registry;
  t.after(() => { if (previous === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = previous; });
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  for (const out of [f.out, join(f.root, "again")]) {
    await prepareResources({ ...f, out, platform: "darwin", arch: "arm64" });
    assert.equal(JSON.parse(await readFile(join(out, "runtime/node_modules/locked-runtime/package.json"), "utf8")).version, "1.0.0");
  }
  assert.ok(requests.includes("/locked-runtime-1.0.0.tgz"));
  assert.ok(requests.every(path => path === "/locked-runtime-1.0.0.tgz"), requests.join(", "));
  assert.deepEqual(await manifest(f.out), await manifest(join(f.root, "again")));
});

test("rejects Distribution tarball symlinks before extraction", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await symlink("../../outside", join(f.root, "package/escape"));
  await createTar({ file: f.hypitTgz, cwd: f.root, gzip: true, portable: true }, ["package"]);
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /tarball.*(?:link|type)|(?:link|type).*tarball/i);
  await assert.rejects(access(f.out));
});

test("rejects traversal, absolute paths and hard links in Distribution tarballs", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  for (const entry of [
    { path: "package/../../outside", type: "File" as const },
    { path: "/tmp/outside", type: "File" as const },
    { path: "package/link", type: "Link" as const, linkpath: "../../outside" },
  ]) {
    const header = new Header({ ...entry, size: 0, mode: 0o644 }); header.encode();
    await put(f.root, "hypit.tgz", gzipSync(Buffer.concat([header.block!, Buffer.alloc(1024)])));
    await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /invalid.*path|forbidden tarball.*type/i);
    await assert.rejects(access(f.out));
  }
});

for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"]] as const) {
  test(`rejects uppercase bundled NODE_MODULES before extraction for ${platform}`, async (t) => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    await replaceTarball(f.hypitTgz, [
      { path: "package/", type: "Directory" },
      { path: "package/package.json", contents: JSON.stringify({ name: "@hypit/hypit", version: "7.8.9" }) },
      { path: "package/packages/example/NODE_MODULES/dependency.js", contents: "unsafe" },
    ]);
    const { prepareResources } = await loadScript("prepare-resources.mjs");
    await assert.rejects(prepareResources({ ...f, platform, arch }), /forbidden bundled tarball dependency/i);
    await assert.rejects(access(f.out));
  });

  test(`rejects case-colliding archive directory components before extraction for ${platform}`, async (t) => {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    await replaceTarball(f.hypitTgz, [
      { path: "package/", type: "Directory" },
      { path: "package/package.json", contents: JSON.stringify({ name: "@hypit/hypit", version: "7.8.9" }) },
      { path: "package/Package/one.txt", contents: "one" },
      { path: "package/package/two.txt", contents: "two" },
    ]);
    const { prepareResources } = await loadScript("prepare-resources.mjs");
    await assert.rejects(prepareResources({ ...f, platform, arch }), /collid|duplicate tarball path/i);
    await assert.rejects(access(f.out));
  });
}

test("rejects canonically equivalent macOS archive names before extraction", async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await replaceTarball(f.hypitTgz, [
    { path: "package/", type: "Directory" },
    { path: "package/package.json", contents: JSON.stringify({ name: "@hypit/hypit", version: "7.8.9" }) },
    { path: "package/Caf\u00e9.txt", contents: "one" },
    { path: "package/Cafe\u0301.txt", contents: "two" },
  ]);
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /colliding tarball paths/i);
  await assert.rejects(access(f.out));
});

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

for (const path of [".env", ".env.production", "hypit.runtime.json", "examples/provider-package/nested/hypit.runtime.json", "secrets/credentials.json", "keys/service-account.json", "private.pem", "output/final.mp4", "movie.webm", "generated-frame.png", "audio.aac", "secrets/api-key.txt"]) {
  test(`refuses Distribution containing ${path}`, async (t) => {
    const f = await fixture({ [path]: "do not ship" }); t.after(() => rm(f.root, { recursive: true, force: true }));
    const { prepareResources } = await loadScript("prepare-resources.mjs");
    await assert.rejects(prepareResources({ ...f, platform: "darwin", arch: "arm64" }), /forbidden|denied/i);
    await assert.rejects(access(f.out), "a failed stage must not be published");
  });
}

test("preserves packed package and example previews and credential UI source", async (t) => {
  const previews = ["packages/media-track/preview/Track.png", "examples/minimal-author-package/packages/example-component/preview/Box.png", "packages/studio/src/secret-input.ts"];
  const f = await fixture(Object.fromEntries(previews.map(path => [path, "repository content"]))); t.after(() => rm(f.root, { recursive: true, force: true }));
  const { prepareResources } = await loadScript("prepare-resources.mjs");
  await prepareResources({ ...f, platform: "darwin", arch: "arm64" });
  for (const path of previews) assert.equal(await readFile(join(f.out, distributionPath, path), "utf8"), "repository content");
});

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
