import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extract, list } from "tar";
import { assertSafePath, checkArtifact, checkExecutable, checkoutRoot, cliOptions, digest, distributionPath, inventory, knownDependencyFixtures, knownProfiles, readRuntimeLock, resourceDigests, targetFor } from "./check-artifact.mjs";

const exec = promisify(execFile);

function validateTarball(bytes, platform) {
  const seen = new Set();
  const normalizedPrefixes = new Map();
  // macOS volumes can also equate canonically composed and decomposed names.
  const normalizeComponent = platform === "darwin"
    ? component => component.normalize("NFD").toLowerCase().normalize("NFD")
    : component => component.toLowerCase();
  // Preflight the complete immutable archive before extracting any entry.
  list({ sync: true, strict: true, onReadEntry(entry) {
    if (!["File", "Directory"].includes(entry.type)) throw new Error(`Forbidden tarball entry type ${entry.type}: ${entry.path}`);
    const path = entry.type === "Directory" ? entry.path.replace(/\/$/, "") : entry.path;
    if (path !== "package" && !path.startsWith("package/")) throw new Error(`Invalid tarball package path: ${path}`);
    const relative = path.slice("package/".length);
    if (relative) {
      const resourcePath = `${distributionPath}/${relative}`;
      if (!knownProfiles.includes(resourcePath)) assertSafePath(resourcePath);
      if (relative.split("/").some(part => normalizeComponent(part) === "node_modules")) throw new Error(`Forbidden bundled tarball dependency: ${path}`);
    } else if (entry.type !== "Directory") throw new Error("Invalid tarball package root");
    if (seen.has(path)) throw new Error(`Duplicate tarball path: ${path}`);
    seen.add(path);
    // Track prefixes too: Foo/a and foo/b merge into one directory on the target.
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const normalized = parts.slice(0, index).map(normalizeComponent).join("/");
      const previous = normalizedPrefixes.get(normalized);
      if (previous && previous !== prefix) throw new Error(`Colliding tarball paths: ${previous} and ${prefix}`);
      normalizedPrefixes.set(normalized, prefix);
    }
  } }).end(bytes);
  assert.ok(seen.has("package/package.json"), "Tarball package.json is missing");
}

async function stripKnownFiles(stage, paths) {
  const stripped = [];
  for (const path of paths) {
    const fullPath = join(stage, path);
    const info = await lstat(fullPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info) {
      if (!info.isFile()) throw new Error(`Forbidden non-file resource: ${path}`);
      await rm(fullPath);
      stripped.push(path);
    }
  }
  return stripped;
}
async function npmCliPath() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "npm")].filter(Boolean);
  for (const candidate of candidates) {
    const path = await realpath(candidate).catch(() => "");
    if (path.endsWith("npm-cli.js")) return path;
  }
  throw new Error("npm CLI not found; run through npm or install npm alongside Node.js");
}

export async function prepareResources({ platform, arch, hypitTgz, out, checkoutRoot: sourceRoot = checkoutRoot }) {
  const target = targetFor({ platform, arch });
  const output = resolve(out);
  if (await lstat(output).catch(error => { if (error.code === "ENOENT") return null; throw error; })) throw new Error(`Output already exists: ${output}`);
  const tarball = await readFile(resolve(hypitTgz));
  const tarballDigest = digest(tarball);
  validateTarball(tarball, platform);
  const runtimeLock = await readRuntimeLock(sourceRoot);
  const ffmpegRoot = join(sourceRoot, "packages/desktop-setup/node_modules", target.name);
  const ffmpeg = JSON.parse(await readFile(join(ffmpegRoot, "package.json"), "utf8"));
  if (ffmpeg.name !== target.name || ffmpeg.version !== target.version || !ffmpeg.os?.includes(platform) || !ffmpeg.cpu?.includes(arch)) throw new Error(`FFmpeg must match pinned target package ${target.name}@${target.version}`);
  const executable = join(ffmpegRoot, target.executable);
  checkExecutable(await readFile(executable), target);
  // Validate the entire source Skill before copying anything, including links.
  await inventory(join(sourceRoot, "skills/hypit"));
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), ".hypit-resources-"));
  try {
    const unpacked = join(stage, ".distribution");
    await mkdir(unpacked);
    // node-tar retains its path protections; the preflight rejects all links and
    // special files, and the private staging directory has no existing entries.
    extract({ cwd: unpacked, strip: 1, sync: true, strict: true }).end(tarball);
    const packed = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8"));
    assert.equal(packed.name, "@hypit/hypit", "Unexpected Distribution package");
    assert.deepEqual(packed.dependencies ?? {}, runtimeLock.input.dependencies ?? {}, "Distribution dependencies differ from runtime lock");
    for (const field of ["optionalDependencies", "peerDependencies"]) {
      assert.equal(Object.keys(packed[field] ?? {}).length, 0, `Distribution ${field} must be represented in the runtime lock before staging`);
    }
    const runtime = join(stage, "runtime");
    await mkdir(runtime);
    await writeFile(join(runtime, "package.json"), runtimeLock.packageBytes);
    await writeFile(join(runtime, "package-lock.json"), runtimeLock.lockBytes);
    // npm ci consumes only the committed resolution and checks each integrity.
    // Include optional packages and select the target OS/CPU rather than host.
    await exec(process.execPath, [await npmCliPath(), "ci", "--prefix", runtime, "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund", `--os=${platform}`, `--cpu=${arch}`], { cwd: runtime, maxBuffer: 8 * 1024 * 1024 });
    await rm(join(runtime, "package.json"));
    await rm(join(runtime, "package-lock.json"));
    await mkdir(dirname(join(stage, distributionPath)), { recursive: true });
    await rename(unpacked, join(stage, distributionPath));
    const strippedProfiles = await stripKnownFiles(stage, knownProfiles);
    const strippedDependencyFixtures = await stripKnownFiles(stage, knownDependencyFixtures);
    await mkdir(join(stage, "skill"));
    await cp(join(sourceRoot, "skills/hypit"), join(stage, "skill/hypit"), { recursive: true, dereference: false });
    await mkdir(join(stage, "bin"));
    await copyFile(executable, join(stage, "bin", target.executable));
    await chmod(join(stage, "bin", target.executable), 0o755);
    const files = await inventory(stage, { target, allowBinLinks: true });
    const installed = JSON.parse(await readFile(join(stage, distributionPath, "package.json"), "utf8"));
    const manifest = { schemaVersion: 1, platform, arch, hypit: { name: installed.name, version: installed.version, tarball: tarballDigest }, ffmpeg: { name: target.name, version: target.version }, runtimeLock: runtimeLock.digests, strippedProfiles, strippedDependencyFixtures, files, resources: resourceDigests(files) };
    await writeFile(join(stage, "resource-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await checkArtifact({ out: stage, platform, arch, checkoutRoot: sourceRoot });
    await rename(stage, output);
    return manifest;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const options = cliOptions(true); await prepareResources(options); console.log(`Desktop resources staged at ${resolve(options.out)}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
