import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const distributionPath = "runtime/node_modules/@hypit/hypit";
export const knownProfiles = ["examples/provider-package/hypit.runtime.json", "examples/semantic-composition/hypit.runtime.json"].map(path => `${distributionPath}/${path}`);
// A published dependency includes this unused browser test asset. Remove this
// exact fixture only; do not broaden the media allowlist for dependency trees.
export const knownDependencyFixtures = ["runtime/node_modules/stream-http/test/server/static/browserify.png"];

export function targetFor({ platform, arch }) {
  const version = { "darwin-arm64": "4.1.5", "win32-x64": "4.1.0" }[`${platform}-${arch}`];
  if (!version) throw new Error(`Unsupported desktop target: ${platform}/${arch}`);
  return { platform, arch, name: `@ffmpeg-installer/${platform}-${arch}`, version, executable: platform === "win32" ? "ffmpeg.exe" : "ffmpeg" };
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
    || (directory && ["runtime", "runtime/node_modules", "skill", "skill/hypit", "bin"].includes(path));
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
  return Object.fromEntries(["runtime", "skill", "bin"].map(resource => {
    const entries = Object.entries(files).filter(([path]) => path.startsWith(`${resource}/`)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return [resource, { sha256: digest(Buffer.from(JSON.stringify(entries))).sha256, bytes: entries.reduce((sum, [, file]) => sum + file.bytes, 0) }];
  }));
}

export async function checkSkill(root, sourceRoot = checkoutRoot) {
  const expected = await inventory(join(sourceRoot, "skills/hypit"));
  if (!expected["SKILL.md"] || !expected["agents/openai.yaml"] || !Object.keys(expected).some(path => path.startsWith("references/"))) throw new Error("Incomplete source Skill");
  assert.deepEqual(await inventory(join(root, "skill/hypit")), expected, "Skill is incomplete or differs from checkout");
}

export async function checkArtifact({ out, platform, arch, checkoutRoot: sourceRoot = checkoutRoot }) {
  const target = targetFor({ platform, arch });
  const root = resolve(out);
  if (!(await lstat(root)).isDirectory() || (await lstat(join(root, "resource-manifest.json"))).isSymbolicLink()) throw new Error("Artifact and manifest must be regular resources");
  const manifest = JSON.parse(await readFile(join(root, "resource-manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Unsupported resource manifest");
  assert.equal(manifest.platform, platform, "Manifest platform mismatch");
  assert.equal(manifest.arch, arch, "Manifest architecture mismatch");
  assert.deepEqual(manifest.ffmpeg, { name: target.name, version: target.version });
  assert.ok(Array.isArray(manifest.strippedProfiles) && manifest.strippedProfiles.every(path => knownProfiles.includes(path)), "Unexpected stripped profiles");
  assert.ok(Array.isArray(manifest.strippedDependencyFixtures) && manifest.strippedDependencyFixtures.every(path => knownDependencyFixtures.includes(path)), "Unexpected stripped dependency fixtures");
  const runtimeLock = await readRuntimeLock(sourceRoot);
  assert.deepEqual(manifest.runtimeLock, runtimeLock.digests, "Runtime lock digest mismatch");
  assert.ok(/^[a-f0-9]{64}$/.test(manifest.hypit.tarball.sha256) && Number.isSafeInteger(manifest.hypit.tarball.bytes) && manifest.hypit.tarball.bytes > 0, "Invalid tarball digest");
  for (const path of Object.keys(manifest.files)) assertAllowedPath(path, target);
  const files = await inventory(root, { target, allowBinLinks: true });
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
  checkExecutable(await readFile(binary), target);
  if (platform === "darwin") assert.ok((await lstat(binary)).mode & 0o111, "FFmpeg is not executable");
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
