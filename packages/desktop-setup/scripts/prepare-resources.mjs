import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extract, list } from "tar";
import { unzipSync } from "fflate";
import { assertSafePath, checkArtifact, checkMediaBinary, checkUvBinary, checkoutRoot, cliOptions, digest, distributionPath, excludedLocalSpeechPaths, inventory, knownDependencyFixtures, knownProfiles, readMediaLock, readRuntimeLock, resourceDigests, targetFor } from "./check-artifact.mjs";

const exec = promisify(execFile);

async function cachedBinary(sourceRoot, kind, item, decode, check) {
  const cache = join(sourceRoot, "packages/desktop-setup/node_modules/.cache", `hypit-${kind.toLowerCase()}`);
  const path = join(cache, item.sha256);
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (info && !info.isFile()) throw new Error(`${kind} cache must contain regular files`);
  let bytes;
  if (info) bytes = await readFile(path);
  else {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${kind} download failed: ${response.status}`);
    const download = Buffer.from(await response.arrayBuffer());
    bytes = decode(download);
  }
  assert.deepEqual(digest(bytes), { sha256: item.sha256, bytes: item.bytes }, `${kind} binary integrity mismatch`);
  check(bytes);
  if (!info) {
    await mkdir(cache, { recursive: true });
    const temporary = await mkdtemp(join(cache, ".download-"));
    try { await writeFile(join(temporary, "binary"), bytes); await rename(join(temporary, "binary"), path); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
  return bytes;
}

async function lockedMedia(sourceRoot, release, target, tool) {
  const item = release[tool];
  return cachedBinary(sourceRoot, "Media", item, download => {
    if (!item.entry) return download;
    assert.equal(digest(download).sha256, item.archiveSha256, "Media archive integrity mismatch");
    const entries = unzipSync(download, { filter: file => file.name === item.entry });
    assert.deepEqual(Object.keys(entries), [item.entry], "Missing locked media archive member");
    return Buffer.from(entries[item.entry]);
  }, bytes => checkMediaBinary(bytes, target, tool));
}

export async function lockedUv(sourceRoot, item, target) {
  return cachedBinary(sourceRoot, "uv", item, download => {
    assert.equal(digest(download).sha256, item.archiveSha256, "uv archive integrity mismatch");
    assertSafePath(item.entry);
    const seen = [];
    const visit = path => { assertSafePath(path.replace(/\/$/, "")); seen.push(path); };
    let entries;
    if (target.platform === "win32") {
      entries = unzipSync(download, { filter: file => {
        visit(file.name);
        return file.name === item.entry;
      } });
    } else {
      entries = {};
      list({ sync: true, strict: true, onReadEntry(entry) {
        visit(entry.path);
        assert.equal(entry.type, entry.path.endsWith("/") ? "Directory" : "File", "Forbidden uv archive member type");
        if (entry.path === item.entry) {
          const chunks = [];
          entry.on("data", chunk => chunks.push(chunk));
          entry.on("end", () => { entries[entry.path] = Buffer.concat(chunks); });
        }
      } }).end(download);
    }
    // Lock the complete inventory (including sibling launchers), but retain
    // only uv in memory. No archive path is ever written to the filesystem.
    assert.deepEqual(seen.sort(), [...item.members].sort(), "Unexpected uv archive members");
    assert.deepEqual(Object.keys(entries), [item.entry], "Missing locked uv archive member");
    return Buffer.from(entries[item.entry]);
  }, bytes => checkUvBinary(bytes, target));
}

export function validateTarball(bytes, targetPlatform, hostPlatform = process.platform) {
  const seen = new Set();
  // Extraction happens on the build host, and the result must also survive the
  // target filesystem. macOS volumes can equate canonical Unicode spellings.
  const platforms = new Set([hostPlatform, targetPlatform]);
  const normalizedPrefixes = new Map([...platforms].map(platform => [platform, new Map()]));
  const normalizeComponent = (component, platform) => platform === "darwin"
    ? component.normalize("NFD").toLowerCase().normalize("NFD")
    : platform === "win32" ? component.toLowerCase() : component;
  // Preflight the complete immutable archive before extracting any entry.
  list({ sync: true, strict: true, onReadEntry(entry) {
    if (!["File", "Directory"].includes(entry.type)) throw new Error(`Forbidden tarball entry type ${entry.type}: ${entry.path}`);
    const path = entry.type === "Directory" ? entry.path.replace(/\/$/, "") : entry.path;
    if (path !== "package" && !path.startsWith("package/")) throw new Error(`Invalid tarball package path: ${path}`);
    const relative = path.slice("package/".length);
    if (relative) {
      const resourcePath = `${distributionPath}/${relative}`;
      if (!knownProfiles.includes(resourcePath)) assertSafePath(resourcePath);
      if (relative.split("/").some(part => part.toLowerCase() === "node_modules")) throw new Error(`Forbidden bundled tarball dependency: ${path}`);
    } else if (entry.type !== "Directory") throw new Error("Invalid tarball package root");
    if (seen.has(path)) throw new Error(`Duplicate tarball path: ${path}`);
    seen.add(path);
    // Track prefixes too: Foo/a and foo/b can merge into one directory.
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      for (const platform of platforms) {
        const normalized = parts.slice(0, index).map(part => normalizeComponent(part, platform)).join("/");
        const prefixes = normalizedPrefixes.get(platform);
        const previous = prefixes.get(normalized);
        if (previous && previous !== prefix) throw new Error(`Colliding tarball paths on ${platform}: ${previous} and ${prefix}`);
        prefixes.set(normalized, prefix);
      }
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
  const media = await readMediaLock(sourceRoot);
  const release = media.lock.targets[`${platform}-${arch}`];
  const executable = await lockedMedia(sourceRoot, release, target, "ffmpeg");
  const probeExecutable = await lockedMedia(sourceRoot, release, target, "ffprobe");
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
    // A macOS host otherwise creates Unix .bin links even for --os=win32.
    // NSIS dereferences them, changing the manifest and breaking relative imports.
    // Hypit's managed launcher invokes its bundled entry directly; Windows does
    // not need these host-specific npm shell commands.
    await exec(process.execPath, [await npmCliPath(), "ci", "--prefix", runtime, "--omit=dev", "--include=optional", "--ignore-scripts", "--no-audit", "--no-fund", `--os=${platform}`, `--cpu=${arch}`, ...(platform === "win32" ? ["--bin-links=false"] : [])], { cwd: runtime, maxBuffer: 8 * 1024 * 1024 });
    await rm(join(runtime, "package.json"));
    await rm(join(runtime, "package-lock.json"));
    await mkdir(dirname(join(stage, distributionPath)), { recursive: true });
    await rename(unpacked, join(stage, distributionPath));
    const strippedProfiles = await stripKnownFiles(stage, knownProfiles);
    const strippedDependencyFixtures = await stripKnownFiles(stage, knownDependencyFixtures);
    for (const path of excludedLocalSpeechPaths) {
      const absolute = join(stage, path);
      const info = await lstat(absolute).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (!info) continue;
      if (!info.isDirectory()) throw new Error(`Unexpected local speech resource: ${path}`);
      await inventory(absolute);
      await rm(absolute, { recursive: true });
    }
    await mkdir(join(stage, "skill"));
    await cp(join(sourceRoot, "skills/hypit"), join(stage, "skill/hypit"), { recursive: true, dereference: false });
    await mkdir(join(stage, "bin"));
    await writeFile(join(stage, "bin", target.executable), executable);
    await chmod(join(stage, "bin", target.executable), 0o755);
    await writeFile(join(stage, "bin", target.probe.executable), probeExecutable);
    await chmod(join(stage, "bin", target.probe.executable), 0o755);
    await cp(join(sourceRoot, "packages/desktop-setup/media-licenses", `${platform}-${arch}`), join(stage, "licenses"), { recursive: true, dereference: false });
    const files = await inventory(stage, { target, allowBinLinks: true });
    const installed = JSON.parse(await readFile(join(stage, distributionPath, "package.json"), "utf8"));
    const manifest = { schemaVersion: 1, platform, arch, hypit: { name: installed.name, version: installed.version, tarball: tarballDigest }, ffmpeg: { name: target.name, version: target.version }, ffprobe: { name: target.probe.name, version: target.probe.version }, runtimeLock: runtimeLock.digests, mediaLock: media.digest, excludedLocalSpeechPaths, strippedProfiles, strippedDependencyFixtures, files, resources: resourceDigests(files) };
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
