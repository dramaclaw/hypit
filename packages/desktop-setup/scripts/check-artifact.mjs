import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import mediaLock from "../media-lock.json" with { type: "json" };
import uvLock from "../uv-lock.json" with { type: "json" };

const exec = promisify(execFile);

export const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const distributionPath = "runtime/node_modules/@hypit/hypit";
export const knownProfiles = ["examples/provider-package/hypit.runtime.json", "examples/semantic-composition/hypit.runtime.json"].map(path => `${distributionPath}/${path}`);
// A published dependency includes this unused browser test asset. Remove this
// exact fixture only; do not broaden the media allowlist for dependency trees.
export const knownDependencyFixtures = ["runtime/node_modules/stream-http/test/server/static/browserify.png"];
export const excludedLocalSpeechPaths = [
  `${distributionPath}/packages/provider-whisperx-local`,
  `${distributionPath}/services/whisperx`,
];

export function targetFor({ platform, arch }) {
  const release = mediaLock.targets[`${platform}-${arch}`];
  if (!release) throw new Error(`Unsupported desktop target: ${platform}/${arch}`);
  return { platform, arch, name: release.name, version: release.version, executable: platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    uv: { name: uvLock.name, version: uvLock.version, executable: platform === "win32" ? "uv.exe" : "uv" },
    probe: { name: release.name, version: release.version, executable: platform === "win32" ? "ffprobe.exe" : "ffprobe" } };
}

export function checkUvBinary(bytes, target) {
  checkExecutable(bytes, target);
}

export async function readUvLock(sourceRoot = checkoutRoot) {
  const bytes = await readFile(join(sourceRoot, "packages/desktop-setup/uv-lock.json"));
  const lock = JSON.parse(bytes);
  assert.equal(lock.schemaVersion, 1, "Unsupported uv lock");
  for (const field of ["name", "version", "license"]) assert.equal(lock[field], uvLock[field], `uv ${field} must match pinned release`);
  assert.deepEqual(Object.keys(lock.targets).sort(), Object.keys(uvLock.targets).sort(), "Unexpected uv targets");
  for (const [key, expected] of Object.entries(uvLock.targets)) {
    const item = lock.targets[key];
    assert.equal(item.url, expected.url, "uv must use pinned official release URL");
    assertSafePath(item.entry);
    assert.equal(item.entry, expected.entry, "Unexpected locked uv archive member");
    assert.deepEqual(item.members, expected.members, "Unexpected uv archive inventory");
    assert.ok(/^[a-f0-9]{64}$/.test(item.archiveSha256) && /^[a-f0-9]{64}$/.test(item.sha256)
      && Number.isSafeInteger(item.bytes) && item.bytes > 0, "Invalid uv lock integrity");
  }
  return { lock, digest: digest(bytes) };
}

export function checkMediaBinary(bytes, target, tool) {
  checkExecutable(bytes, target);
  assert.ok(!bytes.includes(Buffer.from("--enable-nonfree")), `${tool}: nonfree builds cannot be redistributed`);
  if (tool === "ffmpeg") assert.ok(bytes.includes(Buffer.from("fps_mode\0")), "FFmpeg lacks required fps_mode option");
}

export async function readMediaLock(sourceRoot = checkoutRoot) {
  const bytes = await readFile(join(sourceRoot, "packages/desktop-setup/media-lock.json"));
  const lock = JSON.parse(bytes);
  assert.equal(lock.schemaVersion, 1, "Unsupported media lock");
  for (const [key, expected] of Object.entries(mediaLock.targets)) {
    const target = lock.targets[key];
    assert.equal(target?.name, expected.name, "Media must match pinned target name");
    assert.equal(target?.version, expected.version, "Media must match pinned target version");
    assert.equal(target?.license, expected.license, "Media license mismatch");
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const item = target[tool];
      assert.ok(/^https:\/\//.test(item.url) && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isSafeInteger(item.bytes) && item.bytes > 0, "Invalid media lock integrity");
      if (item.entry) {
        assertSafePath(item.entry);
        assert.equal(item.entry.split("/").at(-1), `${tool}${key.startsWith("win32-") ? ".exe" : ""}`, "Invalid media archive member");
        assert.ok(/^[a-f0-9]{64}$/.test(item.archiveSha256), "Invalid media archive lock");
      }
    }
  }
  return { lock, digest: digest(bytes) };
}

export function checkExecutable(bytes, options) {
  const target = targetFor(options);
  if (target.platform === "darwin") {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(12) !== 2) throw new Error("Expected a Mach-O 64-bit executable");
    if (bytes.readUInt32LE(4) !== 0x0100000c) throw new Error("Wrong Mach-O architecture: expected arm64");
  } else {
    if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Expected a PE executable");
    const offset = bytes.readUInt32LE(0x3c);
    if (offset < 64 || offset + 26 > bytes.length || bytes.toString("ascii", offset, offset + 4) !== "PE\0\0") throw new Error("Invalid PE executable header");
    if (bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b) throw new Error("Wrong PE architecture: expected x64 PE32+");
  }
}

export function assertSafePath(path) {
  const parts = path.split("/");
  if (!path || path.includes("\\") || isAbsolute(path) || parts.some(part => !part || part === "." || part === ".." || part.includes(":"))) throw new Error(`Invalid resource path: ${path}`);
  const name = parts.at(-1).toLowerCase();
  // These are the preview families included by the root Distribution's files
  // list. Media anywhere else (including Skill and external dependencies) fails.
  const previewImage = path.startsWith(`${distributionPath}/`)
    && /^(?:packages\/[^/]+|examples\/minimal-author-package\/packages\/[^/]+)\/preview\/.+\.(?:png|jpe?g|webp|gif)$/i.test(path.slice(distributionPath.length + 1));
  if (parts.some(part => /^(?:\.env(?:\..*)?|\.hypit|\.ssh|\.aws|profiles?|outputs?|renders?|secrets?|credentials?)$/i.test(part))
    || /^(?:hypit\.runtime(?:\.[^.]+)?\.json|desktop-newapi\.json|\.npmrc|\.netrc)$/i.test(name)
    || /^(?:api[-_]?key|access[-_]?key|token|password|secret|credentials?)\.(?:txt|text)$/i.test(name)
    || /(?:credential|service[-_]?account|secret|token|profile).*\.(?:json|ya?ml|toml|ini)$/i.test(name)
    || /\.(?:key|pem|p12|pfx|mp4|mov|mkv|webm|avi|mp3|wav|m4a|flac|ogg|aac)$/i.test(name)
    || (!previewImage && /\.(?:png|jpe?g|webp|gif)$/i.test(name))) {
    throw new Error(`Forbidden resource path: ${path}`);
  }
}

function assertAllowedPath(path, target, directory = false) {
  assertSafePath(path);
  const allowed = path === "resource-manifest.json"
    || path.startsWith("runtime/node_modules/")
    || path.startsWith("skill/hypit/")
    || path === `bin/${target.executable}`
    || path === `bin/${target.probe.executable}`
    || /^licenses\/(?:COPYING|SOURCES\.md|VERSIONS\.txt)$/.test(path)
    || (directory && ["runtime", "runtime/node_modules", "skill", "skill/hypit", "bin", "licenses"].includes(path));
  if (!allowed) throw new Error(`Resource outside allowlist: ${path}`);
}

export function digest(bytes) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export async function readRuntimeLock(sourceRoot = checkoutRoot) {
  const directory = join(sourceRoot, "packages/desktop-setup/runtime-lock");
  const packageBytes = await readFile(join(directory, "package.json"));
  const lockBytes = await readFile(join(directory, "package-lock.json"));
  const input = JSON.parse(packageBytes);
  const lock = JSON.parse(lockBytes);
  assert.equal(lock.lockfileVersion, 3, "Runtime lock must use npm lockfile version 3");
  assert.deepEqual(lock.packages?.[""]?.dependencies ?? {}, input.dependencies ?? {}, "Runtime lock dependencies differ from its package input");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.ok(path.startsWith("node_modules/") && !entry.link && !entry.dev, `Invalid runtime lock entry: ${path}`);
    assert.ok(/^https?:\/\//.test(entry.resolved) && /^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity), `Runtime lock requires a registry URL and SHA-512 integrity: ${path}`);
  }
  return { input, packageBytes, lockBytes, digests: { packageJson: digest(packageBytes), packageLock: digest(lockBytes) } };
}

// npm creates relative .bin symlinks on Unix. Only links to regular files inside
// this staged node_modules tree are permitted; Skill/source links are never copied.
export async function inventory(root, { target, allowBinLinks = false } = {}) {
  if (!(await lstat(root)).isDirectory()) throw new Error(`Resource root must be a directory, not a symlink: ${root}`);
  const files = {};
  async function walk(directory, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const info = await lstat(absolute);
      if (target) assertAllowedPath(path, target, info.isDirectory());
      else assertSafePath(path);
      if (info.isDirectory()) { await walk(absolute, path); continue; }
      if (info.isSymbolicLink()) {
        if (!allowBinLinks || !/^runtime\/node_modules\/(?:.*\/)?\.bin\/[^/]+$/.test(path)) throw new Error(`Forbidden symlink: ${path}`);
        const link = await readlink(absolute);
        const destination = await realpath(absolute);
        const modules = await realpath(join(root, "runtime/node_modules")) + sep;
        if (isAbsolute(link) || !destination.startsWith(modules) || !(await lstat(destination)).isFile()) throw new Error(`Unsafe symlink: ${path}`);
        files[path] = { ...digest(Buffer.from(link)), link };
      } else if (info.isFile()) {
        if (path !== "resource-manifest.json") files[path] = digest(await readFile(absolute));
      } else throw new Error(`Unsupported resource file: ${path}`);
    }
  }
  await walk(root);
  return files;
}

export function resourceDigests(files) {
  return Object.fromEntries(["runtime", "skill", "bin", "licenses"].map(resource => {
    const entries = Object.entries(files).filter(([path]) => path.startsWith(`${resource}/`)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return [resource, { sha256: digest(Buffer.from(JSON.stringify(entries))).sha256, bytes: entries.reduce((sum, [, file]) => sum + file.bytes, 0) }];
  }));
}

export async function checkSkill(root, sourceRoot = checkoutRoot) {
  const expected = await inventory(join(sourceRoot, "skills/hypit"));
  if (!expected["SKILL.md"] || !expected["agents/openai.yaml"] || !Object.keys(expected).some(path => path.startsWith("references/"))) throw new Error("Incomplete source Skill");
  assert.deepEqual(await inventory(join(root, "skill/hypit")), expected, "Skill is incomplete or differs from checkout");
}

export async function checkArtifact({ out, platform, arch, checkoutRoot: sourceRoot = checkoutRoot, executeUv = exec }) {
  const target = targetFor({ platform, arch });
  const root = resolve(out);
  if (!(await lstat(root)).isDirectory() || (await lstat(join(root, "resource-manifest.json"))).isSymbolicLink()) throw new Error("Artifact and manifest must be regular resources");
  const manifest = JSON.parse(await readFile(join(root, "resource-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Unsupported resource manifest");
  assert.equal(manifest.platform, platform, "Manifest platform mismatch");
  assert.equal(manifest.arch, arch, "Manifest architecture mismatch");
  assert.deepEqual(manifest.ffmpeg, { name: target.name, version: target.version });
  assert.deepEqual(manifest.ffprobe, { name: target.probe.name, version: target.probe.version });
  assert.ok(Array.isArray(manifest.strippedProfiles) && manifest.strippedProfiles.every(path => knownProfiles.includes(path)), "Unexpected stripped profiles");
  assert.ok(Array.isArray(manifest.strippedDependencyFixtures) && manifest.strippedDependencyFixtures.every(path => knownDependencyFixtures.includes(path)), "Unexpected stripped dependency fixtures");
  const runtimeLock = await readRuntimeLock(sourceRoot);
  assert.deepEqual(manifest.runtimeLock, runtimeLock.digests, "Runtime lock digest mismatch");
  const media = await readMediaLock(sourceRoot);
  assert.deepEqual(manifest.mediaLock, media.digest, "Media lock digest mismatch");
  assert.equal(manifest.uv, undefined, "Local Python runtime must not be bundled");
  assert.equal(manifest.uvLock, undefined, "Local Python runtime must not be bundled");
  assert.deepEqual(manifest.excludedLocalSpeechPaths, excludedLocalSpeechPaths, "Local speech exclusion list mismatch");
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.hypit.tarball.sha256) && Number.isSafeInteger(manifest.hypit.tarball.bytes) && manifest.hypit.tarball.bytes > 0, "Invalid tarball digest");
  for (const path of Object.keys(manifest.files)) assertAllowedPath(path, target);
  const files = await inventory(root, { target, allowBinLinks: true });
  for (const path of excludedLocalSpeechPaths) assert.ok(!Object.keys(files).some(file => file.startsWith(`${path}/`)), `Local speech resource remains: ${path}`);
  assert.ok(Object.keys(files).some(file => file.startsWith(`${distributionPath}/packages/whisperx/`)), "WhisperX capability contract is missing");
  assert.deepEqual(files, manifest.files, "Resource digest, size or inventory mismatch");
  assert.deepEqual(resourceDigests(files), manifest.resources, "Top-level resource digest mismatch");
  const installed = JSON.parse(await readFile(join(root, distributionPath, "package.json"), "utf8"));
  assert.equal(installed.name, "@hypit/hypit", "Unexpected Distribution package");
  assert.equal(manifest.hypit.name, installed.name);
  assert.equal(manifest.hypit.version, installed.version, "Distribution version mismatch");
  assert.deepEqual(installed.dependencies ?? {}, runtimeLock.input.dependencies ?? {}, "Distribution dependencies differ from runtime lock");
  assert.ok(files[`${distributionPath}/bin/hypit.mjs`], "Distribution launcher is missing");
  await checkSkill(root, sourceRoot);
  const binary = join(root, "bin", target.executable);
  checkMediaBinary(await readFile(binary), target, "ffmpeg");
  const locked = media.lock.targets[`${platform}-${arch}`];
  assert.deepEqual(files[`bin/${target.executable}`], { sha256: locked.ffmpeg.sha256, bytes: locked.ffmpeg.bytes }, "FFmpeg differs from locked binary");
  if (platform === "darwin") assert.ok((await lstat(binary)).mode & 0o111, "FFmpeg is not executable");
  const probe = join(root, "bin", target.probe.executable);
  checkMediaBinary(await readFile(probe), target, "ffprobe");
  assert.deepEqual(files[`bin/${target.probe.executable}`], { sha256: locked.ffprobe.sha256, bytes: locked.ffprobe.bytes }, "FFprobe differs from locked binary");
  const notices = await inventory(join(sourceRoot, "packages/desktop-setup/media-licenses", `${platform}-${arch}`));
  assert.ok(notices.COPYING && notices["SOURCES.md"] && notices["VERSIONS.txt"], "Media license and source notices required");
  assert.deepEqual(await inventory(join(root, "licenses")), notices, "Media license notices differ from checkout");
  if (platform === "darwin") assert.ok((await lstat(probe)).mode & 0o111, "FFprobe is not executable");
  return manifest;
}

export function cliOptions(prepare = false) {
  const { values } = parseArgs({ options: { platform: { type: "string" }, arch: { type: "string" }, out: { type: "string" }, ...(prepare ? { "hypit-tgz": { type: "string" } } : {}) } });
  if (!values.platform || !values.arch || !values.out || (prepare && !values["hypit-tgz"])) throw new Error("Required: --platform <darwin|win32> --arch <arm64|x64> --out <dir>" + (prepare ? " --hypit-tgz <path>" : ""));
  return { platform: values.platform, arch: values.arch, out: values.out, ...(prepare ? { hypitTgz: values["hypit-tgz"] } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkArtifact(cliOptions()); console.log("Desktop resources verified."); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
